/**
 * Upload, delete, list, or bulk-import AI session files in a corpus repository.
 *
 * Ported from `scripts/upload_session.py`. Each upload/delete pulls latest from the target
 * branch, commits only the affected files, and pushes. `importSessions` bulk-extracts sessions
 * from the local Bob DB and Claude project store into `data/sessions/<user>/`, writing a clean
 * envelope + a raw copy for each, redacts secrets with `mask.ts`, then makes a single commit.
 *
 * By default `importSessions` writes only sessions not already in the store (so re-runs commit
 * just the new ones); `force` rewrites every extracted session. `dryRun` previews every step
 * without touching git or the filesystem.
 */

import { createHash } from 'crypto';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { queryBobDb } from '../BobDatabase';
import * as mask from './mask';

export const TARGET_BRANCH = 'main';

/** Envelope roles kept in the clean session file (raw artifacts preserve everything). */
const ENVELOPE_ROLES: ReadonlySet<string> = new Set(['user', 'assistant']);
const SLUG_MAX_LEN = 48;

export const VALID_SOURCES: ReadonlySet<string> = new Set([
  'bob', 'claude', 'chatgpt', 'copilot', 'other',
]);

export const EXTENSION_SOURCE_MAP: ReadonlyArray<[string, string]> = [
  ['.bob.json', 'bob'],
  ['.bob.md', 'bob'],
  ['.claude.json', 'claude'],
  ['.claude.jsonl', 'claude'],
  ['.claude.md', 'claude'],
  ['.chatgpt.json', 'chatgpt'],
  ['.copilot.json', 'copilot'],
];

/** Bob's SQLite store and Claude's project store on the local machine. */
export function bobDbPath(homedir = os.homedir()): string {
  return path.join(homedir, '.bob', 'db', 'bob.db');
}
export function claudeProjectsDir(homedir = os.homedir()): string {
  return path.join(homedir, '.claude', 'projects');
}

export type Logger = (msg: string) => void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Source inferred from a filename suffix, or null. */
export function detectSource(filename: string): string | null {
  for (const [suffix, source] of EXTENSION_SOURCE_MAP) {
    if (filename.endsWith(suffix)) { return source; }
  }
  return null;
}

/** Lower-case, replace spaces/special chars with hyphens, collapse runs. */
export function slugify(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The meaningful extension, including compound ones like `.bob.json`. */
export function fileExt(filename: string): string {
  for (const [suffix] of EXTENSION_SOURCE_MAP) {
    if (filename.endsWith(suffix)) { return suffix; }
  }
  const ext = path.extname(filename);
  return ext;
}

/**
 * A stem (`date_slug[_N]`) for which `destDir/stem+ext` does not exist.
 * With `force`, the base stem is returned even when it exists.
 */
export function collisionSafeStem(
  destDir: string, dateStr: string, slug: string, ext: string, force: boolean,
): string {
  const base = `${dateStr}_${slug}`;
  const exists = (stem: string): boolean => fs.existsSync(path.join(destDir, `${stem}${ext}`));
  if (force || !exists(base)) { return base; }
  let counter = 2;
  while (exists(`${base}_${counter}`)) { counter++; }
  return `${base}_${counter}`;
}

/** YAML metadata sidecar content. */
export function buildSidecar(
  username: string, source: string, originalName: string, storedName: string, now = new Date(),
): string {
  const uploadedAt = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return (
    `username: ${username}\n`
    + `source: ${source}\n`
    + `original_filename: ${originalName}\n`
    + `stored_filename: ${storedName}\n`
    + `uploaded_at: ${uploadedAt}\n`
  );
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run one git command in `cwd`. Never throws — the caller decides what a failure means. */
export function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise(resolve => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === 'number'
        ? (err as { code: number }).code : (err ? 1 : 0);
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

/** Context every command needs: where the corpus lives and how to talk to git. */
export interface CorpusContext {
  /** Corpus repo root; `data/sessions/` lives under it. */
  repoRoot: string;
  git?: GitRunner;
  log?: Logger;
  dryRun?: boolean;
}

interface Ctx {
  repoRoot: string;
  dataRoot: string;
  git: GitRunner;
  log: Logger;
  dryRun: boolean;
}

function ctx(c: CorpusContext): Ctx {
  return {
    repoRoot: c.repoRoot,
    dataRoot: path.join(c.repoRoot, 'data', 'sessions'),
    git: c.git ?? runGit,
    log: c.log ?? (() => { /* silent */ }),
    dryRun: c.dryRun === true,
  };
}

async function git(c: Ctx, args: string[]): Promise<void> {
  if (c.dryRun) { c.log(`[dry-run] git ${args.join(' ')}`); return; }
  const res = await c.git(args, c.repoRoot);
  if (res.code !== 0) {
    throw new UploadError(`git ${args[0]} failed\n${res.stderr.trim()}`);
  }
  if (res.stdout.trim()) { c.log(res.stdout.trim()); }
}

async function currentBranch(c: Ctx): Promise<string> {
  const res = await c.git(['rev-parse', '--abbrev-ref', 'HEAD'], c.repoRoot);
  return res.stdout.trim();
}

/** What `ensureMainAndPull` stashed/switched away from, so it can be restored. */
export interface BranchState {
  originalBranch: string;
  hadStash: boolean;
}

/**
 * Switch to the target branch and pull latest before any write. Returns the state to restore, or
 * null when nothing was switched.
 */
export async function ensureMainAndPull(c: Ctx): Promise<BranchState | null> {
  const current = await currentBranch(c);
  let switched: BranchState | null = null;

  if (current !== TARGET_BRANCH) {
    if (c.dryRun) {
      c.log(`[dry-run] git stash  (currently on '${current}')`);
      c.log(`[dry-run] git checkout ${TARGET_BRANCH}`);
      c.log(`[dry-run] git pull --rebase origin ${TARGET_BRANCH}`);
      return null;
    }
    const stash = await c.git(
      ['stash', '--include-untracked', '-m', 'upload_session: auto-stash'], c.repoRoot);
    if (stash.code !== 0) {
      throw new UploadError(`could not stash local changes\n${stash.stderr.trim()}`);
    }
    const hadStash = !stash.stdout.includes('No local changes');
    const checkout = await c.git(['checkout', TARGET_BRANCH], c.repoRoot);
    if (checkout.code !== 0) {
      throw new UploadError(`could not switch to '${TARGET_BRANCH}'\n${checkout.stderr.trim()}`);
    }
    switched = { originalBranch: current, hadStash };
  } else if (c.dryRun) {
    c.log(`[dry-run] git pull --rebase origin ${TARGET_BRANCH}`);
    return null;
  }

  const pull = await c.git(['pull', '--rebase', 'origin', TARGET_BRANCH], c.repoRoot);
  if (pull.code !== 0) {
    throw new UploadError(`git pull --rebase failed\n${pull.stderr.trim()}`);
  }
  if (pull.stdout.trim()) { c.log(pull.stdout.trim()); }
  return switched;
}

/** Switch back to the original branch and pop the stash if one was made. */
export async function restoreBranch(c: Ctx, state: BranchState | null): Promise<void> {
  if (state === null) { return; }
  await c.git(['checkout', state.originalBranch], c.repoRoot);
  if (state.hadStash) { await c.git(['stash', 'pop'], c.repoRoot); }
}

export async function defaultUsername(c: Ctx): Promise<string> {
  const res = await c.git(['config', 'user.name'], c.repoRoot);
  const name = res.stdout.trim();
  if (!name) {
    throw new UploadError('could not determine git user.name — pass an explicit user.');
  }
  return name;
}

async function resolveUsername(c: Ctx, user?: string | null): Promise<string> {
  return slugify(user ? user : await defaultUsername(c));
}

// ---------------------------------------------------------------------------
// Upload / delete / list
// ---------------------------------------------------------------------------

export interface UploadOptions extends CorpusContext {
  /** Path to the session file to upload. */
  sessionFile: string;
  user?: string | null;
  source?: string | null;
  slug?: string | null;
  force?: boolean;
  /** Skip the git add/commit/push (used when a caller batches its own commit). */
  noCommit?: boolean;
}

export interface UploadResult {
  storedPath: string;
  sidecarPath: string;
  storedName: string;
  username: string;
  source: string;
}

/**
 * Resolve a session file argument to an existing path. Accepts an absolute/relative path, or a
 * bare filename searched recursively under the corpus store.
 */
async function resolveSessionFile(c: Ctx, sessionFile: string): Promise<string> {
  const candidate = path.isAbsolute(sessionFile) ? sessionFile : path.resolve(sessionFile);
  if (fs.existsSync(candidate)) { return candidate; }

  const name = path.basename(sessionFile);
  const matches = (await mask.iterFiles(c.dataRoot)).filter(p => path.basename(p) === name);
  if (matches.length === 1) { return matches[0]; }
  if (matches.length > 1) {
    const paths = matches.map(m => path.relative(c.repoRoot, m)).join('\n  ');
    throw new UploadError(
      `'${name}' matches multiple files in the store — be more specific:\n  ${paths}`);
  }
  throw new UploadError(`file not found: ${candidate}`);
}

export async function uploadSession(opts: UploadOptions): Promise<UploadResult> {
  const c = ctx(opts);
  const src = await resolveSessionFile(c, opts.sessionFile);
  const switched = opts.noCommit ? null : await ensureMainAndPull(c);
  try {
    const username = await resolveUsername(c, opts.user);

    const source = (opts.source ?? detectSource(path.basename(src)) ?? '').toLowerCase();
    if (!source) {
      throw new UploadError(
        `could not auto-detect source from '${path.basename(src)}'. `
        + `Pass one of: ${[...VALID_SOURCES].sort().join(' | ')}.`);
    }
    if (!VALID_SOURCES.has(source)) {
      throw new UploadError(
        `unknown source '${source}'. Valid values: ${[...VALID_SOURCES].sort().join(', ')}`);
    }

    // Strip an existing YYYYMMDD_ prefix so re-uploading a stored file doesn't double the date.
    const rawStem = path.basename(src).split('.')[0].replace(/^\d{8}_/, '');
    const slug = slugify(opts.slug ? opts.slug : rawStem);
    const dateStr = localDateStamp();
    const ext = fileExt(path.basename(src));

    const destDir = path.join(c.dataRoot, username, source);
    await fs.promises.mkdir(destDir, { recursive: true });

    const stem = collisionSafeStem(destDir, dateStr, slug, ext, opts.force === true);
    const storedName = `${stem}${ext}`;
    const dest = path.join(destDir, storedName);
    const sidecar = path.join(destDir, `${stem}.meta.yaml`);

    if (fs.existsSync(dest) && opts.force !== true) {
      throw new UploadError(
        `destination already exists: ${path.relative(c.repoRoot, dest)}\nUse force to overwrite.`);
    }

    const sidecarContent = buildSidecar(username, source, path.basename(src), storedName);
    if (!c.dryRun) {
      await fs.promises.copyFile(src, dest);
      await fs.promises.writeFile(sidecar, sidecarContent, 'utf8');
      c.log(`Copied   ${path.basename(src)}`);
      c.log(`  →  ${path.relative(c.repoRoot, dest)}`);
      c.log(`  →  ${path.relative(c.repoRoot, sidecar)}`);
    } else {
      c.log(`[dry-run] would copy  ${path.basename(src)}  →  ${path.relative(c.repoRoot, dest)}`);
      c.log(`[dry-run] would write sidecar  →  ${path.relative(c.repoRoot, sidecar)}`);
    }

    if (!opts.noCommit) {
      const relDest = path.relative(c.repoRoot, dest);
      const relSidecar = path.relative(c.repoRoot, sidecar);
      await git(c, ['add', relDest, relSidecar]);
      await git(c, ['commit', '-m', `session: add ${storedName} for ${username}/${source}`]);
      await git(c, ['push', 'origin', TARGET_BRANCH]);
      c.log(`\n✓ Session uploaded to ${TARGET_BRANCH}: ${relDest}`);
    }
    return { storedPath: dest, sidecarPath: sidecar, storedName, username, source };
  } finally {
    await restoreBranch(c, switched);
  }
}

export interface DeleteOptions extends CorpusContext {
  /** Stored filename to remove. */
  sessionFile: string;
  user?: string | null;
  source?: string | null;
}

export async function deleteSession(opts: DeleteOptions): Promise<string> {
  const c = ctx(opts);
  const filename = path.basename(opts.sessionFile);
  const switched = await ensureMainAndPull(c);
  try {
    const username = await resolveUsername(c, opts.user);
    const source = (opts.source ?? detectSource(filename) ?? '').toLowerCase();
    if (!source) {
      throw new UploadError(
        `could not auto-detect source from '${filename}'. `
        + `Pass one of: ${[...VALID_SOURCES].sort().join(' | ')}.`);
    }

    const target = path.join(c.dataRoot, username, source, filename);
    if (!fs.existsSync(target)) {
      throw new UploadError(
        `session not found in store: ${path.relative(c.repoRoot, target)}`);
    }
    const relTarget = path.relative(c.repoRoot, target);

    const stem = filename.includes('.') ? filename.slice(0, filename.indexOf('.')) : filename;
    const sidecar = path.join(path.dirname(target), `${stem}.meta.yaml`);
    const relSidecar = fs.existsSync(sidecar) ? path.relative(c.repoRoot, sidecar) : null;

    const prefix = c.dryRun ? '[dry-run] would delete ' : 'Deleting  ';
    c.log(`${prefix}${relTarget}`);
    if (relSidecar) { c.log(`${prefix}${relSidecar}`); }

    const rmTargets = relSidecar ? [relTarget, relSidecar] : [relTarget];
    await git(c, ['rm', ...rmTargets]);
    await git(c, ['commit', '-m', `session: remove ${filename} for ${username}/${source}`]);
    await git(c, ['push', 'origin', TARGET_BRANCH]);
    c.log(`\n✓ Session deleted from ${TARGET_BRANCH}: ${relTarget}`);
    return relTarget;
  } finally {
    await restoreBranch(c, switched);
  }
}

export const DEFAULT_TOP_N = 5;

export interface ListedSession {
  filename: string;
  title: string;
  uploadedAt: string;
}
export interface ListResult {
  username: string;
  bySource: Record<string, { total: number; shown: ListedSession[] }>;
}

async function sessionTitle(filePath: string): Promise<string> {
  try {
    const data = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as Record<string, unknown>;
    return String(data.title ?? data.session_id ?? '');
  } catch {
    return '';
  }
}

export interface ListOptions extends CorpusContext {
  user?: string | null;
  source?: string | null;
  top?: number;
}

export async function listSessions(opts: ListOptions): Promise<ListResult> {
  const c = ctx(opts);
  const username = await resolveUsername(c, opts.user);
  const topN = opts.top ?? DEFAULT_TOP_N;
  const userDir = path.join(c.dataRoot, username);

  let sources: string[];
  if (opts.source) {
    sources = [opts.source.toLowerCase()];
  } else {
    try {
      const entries = await fs.promises.readdir(userDir, { withFileTypes: true });
      sources = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
    } catch {
      return { username, bySource: {} };
    }
  }

  const bySource: ListResult['bySource'] = {};
  for (const source of sources) {
    const sourceDir = path.join(userDir, source);
    let files: string[];
    try {
      const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });
      files = entries
        .filter(e => e.isFile() && !e.name.endsWith('.meta.yaml'))
        .map(e => e.name)
        .sort()
        .reverse(); // most recent (highest YYYYMMDD) first
    } catch {
      continue;
    }
    const shown: ListedSession[] = [];
    for (const name of files.slice(0, topN)) {
      const stem = name.includes('.') ? name.slice(0, name.indexOf('.')) : name;
      let uploadedAt = '';
      try {
        const sidecar = await fs.promises.readFile(
          path.join(sourceDir, `${stem}.meta.yaml`), 'utf8');
        for (const line of sidecar.split('\n')) {
          if (line.startsWith('uploaded_at:')) {
            uploadedAt = line.slice('uploaded_at:'.length).trim();
            break;
          }
        }
      } catch { /* no sidecar */ }
      shown.push({
        filename: name,
        title: await sessionTitle(path.join(sourceDir, name)),
        uploadedAt,
      });
    }
    bySource[source] = { total: files.length, shown };
  }
  return { username, bySource };
}

// ---------------------------------------------------------------------------
// Import — extract sessions from the native harness stores
// ---------------------------------------------------------------------------

/** Parse an epoch (ms or s) or ISO-8601 string into a Date, or null. */
export function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) { return null; }
  if (typeof value === 'number') {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string') {
    const d = new Date(value.replace(/Z$/, '+00:00'));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** ISO-8601 with a `Z` suffix and no milliseconds, or '' when unknown. */
export function iso(d: Date | null): string {
  return d ? d.toISOString().replace(/\.\d{3}Z$/, 'Z') : '';
}

/** `YYYYMMDD` (UTC) from a date, falling back to today. */
export function datePrefix(d: Date | null): string {
  return (d ?? new Date()).toISOString().slice(0, 10).replace(/-/g, '');
}

/** `YYYYMMDD` in local time — matches the original uploader's stamp for manual uploads. */
function localDateStamp(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

/** Slugify a title and truncate on a word boundary. */
export function makeSlug(title: string, maxLen = SLUG_MAX_LEN): string {
  let slug = slugify(title || 'session');
  if (slug.length > maxLen) { slug = slug.slice(0, maxLen).replace(/-+$/, ''); }
  return slug || 'session';
}

/**
 * Deterministic 8-char lowercase-hex tag derived from the full session id.
 *
 * A hash (not a prefix) is used because many Bob task ids share a long common prefix, so a
 * prefix slice would collide and overwrite distinct sessions. The hash is stable across runs,
 * which keeps the import idempotent.
 */
export function shortId(sessionId: string): string {
  return createHash('sha1').update(sessionId ?? '', 'utf8').digest('hex').slice(0, 8);
}

/** Strip Bob's `<environment_details>`/`<user_query>` wrapper down to the real prompt. */
export function cleanBobUserContent(text: string): string {
  const m = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text);
  return m ? m[1].trim() : text.trim();
}

/**
 * User turns starting with one of these are harness/IDE-injected context (not a real prompt);
 * they are kept as messages but skipped when picking a title.
 */
const INJECTED_PREFIXES = [
  '<ide_opened_file', '<ide_selection', '<system-reminder', '<command-name',
  '<command-message', '<command-args', '<local-command', '[request interrupted',
  'caveat:', '<user-prompt-submit-hook',
];

export function isInjectedContext(text: string): boolean {
  const lowered = text.replace(/^\s+/, '').toLowerCase();
  return INJECTED_PREFIXES.some(p => lowered.startsWith(p));
}

/**
 * Reduce a Claude `message.content` (string or list of blocks) to `[text, toolNames]`.
 * `tool_result` / `tool_use` blocks contribute no text.
 */
export function flattenClaudeContent(content: unknown): [string, string[]] {
  if (typeof content === 'string') { return [content.trim(), []]; }
  if (!Array.isArray(content)) { return ['', []]; }
  const texts: string[] = [];
  const tools: string[] = [];
  for (const blockRaw of content) {
    if (!blockRaw || typeof blockRaw !== 'object') { continue; }
    const block = blockRaw as Record<string, unknown>;
    if (block.type === 'text') {
      const txt = typeof block.text === 'string' ? block.text : '';
      if (txt.trim()) { texts.push(txt.trim()); }
    } else if (block.type === 'tool_use') {
      if (typeof block.name === 'string' && block.name) { tools.push(block.name); }
    }
  }
  return [texts.join('\n\n').trim(), tools];
}

export interface EnvelopeMessage {
  role: string;
  content: string;
  timestamp: string;
  model?: string;
  tools?: string[];
}

export interface SessionEnvelope {
  session_id: string;
  harness: string;
  username: string;
  created_at: string;
  title: string;
  model: string | null;
  messages: EnvelopeMessage[];
}

export interface ImportRecord {
  envelope: SessionEnvelope;
  rawBytes: Buffer;
  rawExt: string;
  envExt: string;
  source: string;
  dateStr: string;
  slug: string;
  id8: string;
  title: string;
  model: string | null;
  originalName: string;
}

interface BobTaskRow {
  id: string;
  title: string | null;
  first_message: string | null;
  created_at: number | null;
  env: string | null;
}

const BOB_IMPORT_TASKS_SQL =
  "SELECT id, title, first_message, created_at, env FROM tasks "
  + "WHERE task_type = 'normal' ORDER BY created_at ASC";
const BOB_IMPORT_MESSAGES_SQL =
  'SELECT role, data, created_at FROM messages WHERE task_id = ? ORDER BY created_at ASC';

/** Read Bob's SQLite store and return one import record per normal task. */
export async function extractBobSessions(
  username: string, dbPath = bobDbPath(), limit?: number | null,
): Promise<ImportRecord[]> {
  if (!fs.existsSync(dbPath)) { return []; }
  const tasks = await queryBobDb<BobTaskRow>(dbPath, BOB_IMPORT_TASKS_SQL);

  const records: ImportRecord[] = [];
  for (const task of tasks) {
    const rows = await queryBobDb<{ role: string; data: string; created_at: number }>(
      dbPath, BOB_IMPORT_MESSAGES_SQL, [task.id]);
    if (rows.length === 0) { continue; }

    const messages: EnvelopeMessage[] = [];
    let model: string | null = null;
    const rawRows: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(row.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      rawRows.push({ role: row.role, created_at: row.created_at, data });

      const role = String(data.role ?? row.role);
      if (!ENVELOPE_ROLES.has(role)) { continue; }
      let content = typeof data.content === 'string' ? data.content : '';
      content = role === 'user' ? cleanBobUserContent(content) : content.trim();
      const tools = Array.isArray(data.toolCalls)
        ? data.toolCalls
          .filter((tc): tc is Record<string, unknown> => !!tc && typeof tc === 'object')
          .map(tc => tc.name)
          .filter((n): n is string => typeof n === 'string' && n.length > 0)
        : [];
      if (!content && tools.length === 0) { continue; }
      const msgModel = typeof data.model === 'string' ? data.model : undefined;
      if (msgModel && role === 'assistant') { model = model ?? msgModel; }
      const meta = (data._meta ?? {}) as Record<string, unknown>;
      const ts = toDate(meta.timestamp) ?? toDate(row.created_at);
      const msg: EnvelopeMessage = { role, content, timestamp: iso(ts) };
      if (msgModel) { msg.model = msgModel; }
      if (tools.length) { msg.tools = tools; }
      messages.push(msg);
    }
    if (messages.length === 0) { continue; }

    const created = toDate(task.created_at);
    const title = (task.title || task.first_message || 'bob session').trim();
    records.push({
      envelope: {
        session_id: task.id,
        harness: 'bob',
        username,
        created_at: iso(created),
        title,
        model,
        messages,
      },
      rawBytes: Buffer.from(
        JSON.stringify({ task, messages: rawRows }, null, 2), 'utf8'),
      rawExt: '.bob.raw.json',
      envExt: '.bob.json',
      source: 'bob',
      dateStr: datePrefix(created),
      slug: makeSlug(title),
      id8: shortId(task.id),
      title,
      model,
      originalName: `${task.id}.bob.json`,
    });
    if (limit && records.length >= limit) { break; }
  }
  return records;
}

/** Top-level `<uuid>.jsonl` session files (excludes nested subagent/workflow logs). */
async function claudeSessionFiles(projectsDir: string): Promise<string[]> {
  let projects: fs.Dirent[];
  try {
    projects = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const project of projects.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!project.isDirectory()) { continue; }
    const dir = path.join(projectsDir, project.name);
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      files.push(...entries
        .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
        .map(e => path.join(dir, e.name))
        .sort());
    } catch { /* skip unreadable project dir */ }
  }
  return files;
}

/** Read top-level Claude `.jsonl` session files and return one record per session. */
export async function extractClaudeSessions(
  username: string, projectsDir = claudeProjectsDir(), limit?: number | null,
): Promise<ImportRecord[]> {
  const records: ImportRecord[] = [];
  for (const filePath of await claudeSessionFiles(projectsDir)) {
    let rawBytes: Buffer;
    try {
      rawBytes = await fs.promises.readFile(filePath);
    } catch {
      continue;
    }

    const messages: EnvelopeMessage[] = [];
    let model: string | null = null;
    let sessionId: string | null = null;
    let firstTs: Date | null = null;
    let title: string | null = null;

    for (const line of rawBytes.toString('utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (sessionId === null && typeof obj.sessionId === 'string') { sessionId = obj.sessionId; }
      if (obj.type !== 'user' && obj.type !== 'assistant') { continue; }
      if (obj.isSidechain) { continue; }
      const message = (obj.message ?? {}) as Record<string, unknown>;
      const role = typeof message.role === 'string' ? message.role : '';
      if (!ENVELOPE_ROLES.has(role)) { continue; }
      const [content, tools] = flattenClaudeContent(message.content);
      if (!content && tools.length === 0) { continue; }
      let msgModel = typeof message.model === 'string' ? message.model : undefined;
      if (msgModel === '<synthetic>') { msgModel = undefined; }
      if (msgModel && role === 'assistant') { model = model ?? msgModel; }
      const ts = toDate(obj.timestamp);
      firstTs = firstTs ?? ts;
      if (title === null && role === 'user' && content && !isInjectedContext(content)) {
        title = content.split('\n')[0].slice(0, 80).trim();
      }
      const msg: EnvelopeMessage = { role, content, timestamp: iso(ts) };
      if (msgModel) { msg.model = msgModel; }
      if (tools.length) { msg.tools = tools; }
      messages.push(msg);
    }
    if (messages.length === 0) { continue; }

    const id = sessionId ?? path.basename(filePath, '.jsonl');
    const finalTitle = title ?? 'claude session';
    records.push({
      envelope: {
        session_id: id,
        harness: 'claude',
        username,
        created_at: iso(firstTs),
        title: finalTitle,
        model,
        messages,
      },
      rawBytes,
      rawExt: '.claude.jsonl',
      envExt: '.claude.json',
      source: 'claude',
      dateStr: datePrefix(firstTs),
      slug: makeSlug(finalTitle),
      id8: shortId(id),
      title: finalTitle,
      model,
      originalName: path.basename(filePath),
    });
    if (limit && records.length >= limit) { break; }
  }
  return records;
}

/** Deterministic filename stem (`date_slug-id8`) shared by all of a record's artifacts. */
export function recordStem(record: ImportRecord): string {
  return `${record.dateStr}_${record.slug}-${record.id8}`;
}

/** Destination envelope path — the marker used to detect "already imported". */
export function recordEnvelopePath(
  dataRoot: string, record: ImportRecord, username: string,
): string {
  return path.join(
    dataRoot, username, record.source, `${recordStem(record)}${record.envExt}`);
}

/** Write envelope + sidecar + raw artifact for one record. Returns the relative paths written. */
async function writeImportRecord(
  c: Ctx, record: ImportRecord, username: string,
): Promise<string[]> {
  const stem = recordStem(record);
  const destDir = path.join(c.dataRoot, username, record.source);
  const rawDir = path.join(destDir, 'raw');

  const envelopePath = path.join(destDir, `${stem}${record.envExt}`);
  const sidecarPath = path.join(destDir, `${stem}.meta.yaml`);
  const rawPath = path.join(rawDir, `${stem}${record.rawExt}`);
  const rel = [envelopePath, sidecarPath, rawPath].map(p => path.relative(c.repoRoot, p));
  if (c.dryRun) { return rel; }

  await fs.promises.mkdir(rawDir, { recursive: true });
  await fs.promises.writeFile(
    envelopePath, `${JSON.stringify(record.envelope, null, 2)}\n`, 'utf8');
  await fs.promises.writeFile(rawPath, record.rawBytes);

  let sidecar = buildSidecar(
    username, record.source, record.originalName, path.basename(envelopePath));
  sidecar += `title: ${JSON.stringify(record.title)}\n`;
  if (record.model) { sidecar += `model: ${record.model}\n`; }
  sidecar += `raw_file: raw/${path.basename(rawPath)}\n`;
  await fs.promises.writeFile(sidecarPath, sidecar, 'utf8');
  return rel;
}

export interface ImportOptions extends CorpusContext {
  user?: string | null;
  bob?: boolean;
  claude?: boolean;
  limit?: number | null;
  force?: boolean;
  noPush?: boolean;
  noMask?: boolean;
  bobDbPath?: string;
  claudeProjectsDir?: string;
}

export interface ImportSummary {
  extracted: number;
  skipped: number;
  written: string[];
  committed: boolean;
  pushed: boolean;
  masked: { unique: number; replacements: number; filesModified: number } | null;
}

export async function importSessions(opts: ImportOptions): Promise<ImportSummary> {
  const c = ctx(opts);
  const username = await resolveUsername(c, opts.user);
  const doBob = opts.bob || !opts.claude;
  const doClaude = opts.claude || !opts.bob;

  let records: ImportRecord[] = [];
  if (doBob) {
    const bob = await extractBobSessions(
      username, opts.bobDbPath ?? bobDbPath(), opts.limit);
    c.log(`bob:    ${bob.length} session(s) extracted`);
    records = records.concat(bob);
  }
  if (doClaude) {
    const claude = await extractClaudeSessions(
      username, opts.claudeProjectsDir ?? claudeProjectsDir(), opts.limit);
    c.log(`claude: ${claude.length} session(s) extracted`);
    records = records.concat(claude);
  }

  const extracted = records.length;
  if (extracted === 0) {
    c.log('No sessions to import.');
    return { extracted: 0, skipped: 0, written: [], committed: false, pushed: false, masked: null };
  }

  // By default import only sessions not already in the store: skip any record whose envelope
  // file already exists. This keeps re-runs to just the *new* sessions instead of re-stamping
  // every existing sidecar. `force` rewrites all.
  let skipped = 0;
  if (opts.force !== true) {
    const before = records.length;
    records = records.filter(r => !fs.existsSync(recordEnvelopePath(c.dataRoot, r, username)));
    skipped = before - records.length;
    c.log(`\nskipped ${skipped} already in store; ${records.length} new to write `
      + '(use force to rewrite all)');
    if (records.length === 0) {
      c.log('No new sessions to import — everything is already in the store.');
      return {
        extracted, skipped, written: [], committed: false, pushed: false, masked: null,
      };
    }
  }

  const written: string[] = [];
  for (const record of records) {
    written.push(...await writeImportRecord(c, record, username));
  }

  if (c.dryRun) {
    c.log(`\n[dry-run] would write ${written.length} file(s) across ${records.length} session(s).`);
    for (const p of written.slice(0, 9)) { c.log(`  ${p}`); }
    if (written.length > 9) { c.log(`  … and ${written.length - 9} more`); }
    c.log(`[dry-run] masking: ${opts.noMask ? 'skipped' : 'would mask secrets before commit'}`);
    return { extracted, skipped, written, committed: false, pushed: false, masked: null };
  }

  c.log(`\nWrote ${written.length} file(s) across ${records.length} session(s).`);

  // Redact secrets in place BEFORE committing, so no unmasked credential ever enters git
  // history. Skip only when the caller explicitly opts out.
  let masked: ImportSummary['masked'] = null;
  if (opts.noMask !== true) {
    const summary = await mask.run({ repoRoot: c.repoRoot, user: username });
    masked = {
      unique: summary.unique,
      replacements: summary.replacements,
      filesModified: summary.filesModified,
    };
    c.log(`Masked ${summary.unique} unique secret(s), ${summary.replacements} occurrence(s) `
      + `across ${summary.filesModified} file(s).`);
    if (summary.reportPath) { c.log(`  →  ${path.relative(c.repoRoot, summary.reportPath)}`); }
  } else {
    c.log('Masking skipped — review for secrets before pushing.');
  }

  const userDir = path.relative(c.repoRoot, path.join(c.dataRoot, username));
  await git(c, ['add', userDir]);
  await git(c, [
    'commit', '-m',
    `session: bulk import ${records.length} sessions for ${username} (bob+claude)`,
  ]);
  if (opts.noPush === true) {
    c.log(`\n✓ Committed locally (not pushed). Review, then: git push origin ${TARGET_BRANCH}`);
    return { extracted, skipped, written, committed: true, pushed: false, masked };
  }
  await git(c, ['pull', '--rebase', 'origin', TARGET_BRANCH]);
  await git(c, ['push', 'origin', TARGET_BRANCH]);
  c.log(`\n✓ Imported ${records.length} sessions to ${TARGET_BRANCH}.`);
  return { extracted, skipped, written, committed: true, pushed: true, masked };
}
