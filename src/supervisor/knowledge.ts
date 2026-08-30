/**
 * Route and parse BDI knowledge for one running coding-agent session.
 *
 * Ported from `reckon_supervisor/knowledge.py` **and** `kb-sitter-skill/scripts/fetch_bdi_files.py`
 * (the loader those two split between them is one module here).
 *
 * Given a `(user, project, team)` triple, three tier files are read in precedence order
 * (team < project < user) from a knowledge repo:
 *
 *     data/knowledge/teams/<team>/bottom-line.md
 *     data/knowledge/projects/<project>/bottom-line.md
 *     data/knowledge/users/<user>/bottom-line.md
 *
 * A missing tier file is NOT an error — it is skipped.
 *
 * Deliberately NOT here: classification, conflict *resolution*, traffic-light decisions. All
 * entries from all three tiers are surfaced, annotated with tier + precedence (narrower first).
 * The classifier reasons about conflicts, so a team-level red-level safety belief is never
 * silently dropped just because a narrower file reuses an id.
 *
 * ## Routing without a registry
 *
 * The original resolved the triple by parsing registry tables out of a skill markdown file that
 * hard-coded concrete team/project/user slugs. That data is deployment-specific, so here the
 * registry is **optional**: with no registry the triple is taken as given (settings-driven);
 * with one, it is validated and the documented fallbacks apply.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

/** Load order, broadest → narrowest. */
export const TIER_ORDER = ['team', 'project', 'user'] as const;
export type Tier = (typeof TIER_ORDER)[number];

export const TIER_PRECEDENCE: Record<string, number> = { team: 0, project: 1, user: 2 };
export const DEFAULT_KNOWLEDGE_REF = 'main';

/** In-repo path of each tier's bottom-line file, given the resolved slugs. */
export function tierPath(tier: Tier, slugs: Record<Tier, string>): string {
  const dir = { team: 'teams', project: 'projects', user: 'users' }[tier];
  return path.posix.join('data', 'knowledge', dir, slugs[tier], 'bottom-line.md');
}

/** Raised on unresolvable routing (unknown slug, ambiguous project). Fails loud. */
export class KnowledgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeError';
  }
}

export interface TierFile {
  slug: string;
  path_in_repo: string;
  exists: boolean;
  content: string | null;
}

/** fetch(user, project, team) -> per-tier file map. Injectable so tests avoid any git/FS work. */
export type FetchFn = (
  user: string, project: string, team: string,
) => Promise<Partial<Record<Tier, TierFile>>>;

export interface KnowledgeEntry {
  kind: string; // belief | desire | intention
  title: string;
  tier: string;  // team | project | user
  text: string;
  id: string | null;
  source: string | null;
  confidence: string | null;
  scope: string | null;
  added: string | null;
  updated: string | null;
  tags: string[];
  level: string | null;
  supersedes: string | null;
  expires: string | null;
  sourceFile: string | null;
}

export function entryPrecedence(e: KnowledgeEntry): number {
  return TIER_PRECEDENCE[e.tier] ?? 0;
}

export interface KnowledgeBundle {
  user: string;
  project: string;
  team: string;
  entries: KnowledgeEntry[];
  loadedFiles: string[];
  missingFiles: string[];
}

/** Entries with the narrower tier first (user > project > team). */
export function ranked(bundle: KnowledgeBundle): KnowledgeEntry[] {
  return [...bundle.entries].sort((a, b) => entryPrecedence(b) - entryPrecedence(a));
}

// --------------------------------------------------------------------------- registry

export interface Registry {
  /** project slug -> { team, users } */
  projects: Record<string, { team: string; users: string[] }>;
  /** user slug -> { team, projects } */
  users: Record<string, { team: string; projects: string[] }>;
  teams: Set<string>;
}

export const EMPTY_REGISTRY: Registry = { projects: {}, users: {}, teams: new Set() };

/** Strip markdown link syntax, backticks, and surrounding whitespace from a table cell. */
function cleanCell(cell: string): string {
  let c = cell.trim();
  const m = /^\[`?([^`\]]+)`?\]\([^)]*\)/.exec(c);
  if (m) { c = m[1]; }
  return c.trim().replace(/^`+|`+$/g, '').trim();
}

function splitSlugs(cell: string): string[] {
  return cleanCell(cell)
    .split(/[,\s]+/)
    .map(p => p.replace(/^`+|`+$/g, '').trim())
    .filter(p => p.length > 0);
}

/**
 * Return each markdown table as a list of rows, each row a list of cell strings.
 * A table is a run of consecutive lines starting with `|`; the separator row is dropped.
 */
export function parseMarkdownTables(text: string): string[][][] {
  const tables: string[][][] = [];
  let current: string[][] = [];
  for (const line of text.split('\n')) {
    const stripped = line.trim();
    if (stripped.startsWith('|')) {
      const cells = stripped.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const isSeparator = cells.length > 0 && cells.every(c => /^[-:\s]*$/.test(c));
      if (isSeparator) { continue; }
      current.push(cells);
    } else if (current.length) {
      tables.push(current);
      current = [];
    }
  }
  if (current.length) { tables.push(current); }
  return tables;
}

/** Parse the Teams/Projects/Users registry tables out of a registry markdown file. */
export function parseRegistry(registryText: string): Registry {
  const projects: Registry['projects'] = {};
  const users: Registry['users'] = {};
  const teams = new Set<string>();

  for (const table of parseMarkdownTables(registryText)) {
    if (table.length === 0) { continue; }
    const header = table[0].map(h => h.toLowerCase());
    const rows = table.slice(1);
    if (rows.length === 0) { continue; }

    if (header.some(h => h.includes('team slug'))) {
      for (const row of rows) {
        const slug = cleanCell(row[0]);
        if (slug) { teams.add(slug); }
      }
    } else if (header.some(h => h.includes('project slug'))) {
      // columns: Project slug | File | Team | Users on this project
      for (const row of rows) {
        if (row.length < 3) { continue; }
        const slug = cleanCell(row[0]);
        const team = row.length > 2 ? cleanCell(row[2]) : '';
        const userList = row.length > 3 ? splitSlugs(row[3]) : [];
        if (slug) {
          projects[slug] = { team, users: userList };
          if (team) { teams.add(team); }
        }
      }
    } else if (header.some(h => h.includes('user slug'))) {
      // columns: User slug | File | Team | Projects
      for (const row of rows) {
        if (row.length < 3) { continue; }
        const slug = cleanCell(row[0]);
        const team = row.length > 2 ? cleanCell(row[2]) : '';
        const projList = row.length > 3 ? splitSlugs(row[3]) : [];
        if (slug) {
          users[slug] = { team, projects: projList };
          if (team) { teams.add(team); }
        }
      }
    }
  }

  return { projects, users, teams };
}

/** True when the registry carries no routing data (so validation must be skipped). */
export function isEmptyRegistry(r: Registry): boolean {
  return Object.keys(r.users).length === 0
    && Object.keys(r.projects).length === 0
    && r.teams.size === 0;
}

/**
 * Resolve `(user, project, team)`, applying the registry's fallbacks. Fails loud.
 *
 * - user required.
 * - project missing: if the user is on exactly one project, use it; else error.
 * - team missing: look it up from the user's registry row.
 * - unknown slug in any field: error (never substitute a default).
 *
 * With an EMPTY registry there is nothing to validate against and nothing to infer from, so the
 * triple is returned as given. `user` is still required; a missing project or team resolves to
 * the empty string and that tier is simply reported missing — which is the same graceful
 * degradation a missing tier file already gets. This never substitutes a *wrong* slug (the rule
 * the registry path enforces); it substitutes none.
 */
export function resolveTriple(
  registry: Registry,
  user: string | null | undefined,
  project: string | null | undefined,
  team: string | null | undefined,
): [string, string, string] {
  if (!user) { throw new KnowledgeError('user is required to route knowledge'); }

  if (isEmptyRegistry(registry)) {
    return [user, project ?? '', team ?? ''];
  }

  if (!(user in registry.users)) {
    throw new KnowledgeError(`unknown user slug: ${JSON.stringify(user)}`);
  }
  const userRow = registry.users[user];

  let resolvedProject = project ?? '';
  if (!resolvedProject) {
    const candidates = userRow.projects ?? [];
    if (candidates.length === 1) {
      resolvedProject = candidates[0];
    } else if (candidates.length === 0) {
      throw new KnowledgeError(
        `user ${JSON.stringify(user)} has no projects in the registry; project required`);
    } else {
      throw new KnowledgeError(
        `user ${JSON.stringify(user)} is on multiple projects ${JSON.stringify(candidates)}; `
        + 'resolve project before routing');
    }
  }
  if (!(resolvedProject in registry.projects)) {
    throw new KnowledgeError(`unknown project slug: ${JSON.stringify(resolvedProject)}`);
  }

  let resolvedTeam = team ?? '';
  if (!resolvedTeam) {
    resolvedTeam = userRow.team || registry.projects[resolvedProject].team || '';
    if (!resolvedTeam) {
      throw new KnowledgeError(
        `could not resolve team for user ${JSON.stringify(user)} / project ${JSON.stringify(resolvedProject)}`);
    }
  }
  if (!registry.teams.has(resolvedTeam)) {
    throw new KnowledgeError(`unknown team slug: ${JSON.stringify(resolvedTeam)}`);
  }

  return [user, resolvedProject, resolvedTeam];
}

// --------------------------------------------------------------------------- BDI parse

const HEADING_RE = /^###\s+(Belief|Desire|Intention):\s*(.+?)\s*$/i;
const TABLE_ROW_RE = /^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|\s*$/;

/** Parse BDI entries from a bottom-line.md body. */
export function parseBottomLine(
  text: string, tier: string, sourceFile: string | null = null,
): KnowledgeEntry[] {
  const entries: KnowledgeEntry[] = [];
  const lines = text.split('\n');
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const m = HEADING_RE.exec(lines[i].trim());
    if (!m) { i++; continue; }
    const kind = m[1].toLowerCase();
    const title = m[2].trim();
    i++;

    const meta: Record<string, string> = {};
    const contentLines: string[] = [];
    // Consume metadata table rows and content until the next entry heading or a section
    // boundary (`## ` / a lone `---`).
    while (i < n) {
      const stripped = lines[i].trim();
      if (HEADING_RE.test(stripped) || stripped.startsWith('## ')) { break; }
      if (stripped === '---') { i++; break; }
      const row = TABLE_ROW_RE.exec(stripped);
      if (row) {
        const key = row[1].trim().toLowerCase();
        const val = row[2].trim();
        if (key !== 'field' && key !== 'value' && !/^[-:\s]*$/.test(key)) { meta[key] = val; }
      } else if (stripped) {
        contentLines.push(lines[i]);
      }
      i++;
    }

    entries.push({
      kind,
      title,
      tier,
      text: contentLines.join('\n').trim(),
      id: meta.id ?? null,
      source: meta.source ?? null,
      confidence: meta.confidence ?? null,
      scope: meta.scope ?? null,
      added: meta.added ?? null,
      updated: meta.updated ?? null,
      tags: (meta.tags ?? '').split(',').map(t => t.trim()).filter(t => t.length > 0),
      level: meta.level ?? null,
      supersedes: meta.supersedes ?? null,
      expires: meta.expires ?? null,
      sourceFile,
    });
  }
  return entries;
}

// --------------------------------------------------------------------------- fetch

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr || String(err))); return; }
      resolve({ stdout, stderr });
    });
  });
}

/** Shallow-clone a single branch/ref of `repoUrl` into `dest`. */
export async function shallowClone(repoUrl: string, ref: string, dest: string): Promise<void> {
  await run('git', [
    'clone', '--depth', '1', '--branch', ref, '--single-branch', '--no-tags', repoUrl, dest,
  ], 120_000);
}

async function readTierFile(
  root: string, tier: Tier, slugs: Record<Tier, string>,
): Promise<TierFile> {
  // An unconfigured tier (empty slug) has no file to look for; report it missing without
  // touching the filesystem, so a partially-configured routing triple still loads what it can.
  if (!slugs[tier]) {
    return { slug: '', path_in_repo: `(${tier} tier not configured)`, exists: false, content: null };
  }
  const rel = tierPath(tier, slugs);
  const full = path.join(root, ...rel.split('/'));
  try {
    const content = await fs.promises.readFile(full, 'utf8');
    return { slug: slugs[tier], path_in_repo: rel, exists: true, content };
  } catch {
    return { slug: slugs[tier], path_in_repo: rel, exists: false, content: null };
  }
}

export interface FetchOptions {
  /** Local checkout to read directly, skipping any clone. Preferred — offline and instant. */
  localRepo?: string;
  /** Git URL to shallow-clone when no local checkout is given. */
  repo?: string;
  ref?: string;
}

/**
 * Read the three tier files, either straight from a local checkout or from a shallow clone.
 * Replaces `fetch_bdi_files.py`. A missing tier file surfaces as `exists: false`, not an error.
 */
export async function fetchBdiFiles(
  user: string, project: string, team: string, opts: FetchOptions = {},
): Promise<Record<Tier, TierFile>> {
  const slugs: Record<Tier, string> = { user, project, team };
  const out = {} as Record<Tier, TierFile>;

  const local = opts.localRepo;
  if (local) {
    const root = local.startsWith('~') ? path.join(os.homedir(), local.slice(1)) : local;
    let isDir = false;
    try { isDir = (await fs.promises.stat(root)).isDirectory(); } catch { isDir = false; }
    if (!isDir) { throw new KnowledgeError(`local knowledge repo dir not found: ${root}`); }
    for (const tier of TIER_ORDER) { out[tier] = await readTierFile(root, tier, slugs); }
    return out;
  }

  if (!opts.repo) {
    throw new KnowledgeError(
      'no knowledge source configured: set a local knowledge repo path or a git URL');
  }

  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kb-sitter-'));
  const clone = path.join(tmp, 'clone');
  try {
    try {
      await shallowClone(opts.repo, opts.ref ?? DEFAULT_KNOWLEDGE_REF, clone);
    } catch (err) {
      throw new KnowledgeError(`git clone failed: ${String(err).slice(0, 300)}`);
    }
    for (const tier of TIER_ORDER) { out[tier] = await readTierFile(clone, tier, slugs); }
    return out;
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => { /* best-effort */ });
  }
}

export interface LoadKnowledgeOptions {
  user: string | null | undefined;
  project?: string | null;
  team?: string | null;
  /** Optional registry markdown validating/completing the triple. Omit for settings-driven routing. */
  registryPath?: string;
  /** Local knowledge repo checkout (contains `data/knowledge/`). */
  localRepo?: string;
  /** Git URL, used only when no local checkout is given. */
  knowledgeRepo?: string;
  knowledgeRef?: string;
  /** Injectable fetch (tests / alternate transports). */
  fetch?: FetchFn;
}

/**
 * Resolve the triple, fetch the three bottom-line files, and parse them into entries.
 * Missing tier files are skipped, not errors.
 */
export async function loadKnowledge(opts: LoadKnowledgeOptions): Promise<KnowledgeBundle> {
  let registry = EMPTY_REGISTRY;
  if (opts.registryPath) {
    let text: string;
    try {
      text = await fs.promises.readFile(opts.registryPath, 'utf8');
    } catch {
      throw new KnowledgeError(`knowledge registry not found: ${opts.registryPath}`);
    }
    registry = parseRegistry(text);
  }

  const [rUser, rProject, rTeam] = resolveTriple(registry, opts.user, opts.project, opts.team);

  const fetcher: FetchFn = opts.fetch
    ?? ((u, p, t) => fetchBdiFiles(u, p, t, {
      localRepo: opts.localRepo, repo: opts.knowledgeRepo, ref: opts.knowledgeRef,
    }));
  const files = await fetcher(rUser, rProject, rTeam);

  const entries: KnowledgeEntry[] = [];
  const loadedFiles: string[] = [];
  const missingFiles: string[] = [];
  for (const tier of TIER_ORDER) { // team -> project -> user
    const f = files[tier];
    const rel = f?.path_in_repo ?? tier;
    if (f?.exists && f.content) {
      entries.push(...parseBottomLine(f.content, tier, rel));
      loadedFiles.push(rel);
    } else {
      missingFiles.push(rel);
    }
  }

  return { user: rUser, project: rProject, team: rTeam, entries, loadedFiles, missingFiles };
}
