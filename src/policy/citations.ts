/**
 * The durable citation counter — `pipeline/citations.json`.
 *
 * `lifetimeFires` decides whether a red that ablates to zero reads as a **deterrent** (it fired,
 * behaviour changed, it stopped firing — success) or as **dead weight?** / **insufficient
 * exposure**. Computed from the trail, that number is a lie waiting to happen: `decisions.jsonl`
 * rotates at 4 MiB keeping one generation (`MAX_BYTES`, `audit/trail.ts`), so a clause that fired
 * steadily for months and has been quiet this week is indistinguishable from one that never fired.
 * The concrete risk is a retirement proposed for a clause whose whole value is that it stopped
 * something being tried.
 *
 * So this file holds one number per clause, folded from the trail by the same offset discipline
 * Stage A already uses, and it is the input `classify()` reads.
 *
 * ## Why not a field on `DecisionRecord`, and why not `shapes.json`
 *
 * Not the record: the trail is append-only, so a derived value stored on a record goes stale with no
 * way to correct it and no way to detect that it has.
 *
 * Not `shapes.json`, even though that file already carries offsets over the same bytes.
 * `readShapes` **discards** a file whose `version` does not match and rebuilds it from the trail,
 * which is exactly right for derived counts and exactly fatal here: a rebuild from a rotated trail
 * would reset a lifetime count to a smaller number, which is the fabricated-dead-clause failure this
 * file exists to prevent. The two files have opposite disposability, so they are two files. The cost
 * is a second read of the same bytes at session end — under 8 MiB, no parse shared — and that is the
 * price of the count not being throwable-away.
 *
 * ## Monotonic, structurally
 *
 * {@link raise} is the only path that writes a count, and it assigns `max(prior, candidate)`. There
 * is no subtraction, no reset, and no assignment anywhere else in the module — so "the count went
 * down" is not a bug that can be introduced by getting a branch wrong; it is a state the writer
 * cannot express.
 *
 * ## Idempotent
 *
 * Normal folds consume only the bytes after the committed offset, so a re-run over the same input
 * reads no lines and changes nothing. When an offset fails its tail-hash check — a rotation, a
 * truncation — the module re-reads both generations whole and merges the recount with `max` rather
 * than adding it, so re-reading bytes already counted cannot double them either.
 *
 * ponytail: the ceiling of that `max` is that fires living only in bytes rotated away *before any
 * fold saw them* are lost, so a post-rotation count can lag the truth. It can never exceed it and it
 * can never fall, which is the direction that matters: `classify()` asks `lifetimeFires >= 1`, and
 * an undercount can only ever make a deterrent look under-exposed, never make a live clause look
 * dead. Upgrade path if that lag ever matters: fold on trail rotation rather than at session end.
 */

import * as fs from 'fs';
import * as path from 'path';

import { DecisionRecord } from '../audit/trail';
import { decisionsPath } from '../hooks/paths';
import { SourceState, pipelineDir, readNewBytes, tailShaAt } from './mine';
import { citedClauseId } from './replay';

export const CITATIONS_VERSION = 1;

export interface CitationsFile {
  version: number;
  /** Per trail generation, the offset folded to and the tail hash that proves it. */
  sources: Record<string, SourceState>;
  /** `clauseId` → lifetime fires. Only ever raised. See {@link raise}. */
  counts: Record<string, number>;
  lastFoldAt: string | null;
}

export function citationsPath(env?: NodeJS.ProcessEnv): string {
  return path.join(pipelineDir(env), 'citations.json');
}

export function emptyCitations(): CitationsFile {
  return { version: CITATIONS_VERSION, sources: {}, counts: {}, lastFoldAt: null };
}

/**
 * Read the counter, or a fresh empty one.
 *
 * A file from another `version` keeps its `counts` and drops its `sources`, which is the opposite of
 * `readShapes` and deliberately so: the counts are the thing that cannot be rebuilt, the offsets
 * can. Dropping the offsets makes the next fold a full re-read, and the `max` merge means that
 * re-read raises the counts where it can and leaves them alone where it cannot.
 */
export function readCitations(env?: NodeJS.ProcessEnv): CitationsFile {
  let parsed: Partial<CitationsFile>;
  try {
    parsed = JSON.parse(fs.readFileSync(citationsPath(env), 'utf8')) as Partial<CitationsFile>;
  } catch {
    return emptyCitations();
  }
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.counts !== 'object') {
    return emptyCitations();
  }
  const counts: Record<string, number> = {};
  for (const [id, n] of Object.entries(parsed.counts ?? {})) {
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) { counts[id] = Math.floor(n); }
  }
  return {
    version: CITATIONS_VERSION,
    sources: parsed.version === CITATIONS_VERSION ? parsed.sources ?? {} : {},
    counts,
    lastFoldAt: parsed.lastFoldAt ?? null,
  };
}

/** One rename, so the offsets and the counts commit together or not at all — as `shapes.json` does. */
export function writeCitations(file: CitationsFile, env?: NodeJS.ProcessEnv): void {
  const dir = pipelineDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.citations.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, `${JSON.stringify(file, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, citationsPath(env));
}

/**
 * The only write. `max`, so a count cannot decrease however wrong the caller is about `candidate`.
 *
 * This is the whole monotonicity argument: not a rule the callers follow, a value the writer cannot
 * produce.
 */
export function raise(counts: Record<string, number>, clauseId: string, candidate: number): void {
  const prior = counts[clauseId] ?? 0;
  if (candidate > prior) { counts[clauseId] = candidate; }
}

export interface CitationFoldResult {
  /** Records read this fold. */
  folded: number;
  /** Of those, records carrying a clause citation. */
  cited: number;
  /** Clauses whose count moved. */
  raised: number;
  /** True when an offset failed verification and both generations were re-read whole. */
  reread: boolean;
  citations: CitationsFile;
}

/**
 * Fold new citations. Does not write — the caller writes, so the fold can be tested in isolation and
 * so `accumulate` keeps one place that commits pipeline state.
 */
export function foldCitations(
  env?: NodeJS.ProcessEnv, now: Date = new Date(),
): CitationFoldResult {
  const citations = readCitations(env);
  const base = decisionsPath(env);
  // `.1` first, so `firstSeen`-style ordering reads chronologically for a human opening the file.
  // Nothing here depends on order: every counter is a sum merged with `max`.
  const files = [`${base}.1`, base];

  let reads = files.map(file => readNewBytes(file, citations.sources[path.basename(file)]));
  const reread = reads.some(next => next?.reread === true);
  if (reread) {
    // One offset that outlived its bytes makes every offset over the same rotation suspect, so both
    // generations are re-read whole. `max` is what makes that safe to do repeatedly.
    reads = files.map(file => readNewBytes(file, undefined));
  }

  const delta: Record<string, number> = {};
  const result: CitationFoldResult = { folded: 0, cited: 0, raised: 0, reread, citations };

  reads.forEach((next, i) => {
    if (next === null) { return; }
    for (const line of next.lines) {
      let record: DecisionRecord;
      try {
        record = JSON.parse(line) as DecisionRecord;
      } catch {
        continue;                       // a torn line from a crashed writer; the trail's own rule
      }
      if (typeof record?.ts !== 'string') { continue; }
      result.folded += 1;
      const clauseId = citedClauseId(record.clause);
      if (clauseId === null) { continue; }
      result.cited += 1;
      delta[clauseId] = (delta[clauseId] ?? 0) + 1;
    }
    const name = path.basename(files[i]);
    citations.sources[name] = {
      size: next.size,
      mtimeMs: next.mtimeMs,
      offset: next.offset,
      tailSha: next.offset > 0 ? tailShaAt(files[i], next.offset) : '',
    };
  });

  for (const [clauseId, n] of Object.entries(delta)) {
    const before = citations.counts[clauseId] ?? 0;
    // A re-read has already-counted bytes in `n`, so it merges rather than adds. A normal fold read
    // only new bytes, so it adds. Both go through `raise`, so neither can lower anything.
    raise(citations.counts, clauseId, reread ? n : before + n);
    if ((citations.counts[clauseId] ?? 0) > before) { result.raised += 1; }
  }
  if (result.folded > 0) { citations.lastFoldAt = now.toISOString(); }
  return result;
}

/** The counts, for `ablate`'s `citations` option. Empty when the counter has never been folded. */
export function lifetimeCitations(env?: NodeJS.ProcessEnv): Record<string, number> {
  return readCitations(env).counts;
}
