#!/usr/bin/env node
/**
 * Corpus CLI — the TypeScript replacement for `scripts/upload_session.py`,
 * `scripts/mask_sessions.py`, and `kb-sitter-skill/scripts/fetch_bdi_files.py`.
 *
 *     node out/corpus/cli.js upload <file> [--source S] [--slug SLUG] [--user U] [--force]
 *     node out/corpus/cli.js delete <filename> [--source S] [--user U]
 *     node out/corpus/cli.js list [--source S] [--top N] [--user U]
 *     node out/corpus/cli.js import [--bob] [--claude] [--user U] [--limit N]
 *                                   [--no-push] [--no-mask] [--force]
 *     node out/corpus/cli.js mask [--user U] [--report PATH] [--dry-run]
 *     node out/corpus/cli.js fetch-knowledge --user U --project P --team T
 *                                   [--local DIR | --repo URL [--ref REF]]
 *
 * Every command takes `--repo <corpus repo root>` (default: the current directory) and
 * `--dry-run` to print each step without touching git or the filesystem.
 */

import * as path from 'path';
import { TIER_ORDER, fetchBdiFiles } from '../supervisor/knowledge';
import * as mask from './mask';
import {
  DEFAULT_TOP_N,
  UploadError,
  deleteSession,
  importSessions,
  listSessions,
  uploadSession,
} from './upload';

const USAGE = `corpus — manage the session corpus and the BDI knowledge it feeds

Usage:
  corpus upload <file> [--source S] [--slug SLUG] [--user U] [--force]
  corpus delete <filename> [--source S] [--user U]
  corpus list [--source S] [--top N] [--user U]
  corpus import [--bob] [--claude] [--user U] [--limit N] [--no-push] [--no-mask] [--force]
  corpus mask [--user U] [--report PATH] [--dry-run]
  corpus fetch-knowledge --user U --project P --team T [--local DIR | --repo URL [--ref REF]]

Common options:
  --repo PATH     corpus repo root (contains data/sessions/) — default: cwd
  --dry-run       print every step without touching git or the filesystem
  -h, --help      show this help
`;

interface Flags {
  positional: string[];
  str: Record<string, string>;
  bool: Set<string>;
}

const VALUE_FLAGS = new Set([
  'source', 'slug', 'user', 'top', 'limit', 'repo', 'report', 'project', 'team', 'local', 'ref',
]);

export function parseFlags(argv: string[]): Flags {
  const flags: Flags = { positional: [], str: {}, bool: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { flags.positional.push(a); continue; }
    const name = a.slice(2);
    if (VALUE_FLAGS.has(name)) {
      const v = argv[++i];
      if (v === undefined) { throw new UploadError(`${a} needs a value`); }
      flags.str[name] = v;
    } else {
      flags.bool.add(name);
    }
  }
  return flags;
}

function repoRoot(f: Flags): string {
  return path.resolve(f.str.repo ?? process.cwd());
}

const log = (msg: string): void => { process.stdout.write(`${msg}\n`); };

async function cmdUpload(f: Flags): Promise<number> {
  const file = f.positional[1];
  if (!file) { throw new UploadError('upload needs a <file>'); }
  await uploadSession({
    repoRoot: repoRoot(f), log, dryRun: f.bool.has('dry-run'),
    sessionFile: file, user: f.str.user, source: f.str.source, slug: f.str.slug,
    force: f.bool.has('force'),
  });
  return 0;
}

async function cmdDelete(f: Flags): Promise<number> {
  const file = f.positional[1];
  if (!file) { throw new UploadError('delete needs a <filename>'); }
  await deleteSession({
    repoRoot: repoRoot(f), log, dryRun: f.bool.has('dry-run'),
    sessionFile: file, user: f.str.user, source: f.str.source,
  });
  return 0;
}

async function cmdList(f: Flags): Promise<number> {
  const top = f.str.top ? Number.parseInt(f.str.top, 10) : DEFAULT_TOP_N;
  const result = await listSessions({
    repoRoot: repoRoot(f), log, user: f.str.user, source: f.str.source, top,
  });
  const sources = Object.keys(result.bySource);
  if (sources.length === 0) {
    log(`No sessions found for user '${result.username}'.`);
    return 0;
  }
  for (const source of sources) {
    const { total, shown } = result.bySource[source];
    if (total === 0) { log(`[${source}] No sessions stored.`); continue; }
    log(`\n${source}  (${total} session${total === 1 ? '' : 's'} total, showing top ${shown.length})`);
    log('─'.repeat(60));
    for (const s of shown) {
      log(`  ${s.filename}${s.title ? `  — ${s.title}` : ''}${s.uploadedAt ? `  ${s.uploadedAt}` : ''}`);
    }
    if (total > shown.length) { log(`  … and ${total - shown.length} more`); }
  }
  return 0;
}

async function cmdImport(f: Flags): Promise<number> {
  await importSessions({
    repoRoot: repoRoot(f), log, dryRun: f.bool.has('dry-run'),
    user: f.str.user,
    bob: f.bool.has('bob'),
    claude: f.bool.has('claude'),
    limit: f.str.limit ? Number.parseInt(f.str.limit, 10) : null,
    force: f.bool.has('force'),
    noPush: f.bool.has('no-push'),
    noMask: f.bool.has('no-mask'),
  });
  return 0;
}

async function cmdMask(f: Flags): Promise<number> {
  const dryRun = f.bool.has('dry-run');
  const summary = await mask.run({
    repoRoot: repoRoot(f), user: f.str.user, reportPath: f.str.report, dryRun,
  });
  if (summary.filesScanned === 0) {
    process.stderr.write('No files found.\n');
    return 1;
  }
  log(`Scanned ${summary.filesScanned} files; ${summary.unique} unique secrets; `
    + `${summary.replacements} replacements across ${summary.filesModified} files.`);
  if (dryRun) {
    log('\n[dry-run] report preview:\n');
    log(summary.content);
  } else if (summary.reportPath) {
    log(`Masked files written. Report: ${path.relative(repoRoot(f), summary.reportPath)}`);
  }
  return 0;
}

/**
 * Print the three BDI tier files as JSON — the contract the kb-sitter skill consumes.
 * A missing tier file is reported as `exists: false`, not an error.
 */
async function cmdFetchKnowledge(f: Flags): Promise<number> {
  for (const required of ['user', 'project', 'team'] as const) {
    if (!f.str[required]) { throw new UploadError(`fetch-knowledge needs --${required}`); }
  }
  const localRepo = f.str.local ?? (f.str.repo ? repoRoot(f) : undefined);
  const files = await fetchBdiFiles(f.str.user, f.str.project, f.str.team, {
    localRepo, repo: f.str.repo && !localRepo ? f.str.repo : undefined, ref: f.str.ref,
  });
  log(JSON.stringify({ load_order: TIER_ORDER, files }, null, 2));
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  const flags = parseFlags(argv);
  switch (flags.positional[0]) {
    case 'upload': return cmdUpload(flags);
    case 'delete': return cmdDelete(flags);
    case 'list': return cmdList(flags);
    case 'import': return cmdImport(flags);
    case 'mask': return cmdMask(flags);
    case 'fetch-knowledge': return cmdFetchKnowledge(flags);
    default:
      process.stderr.write(`unknown command: ${flags.positional[0]}\n\n${USAGE}`);
      return 2;
  }
}

if (require.main === module) {
  main().then(
    code => process.exit(code),
    err => { process.stderr.write(`ERROR: ${String(err instanceof Error ? err.message : err)}\n`); process.exit(1); },
  );
}
