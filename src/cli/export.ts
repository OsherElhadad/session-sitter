/**
 * `session-sitter export` — the only seam between the audit trail and everything downstream.
 *
 * **The app never pushes.** `export` writes to stdout and whatever the user chose consumes it:
 * `curl` into VictoriaLogs' `/insert/jsonline`, `logcli push` to Loki, `sqlite-utils insert --nl`
 * into a Datasette file, `>` to a file an OTel Collector tails. The tool someone picked is a fact
 * about their shell history, not about our `package.json` — which is why there is no exporter, no
 * SDK, no daemon, and nothing here to keep in step with a moving spec.
 *
 * Two shapes, one projection:
 *
 *  - `--jsonline` — ndjson to stdout. `DecisionRecord` already *is* ndjson with an ISO `ts`, so the
 *    shipper is `curl` and there is nothing to write.
 *  - `--html` — one self-contained file, opened over `file://`, mailed, or committed to a private
 *    repo. Inline SVG and CSS gradients only: no CDN, no chart library, no web fonts, no remote
 *    `<img>`. Offline `file://` and the webview CSP forbid remote fetches, and the zero-dependency
 *    rule forbids the library.
 *
 * ## It is a report, not a live view, and it says so
 *
 * A stale page that looks live is worse than no page, and this is the tier most people use. So the
 * title and heading end in `— snapshot`; a header band carries the generation instant, the window as
 * two absolute instants, the revisions, the record count and whether `--limit` truncated it, and the
 * version and host that produced it; the regeneration command ships verbatim inside the thing that
 * goes stale; there are no relative timestamps anywhere, because "3 minutes ago" is precisely the
 * lie a static file tells; a few lines of script compare the viewer's clock to the embedded
 * generation instant and paint a band past 24 h, which is the only staleness signal that can be true
 * at view *time*; and there are no live affordances at all — no meta refresh, no poll, no heartbeat.
 * A cell nothing recorded prints `not recorded`, never `0`.
 *
 * ## Privacy: projection, not redaction
 *
 * `redactSecrets` matches credential *shapes*. It cannot know that a URL names a customer, that a
 * path names a deal, or that a sentence is about an unannounced product. So `--scope=team` is an
 * explicit allow-list that **drops keys** rather than blanking them — a dashboard filter is a
 * display choice over data that has already left the machine, and a blanked key is a column someone
 * later fills in.
 *
 * Because the projection drops keys, **the ship command is byte-identical in both scopes**
 * ({@link SHIP_COMMAND}): `_msg_field=note,inputSummary` simply finds neither field in a team
 * payload and falls back. There is no scope-aware branch downstream, no second code path to get
 * wrong, and no flag anyone can flip to leak the excluded set. A design where the same command is
 * safe in both scopes cannot be misconfigured into unsafety; a design with a `--redact` toggle can,
 * and eventually is.
 *
 * Nothing here ships automatically. There is no `SessionEnd` egress: `export` is a command a human
 * runs, or a cron a human wrote.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHmac, randomBytes } from 'crypto';
import { BUILD_VERSION } from '../buildInfo';
import { DecisionRecord, fingerprint, readJsonl } from '../audit/trail';
import { dataDir, decisionsPath } from '../hooks/paths';
import { pipelinePath, type RunLine } from '../policy/pipeline';
import { loadSettings, settingRows, type SettingRow } from '../hooks/settings';
import { loadPolicyInputs } from '../hooks/permissionRequest';
import { CliError, flagBool, flagNumber, flagString, parseFlags, type FlagSpec } from './args';
import { parseSince } from './time';
import type { Io } from './render';

/** Rows past this are summarised rather than listed. Doc 14's measured number. */
export const DEFAULT_LIMIT = 2000;

/** How many denials and rewrites the list shows. Past this it is an aggregate, and says so. */
const DENIAL_ROWS = 100;

/** The age at which the report paints a staleness band on load. */
const STALE_AFTER_HOURS = 24;

export const EXPORT_SPEC: FlagSpec = {
  '--jsonline': 'boolean',
  '--html': 'boolean',
  '--scope': 'string',
  '--since': 'string',
  '--limit': 'number',
  '--help': 'boolean',
  '-h': 'boolean',
};

/**
 * The tier-1 ship command, and the reason it is a constant.
 *
 * It carries no `--scope`, so it is the same bytes whichever scope produced the stream. That
 * property is the privacy guarantee, not a coincidence — see the module comment.
 *
 * `-httpListenAddr=127.0.0.1:9428` is not cosmetic. VictoriaLogs' default binds **every** interface,
 * which on a café network publishes the audit trail to every device on it.
 *
 * ## `-H 'Content-Type: application/x-ndjson'` is not cosmetic either
 *
 * **Without it this command silently ships nothing.** `curl --data-binary` defaults to
 * `Content-Type: application/x-www-form-urlencoded`, and VictoriaLogs v1.52.0 discards the body of a
 * form-urlencoded POST to `/insert/jsonline` while still answering **HTTP 200** — no error, no
 * warning, `vl_http_errors_total` unmoved, `vl_rows_ingested_total` and `vl_bytes_ingested_total`
 * both flat at zero. So the failure is invisible from the shell: the command succeeds, prints
 * nothing, and the store stays empty, and the only symptom is an empty UI with nothing anywhere to
 * explain it.
 *
 * Measured against a real v1.52.0 on 2026-09-04, not inferred: with the header present, and with
 * `application/json` or `text/plain`, one line in is one row queryable back out; with curl's default
 * it is zero rows every time.
 *
 * ## `_stream_fields=kind,machine`, and nothing else
 *
 * A stream field partitions the store; it is not "the columns I want to group by". Every field in
 * the line is queryable either way, so a field named here buys nothing and costs a stream per
 * distinct combination — with its own index entry and its own write buffer.
 *
 * `kind` is two values and `machine` is however many machines one person owns, so the product is
 * bounded by hardware. Naming `tool` and `actor` as well, which this command used to, multiplies
 * that by ~120 for no query benefit; naming `clause` would multiply it by the rendered-clause
 * ceiling; naming `sessionId` or `rev` would make it unbounded by construction, one new stream per
 * session or per artifact revision, forever.
 *
 * The failure that buys is not a slow query. A laptop with 20 000 decisions and a few hundred
 * streams is fast, so wrong wiring looks correct and ships — and then arrives weeks later as
 * ingestion latency, then RSS, then rejected writes. In a governance tool the moment the trail
 * stops being written is the moment you most need it.
 */
export const SHIP_COMMAND =
  'session-sitter export --jsonline --since 7d \\\n'
  + "  | curl -s -X POST -H 'Content-Type: application/x-ndjson' --data-binary @- \\\n"
  + "    '127.0.0.1:9428/insert/jsonline"
  + "?_time_field=ts&_msg_field=note,inputSummary,headline"
  + "&_stream_fields=kind,machine'";

/**
 * The keys a team payload carries. An allow-list, so a field added to `DecisionRecord` later is
 * dropped by default rather than shipped by default — the direction that fails safe.
 *
 * `kind` and `machine` are on it because they are *added* by the export rather than read from the
 * record: `kind` so a store holding both shapes can tell a decision from a pipeline run without
 * guessing from which keys happen to be present, and `machine` because tier 1's one genuine
 * advantage over tier 0 is a view across several machines, which is impossible if no line says
 * which machine it came from.
 *
 * It is called `machine` and not `host` on purpose. `host` stays in {@link NEVER_SHIPPED}, because a
 * raw hostname names a person's laptop and there is no scope in which that should leave. `machine`
 * is the per-machine HMAC the other pseudonyms use — correlatable *between* machines and useless for
 * identifying one — so the field's own name states what it holds, and the guarantee "no key called
 * `host` ever leaves" stays literal and testable rather than becoming a judgement about values.
 */
export const TEAM_FIELDS: readonly string[] = [
  'ts', 'latencyMs', 'tool', 'decision', 'light', 'actor', 'rewritten', 'clause', 'rev',
  'policySource', 'telemetry', 'sessionId', 'cwd', 'toolShape', 'inputFingerprint',
  'kind', 'machine',
];

/**
 * What never leaves the machine, named so the guarantee is testable rather than aspirational.
 *
 * Several of these are not fields of `DecisionRecord` at all — they belong to the audit-record and
 * supervision-record shapes the other readers handle. They are listed anyway: the allow-list makes
 * them unshippable, and naming them is what stops a later writer from adding one and assuming it is
 * fine.
 *
 * `ask` leads the list because it is a human's own prose about their own work, which is the highest
 * risk thing in any of these records.
 */
export const NEVER_SHIPPED: readonly string[] = [
  'ask', 'note', 'reason', 'inputSummary', 'call', 'original_input', 'updated_input',
  'session_name', 'sessionName', 'assessment', 'issues', 'host',
];

export type Scope = 'local' | 'team';

export const HELP = `session-sitter export — the audit trail, as ndjson or as one HTML file

Usage:
  session-sitter export --jsonline [options]
  session-sitter export --html [options] > report.html

Shapes (exactly one is required):
  --jsonline           newline-delimited JSON on stdout, one object per decision
  --html               one self-contained HTML snapshot on stdout

Options:
  --scope local|team   local (default) is the record as written; team applies the
                       allow-list below, dropping the keys it excludes
  --since WHEN         only decisions since WHEN — 2h, 7d, 2026-08-30, or an ISO instant
  --limit N            keep at most the newest N records (default ${DEFAULT_LIMIT})
  -h, --help           show this help

The team scope drops, rather than blanks:
  ${NEVER_SHIPPED.join(', ')}
and replaces inputSummary with a shape ("Bash git push", not the command line). cwd and
sessionId become HMACs under a key generated once per machine, so a session stays
correlatable within itself and not back to a repository.

There is no flag that ships the excluded set. Because the projection drops keys, the ship
command is byte-identical in both scopes:

  ${SHIP_COMMAND.split('\n').join('\n  ')}

Nothing is shipped automatically. This is a command you run, or a cron you wrote.
`;

// ── The projection ──────────────────────────────────────────────────────────

/** Only a bare word, and never a flag: a URL, a path or a quoted argument is not one. */
const BARE_WORD = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The tool and, for a shell call, its verb — `Bash git push`, never the command line.
 *
 * The first two tokens are taken and *then* filtered, not the other way round: filtering first would
 * let a later bare word be promoted into the shape, so `curl -H "Authorization: …" payments-internal`
 * would ship the host. Anything that is not a bare word ends the shape.
 */
export function toolShape(record: Pick<DecisionRecord, 'tool' | 'inputSummary'>): string {
  if (record.tool !== 'Bash') { return record.tool; }
  const words = (record.inputSummary ?? '').trim().split(/\s+/).slice(0, 2)
    .filter(w => BARE_WORD.test(w));
  return [record.tool, ...words].join(' ');
}

/**
 * One decision, as the team tier sees it.
 *
 * Built by naming every key that is kept, so the excluded ones are *absent* — not null, not empty
 * string, not present-but-hidden. A reader cannot un-hide what is not in the bytes.
 */
export function projectTeam(record: DecisionRecord, key: Buffer): Record<string, unknown> {
  const pseudonym = (value: string): string =>
    createHmac('sha256', key).update(value, 'utf8').digest('hex').slice(0, 16);
  return {
    // Emitted here rather than added by the caller, so this stays the one function that decides
    // which keys exist — which is what makes {@link TEAM_FIELDS} an assertable list rather than a
    // comment about one.
    kind: 'decision',
    machine: pseudonym(os.hostname()),
    ts: record.ts,
    latencyMs: record.latencyMs,
    tool: record.tool,
    decision: record.decision,
    light: record.light,
    actor: record.actor,
    rewritten: record.rewritten,
    // The team's own written practice, and the least sensitive thing in the record.
    clause: record.clause,
    rev: record.rev ?? null,
    policySource: record.policySource ?? null,
    // Counts, never content. Null means no model ran, which is not a cache miss — see
    // `DecisionRecord.telemetry`.
    telemetry: record.telemetry ?? null,
    sessionId: pseudonym(record.sessionId),
    cwd: pseudonym(record.cwd),
    toolShape: toolShape(record),
    inputFingerprint: record.call ? fingerprint(record.call.tool_name, record.call.input) : null,
  };
}

/**
 * One offline pipeline run, flattened, and the same shape in both scopes.
 *
 * ## Why the offline side is here at all
 *
 * `learn` writes a run line per invocation whether or not it produced anything, and that is the
 * whole point of the file: a fail-closed run that correctly proposed nothing leaves **no clause
 * file and no commit**, so surviving artefacts cannot distinguish it from a pipeline that never ran.
 * A funnel derived from `proposals/*.md` shows only the runs that produced something, which is
 * exactly the wrong half. So the run line ships, and a produced-nothing run is a row.
 *
 * ## Why one shape for both scopes
 *
 * A `RunLine` is large and several of its fields are local by nature: `corpusRoot` and
 * `window.files` are filesystem paths, `error` is an exception string that routinely carries one,
 * `headline` is prose, and a `Refusal`'s `cluster` is a command shape lifted from real work. Rather
 * than a second allow-list, the projection keeps the **counts and the closed enums** and drops
 * everything else in both scopes — nothing downstream needs a corpus path to draw a funnel, and one
 * shape means there is no scope-aware branch here to get wrong either.
 *
 * `refusals` keeps only the {@link RefusalReason} codes, which are a closed enum of eleven values
 * and therefore safe by construction. The cluster each refusal names is a real command and stays on
 * the machine, where `session-sitter learn --status` prints it.
 *
 * Flat, not nested, because every consumer of this — LogsQL, a Grafana transform, the snapshot's own
 * table — reads flat fields and would otherwise each need their own nested-path handling.
 */
export function projectRun(line: RunLine, machine: string): Record<string, unknown> {
  const w = line.window;
  const c = line.candidates;
  return {
    kind: 'pipeline_run',
    ts: line.ts,
    machine,
    runId: line.runId,
    stage: line.stage,
    trigger: line.trigger,
    rev: line.rev,
    exitReason: line.exitReason,
    // True when the run ended in an error, so a broken pipeline is a filter and not a reading of
    // prose. `learn` keeps the message itself local.
    failed: line.exitReason === 'error',
    // A run that ran every gate and correctly proposed nothing. The row that only exists here.
    //
    // Only a `propose` run can be it. An `accumulate` run folds new records and never proposes, so
    // "produced nothing" is not an outcome for it — and a field that is true on every accumulate row
    // is a query anyone would trust and nobody could use. Guarded here rather than by each reader,
    // because the reader who forgets is the one whose panel is quietly wrong.
    producedNothing: line.stage === 'propose'
      && c.proposed === 0 && c.retired === 0 && line.exitReason !== 'error',
    scanned: w.scanned,
    fresh: w.new,
    spanDays: w.spanDays,
    rotated: w.rotated,
    unstamped: w.unstamped,
    noCall: w.noCall,
    shapes: line.shapes.total,
    shapesCrossedFloor: line.shapes.crossedFloor,
    clusters: line.clusters.total,
    clustersBelowFloor: line.clusters.belowFloor,
    clustersContradicted: line.clusters.contradicted,
    considered: c.considered,
    proposed: c.proposed,
    merged: c.merged,
    retired: c.retired,
    held: c.held,
    refusals: line.refusals.map(r => r.why),
    refusalCount: line.refusals.length,
    replayN: line.replay.n,
    replayChanged: line.replay.changed,
    replayReversals: line.replay.reversals,
    replayCalibrated: line.replay.calibrated,
    durationMs: line.durationMs,
    // Asserted zero on this path. Shipped so a nonzero one is visible in the store rather than only
    // in a test — the pipeline calling a model would be a change of kind, not of degree.
    modelCalls: line.model.calls,
  };
}

/**
 * The per-machine HMAC key, generated once.
 *
 * Per-machine and never shared: that is what makes a pseudonym correlatable *within* one machine's
 * stream and useless for joining back to a repository or a person. Mode 0600 for the same reason.
 */
export function hmacKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const file = path.join(dataDir(env), '.export-key');
  try {
    return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  } catch {
    const key = randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
    return key;
  }
}

// ── The config, read from the runtime's own loaders ─────────────────────────

/** The projected run line, as {@link projectRun} returns it. Flat, and the same in both scopes. */
export interface ProjectedRun {
  ts: string;
  runId: string;
  stage: string;
  trigger: string;
  rev: string | null;
  exitReason: string;
  failed: boolean;
  producedNothing: boolean;
  scanned: number;
  fresh: number;
  rotated: boolean;
  shapes: number;
  clusters: number;
  clustersBelowFloor: number;
  considered: number;
  proposed: number;
  retired: number;
  held: number;
  refusals: string[];
  refusalCount: number;
  replayN: number;
  replayChanged: number;
  durationMs: number;
  modelCalls: number;
}

export interface ResolvedConfig {
  settings: SettingRow[];
  /** `unreadable` is its own value: a corpus that would not load is not a corpus that says "none". */
  policySource: 'artifact' | 'markdown' | 'none' | 'unreadable';
  rev: string | null;
  /** Why there is no artifact, in the loader's own words. */
  reason: string | null;
  clauseCount: number | null;
  error: string | null;
}

/**
 * The resolved configuration and the pinned artifact revision, from the loaders the ladder itself
 * uses — {@link loadSettings} and {@link loadPolicyInputs}, not a second parse of anything.
 *
 * That rule is the whole value of the panel. A config view that re-reads the environment, or
 * re-parses the corpus, is a view that can disagree with the code it claims to describe; it will,
 * eventually, and precisely when somebody is trusting it to explain a denial.
 *
 * A corpus that will not load is reported as `unreadable` with the error, and never as "no policy".
 * Those are different states with opposite meanings — one is a configuration choice, the other is
 * the condition under which the ladder fails closed on everything — and collapsing them would make
 * the snapshot lie in the one situation where somebody is reading it to find out why.
 */
export async function resolvedConfig(): Promise<ResolvedConfig> {
  const settings = loadSettings();
  try {
    const policy = await loadPolicyInputs(settings);
    return {
      settings: settingRows(settings),
      policySource: policy.source,
      rev: policy.rev,
      reason: policy.reason,
      clauseCount: policy.clauses.length,
      error: null,
    };
  } catch (err) {
    return {
      settings: settingRows(settings),
      policySource: 'unreadable',
      rev: null,
      reason: null,
      clauseCount: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Aggregation ─────────────────────────────────────────────────────────────

/**
 * The ladder rung, derived from `(actor, decision)` and never stored — a stored rung is a rung that
 * can drift out of step with the ladder it describes.
 *
 * Rung 2' is the correction lane's rejection: "we tried to make it safe and the safe form was also
 * forbidden". It is only tellable apart from rung 3 because `actor` gained `correction`; a record
 * written before that reports rung 2' as rung 3 and cannot be recovered, which the report says out
 * loud rather than quietly folding.
 */
export function rungOf(record: Pick<DecisionRecord, 'actor' | 'decision'>): string {
  const { actor, decision } = record;
  if (actor === 'deterministic') { return decision === 'allow' ? '1' : '5'; }
  if (actor === 'correction') { return decision === 'allow' ? '2' : "2'"; }
  if (actor === 'policy') { return decision === 'allow' ? '4' : '3'; }
  if (actor === 'model') { return '6'; }
  if (actor === 'timeout') { return '7'; }
  return '—';
}

const RUNG_LABEL: Readonly<Record<string, string>> = {
  '1': 'deterministic green — a read, or a vouched shell line',
  '2': 'correction lane — rewritten and allowed',
  "2'": 'correction lane — the safer form was also forbidden',
  '3': 'a written red clause',
  '4': 'a written green clause',
  '5': 'the built-in destructive table',
  '6': 'the classifier',
  '7': 'fail closed',
  '—': 'escalated to a person, or no verdict returned',
};

/** `null` when nothing recorded one, which prints as "not recorded" and never as a zero. */
function quantile(values: number[], q: number): number | null {
  if (values.length === 0) { return null; }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

// ── HTML ────────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/** A field nothing recorded. Never a zero: a report that invents a number gets forwarded. */
const NOT_RECORDED = '<span class="none">not recorded</span>';

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') { return NOT_RECORDED; }
  return escapeHtml(String(value));
}

/** A count as a table cell with a proportional CSS bar behind it — no chart library, no SVG needed. */
function barCell(count: number, max: number): string {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  return `<td class="bar" style="--pct:${pct}%">${count}</td>`;
}

const OUTCOMES: readonly { key: string; label: string; light: string; dark: string }[] = [
  { key: 'allow', label: 'allowed', light: '#2f7d68', dark: '#5fbfa4' },
  { key: 'correct', label: 'corrected — rewritten and allowed', light: '#3a6ea8', dark: '#7aa9dd' },
  { key: 'deny', label: 'denied by a clause or the built-in table', light: '#a33b32', dark: '#e58a80' },
  { key: 'closed', label: 'fail closed — nothing answered', light: '#6b3f8f', dark: '#b98ede' },
  { key: 'none', label: 'no verdict — exempt tool, or observe mode', light: '#8a8a90', dark: '#8a8a90' },
];

/** Which of the five a record is. Total over the union, so no record is silently uncounted. */
export function outcomeOf(
  r: Pick<DecisionRecord, 'decision' | 'rewritten' | 'actor'>,
): string {
  if (r.decision === 'none') { return 'none'; }
  if (r.rewritten) { return 'correct'; }
  if (r.actor === 'timeout') { return 'closed'; }
  return r.decision === 'allow' ? 'allow' : 'deny';
}

/**
 * The outcome mix over time, as one stacked-bar `<svg>`.
 *
 * The question this answers is not "how many" — the count is in three other places — it is **"is the
 * shape changing"**. A deny rate that steps up on a Tuesday is a practices edit, and a fail-closed
 * band appearing at all is a broken artifact or loader. Both are visible as a change in
 * proportion and neither is visible in a total.
 *
 * Buckets are whole days in the viewer-independent sense: the `YYYY-MM-DD` prefix of the stored
 * instant, which is UTC, stated as such in the caption rather than silently rendered in whatever
 * zone the reader is in. A snapshot that re-buckets itself per reader is a snapshot two people
 * disagree about.
 */
function outcomeChart(byDay: Map<string, Map<string, number>>): string {
  const days = [...byDay.keys()].sort();
  if (days.length === 0) {
    return `<p class="none">not recorded — no decision in this window</p>`;
  }
  const totalFor = (day: string): number =>
    [...(byDay.get(day) ?? new Map()).values()].reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...days.map(totalFor));
  const H = 130;
  const w = days.length > 60 ? 4 : days.length > 24 ? 8 : 16;
  const gap = w > 4 ? 3 : 1;
  const width = days.length * (w + gap);

  const bars = days.map((day, i) => {
    const counts = byDay.get(day) ?? new Map<string, number>();
    const total = totalFor(day);
    let y = H;
    const parts = OUTCOMES.map(o => {
      const n = counts.get(o.key) ?? 0;
      if (n === 0) { return ''; }
      // At least one pixel: a single denial in a thousand allows is the row somebody is looking for,
      // and rounding it to nothing is the chart lying by omission.
      const h = Math.max(1, Math.round((n / max) * H));
      y -= h;
      return `<rect class="o-${o.key}" x="${i * (w + gap)}" y="${y}" width="${w}" height="${h}"></rect>`;
    }).join('');
    const detail = OUTCOMES.filter(o => (counts.get(o.key) ?? 0) > 0)
      .map(o => `${counts.get(o.key)} ${o.label}`).join(', ');
    // One title per column rather than per segment: the reader wants the day's whole mix, and a
    // 4px-wide segment is not a hover target.
    return `<g><title>${escapeHtml(day)} — ${total} decision(s): ${escapeHtml(detail)}</title>`
      + `<rect class="hit" x="${i * (w + gap)}" y="0" width="${w}" height="${H}"></rect>${parts}</g>`;
  }).join('');

  const legend = OUTCOMES.map(o =>
    `<span class="key"><i class="o-${o.key}"></i>${escapeHtml(o.label)}</span>`).join('');

  return `<svg class="stack" viewBox="0 0 ${width} ${H}" height="${H}" preserveAspectRatio="none"`
    + ` role="img" aria-label="decisions per UTC day, stacked by outcome">${bars}</svg>`
    + `<p class="axis">${escapeHtml(days[0])} → ${escapeHtml(days[days.length - 1])}`
    + ` · whole UTC days · tallest day ${max} decision(s)</p>`
    + `<p class="legend">${legend}</p>`;
}

/**
 * The offline pipeline funnel, as five labelled horizontal bars.
 *
 * Not a Sankey. A five-stage Sankey is a picture that looks like insight and conveys a table, and
 * this one has to be readable next to the run rows that explain it.
 *
 * Every stage prints its absolute count *and* its retention against the stage above, because the
 * interesting fact about this funnel is always where it narrows — a floor nothing clears and a
 * replay nothing survives are the two designed outcomes, and both look like "no output" from the
 * end of the pipe.
 */
function funnel(stages: readonly { label: string; n: number; note: string }[]): string {
  const max = Math.max(1, ...stages.map(s => s.n));
  return `<table class="funnel">
<thead><tr><th>stage</th><th>count</th><th>of the stage above</th><th>what it means</th></tr></thead>
<tbody>${stages.map((st, i) => {
    const above = i === 0 ? null : stages[i - 1].n;
    const share = above === null ? '' : above === 0 ? NOT_RECORDED
      : `${Math.round((st.n / above) * 100)}%`;
    return `<tr><td>${escapeHtml(st.label)}</td>${barCell(st.n, max)}`
      + `<td>${share}</td><td class="dim">${escapeHtml(st.note)}</td></tr>`;
  }).join('')}</tbody>
</table>`;
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1c1c1e; --bg: #fbfbfd; --dim: #6b6b70;
  --line: #dcdce1; --bar: #c9d8ef; --warn: #7a1c1c; --warnbg: #fbe3e3; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6e6ea; --bg: #17171a; --dim: #9a9aa2;
  --line: #34343a; --bar: #2c4468; --warn: #ffd7d7; --warnbg: #4a1414; } }
body { margin: 0 auto; padding: 2rem 1.25rem 4rem; max-width: 62rem; background: var(--bg);
  color: var(--fg); font: 14px/1.55 ui-sans-serif, system-ui, sans-serif; }
h1 { font-size: 1.4rem; margin: 0 0 1rem; }
h2 { font-size: 1rem; margin: 2.25rem 0 .5rem; }
p.note { color: var(--dim); margin: .25rem 0 .75rem; }
table { border-collapse: collapse; width: 100%; margin: .5rem 0; }
th, td { text-align: left; padding: .3rem .55rem; border-bottom: 1px solid var(--line);
  vertical-align: top; }
th { color: var(--dim); font-weight: 600; }
td.bar { position: relative; text-align: right; width: 6rem; }
td.bar::before { content: ""; position: absolute; inset: 2px auto 2px 2px; width: var(--pct);
  background: var(--bar); border-radius: 2px; }
td.bar { z-index: 0; } td.bar::before { z-index: -1; }
.none { color: var(--dim); font-style: italic; }
.band { border: 1px solid var(--line); border-radius: 6px; padding: .75rem 1rem; margin: 0 0 1rem; }
.band dl { display: grid; grid-template-columns: max-content 1fr; gap: .2rem .9rem; margin: 0; }
.band dt { color: var(--dim); }
.band dd { margin: 0; }
pre { background: rgba(127,127,127,.12); padding: .6rem .8rem; border-radius: 4px;
  overflow-x: auto; margin: .6rem 0 0; user-select: all; }
/* The same block inside a table cell, where a row of them would otherwise be a wall of grey. */
pre.inline { margin: 0; padding: .15rem .4rem; display: inline-block; }
code, pre, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
#stale { display: none; background: var(--warnbg); color: var(--warn); border-radius: 6px;
  padding: .7rem 1rem; margin: 0 0 1rem; font-weight: 600; }
p.axis { color: var(--dim); margin: .2rem 0 0; font-size: .85rem; }
td.dim, .dim { color: var(--dim); }
svg.stack { width: 100%; display: block; margin: .5rem 0 0; }
svg.stack rect.hit { fill: transparent; }
p.legend { margin: .5rem 0 0; display: flex; flex-wrap: wrap; gap: .3rem 1.1rem;
  color: var(--dim); font-size: .85rem; }
p.legend .key { display: inline-flex; align-items: center; gap: .35rem; }
p.legend i { width: .7rem; height: .7rem; border-radius: 2px; display: inline-block; }
${OUTCOMES.map(o => `.o-${o.key} { fill: ${o.light}; background: ${o.light}; }`).join('\n')}
@media (prefers-color-scheme: dark) {
${OUTCOMES.map(o => `  .o-${o.key} { fill: ${o.dark}; background: ${o.dark}; }`).join('\n')}
}
table.funnel td.bar { width: 8rem; }
/* The rows that exist for no other reason. The outcome column already names them, so this is a
   cue and not a second copy of the text. */
tr.nothing td { border-left: 2px solid var(--bar); }
tr.nothing td:first-child { border-left-width: 4px; }
.warnband { background: var(--warnbg); color: var(--warn); border-radius: 6px;
  padding: .6rem .9rem; margin: .6rem 0; }
`.trim();

/**
 * The age check, and the only script in the file.
 *
 * It is the one staleness signal that can be true at *view* time rather than at write time: every
 * other honest option was fixed the moment the file was written. No network, no timer, no poll —
 * it runs once and stops.
 */
const AGE_SCRIPT = `
var el = document.getElementById('generated-at');
var age = (Date.now() - Date.parse(el.textContent)) / 3600000;
if (age > ${STALE_AFTER_HOURS}) {
  var band = document.getElementById('stale');
  band.textContent = 'This snapshot is ' + Math.floor(age / 24) + ' day(s) old. Regenerate it with '
    + 'the command in the header band below.';
  band.style.display = 'block';
}
`.trim();

export interface HtmlMeta {
  generatedAt: Date;
  scope: Scope;
  /** How many records the window held before `--limit`, so truncation can be stated. */
  total: number;
  host: string;
  regenerateCommand: string;
  /**
   * The offline side. Empty is a real answer — this machine has never run `learn` — and is printed
   * as that rather than as a missing section, because "the pipeline has not run here" and "the
   * pipeline ran and proposed nothing" are the two states the run line exists to separate.
   */
  runs: readonly ProjectedRun[];
  /** Rendered at `local` scope only; see {@link renderConfig}. */
  config: ResolvedConfig;
}

/**
 * The resolved config, and the command that changes each setting.
 *
 * **Read here; written in a terminal.** That asymmetry is deliberate and it is the one design
 * decision in this file worth arguing rather than just documenting. Session Sitter's central claim is
 * that the supervised agent cannot change the policy that governs it. A page that can change the
 * mode is a write path into a fail-closed governance tool, reachable by whatever can reach the page
 * — and on the tier-2 path that is a Grafana running with anonymous admin on purpose, because it is
 * bound to loopback. The value of being able to flip a switch in a browser does not come close to
 * the cost of the policy having a second, weaker door. So every row states what is in force and the
 * one line that changes it, and nothing rendered here changes anything.
 *
 * **Local scope only.** The values name a corpus, a practices file and a routing triple — a repo
 * name, a team name and a filesystem path — none of which the team projection would let through if
 * they were on a decision record. A snapshot meant to be forwarded says the table was withheld and
 * why, which is a smaller loss than the alternative, since the person who needs the config is
 * already on the machine that has it.
 */
function renderConfig(config: ResolvedConfig, scope: Scope): string {
  if (scope === 'team') {
    return `<p class="none">withheld from a team snapshot on purpose — the resolved config names a
    corpus, a practices file and a routing triple, which are the repo, team and path names the team
    projection drops everywhere else. Read it on the machine itself:
    <span class="mono">session-sitter export --html &gt; report.html</span>.</p>`;
  }

  const source = config.policySource === 'unreadable'
    ? `<div class="warnband">The compiled policy could not be read, so rungs 2&ndash;4 never ran and
       every ambiguous call fails closed. This is not "no policy configured" — it is the condition
       under which everything is denied. Error: <span class="mono">${cell(config.error)}</span></div>`
    : '';

  const rows = config.settings.map(row =>
    `<tr><td class="mono">${escapeHtml(row.key)}</td><td class="mono">${cell(row.value)}</td>`
    + `<td><pre class="inline">${escapeHtml(row.command)}</pre></td></tr>`).join('');

  return `${source}<table>
<thead><tr><th>what is in force</th><th>value</th><th>the command that changes it</th></tr></thead>
<tbody>
<tr><td class="mono">policySource</td><td class="mono">${cell(config.policySource)}</td>
<td class="dim">${config.reason === null ? 'the compiled artifact is in use'
    : escapeHtml(config.reason)}</td></tr>
<tr><td class="mono">rev</td><td class="mono">${cell(config.rev)}</td>
<td class="dim">the pinned artifact revision every decision below was evaluated against</td></tr>
<tr><td class="mono">clauses in force</td><td class="mono">${cell(config.clauseCount)}</td>
<td class="dim">accepted only &mdash; a proposed clause cannot decide, match, or reach the prompt</td></tr>
${rows}
</tbody>
</table>
<p class="note">Every value above comes from the loaders the ladder itself uses, never from a second
read of the environment or a re-parse of the corpus: a config view that reads its own inputs twice is
a view that can disagree with the code it describes, and it will, exactly when someone is using it to
find out why a call was denied. There is deliberately no control on this page that changes any of
them &mdash; a browser that can rewrite the policy is a second and weaker door into the thing whose
whole purpose is that the supervised agent cannot open it.</p>`;
}

/**
 * The offline pipeline: the funnel, and one row per run including the runs that changed nothing.
 *
 * The produced-nothing row is the reason this section exists rather than being derived from
 * `proposals/*.md` and the corpus git log. A run that read the trail, ran every gate and correctly
 * proposed nothing writes **no file and makes no commit**, so surviving artefacts cannot tell it
 * apart from a pipeline that never ran at all — and those two have opposite meanings. One is the
 * fail-closed design working; the other is a broken scheduler nobody has noticed.
 */
function renderPipeline(runs: readonly ProjectedRun[]): string {
  if (runs.length === 0) {
    return `<p class="none">not recorded &mdash; <span class="mono">session-sitter learn</span> has
    never run on this machine, so there is no <span class="mono">pipeline.jsonl</span>. This is not
    the same as a run that proposed nothing: that would be a row below.</p>`;
  }

  const sum = (pick: (r: ProjectedRun) => number): number =>
    runs.reduce((a, r) => a + pick(r), 0);
  const proposeRuns = runs.filter(r => r.stage === 'propose');
  const nothing = proposeRuns.filter(r => r.producedNothing).length;
  const failed = runs.filter(r => r.failed).length;
  const rotated = runs.filter(r => r.rotated).length;

  const stages = [
    { label: 'records read', n: sum(r => r.fresh),
      note: 'new decisions folded in since the last run' },
    { label: 'shapes', n: sum(r => r.shapes), note: 'distinct command shapes seen' },
    { label: 'clusters', n: sum(r => r.clusters),
      note: 'shapes grouped into a candidate rule' },
    { label: 'candidates considered', n: sum(r => r.considered),
      note: 'clusters that cleared the support floor and reached the gate' },
    { label: 'proposed', n: sum(r => r.proposed),
      note: 'clause files written at status: proposed — inert until a human accepts one' },
    { label: 'retirements proposed', n: sum(r => r.retired),
      note: 'clauses ablation showed were carrying nothing' },
  ];

  const refusals = new Map<string, number>();
  for (const r of runs) {
    for (const why of r.refusals) { refusals.set(why, (refusals.get(why) ?? 0) + 1); }
  }
  const maxRefusal = Math.max(1, ...refusals.values());
  const refusalRows = refusals.size === 0
    ? `<tr><td colspan="2">${NOT_RECORDED} — no candidate was refused in this window</td></tr>`
    : [...refusals.entries()].sort((a, b) => b[1] - a[1])
      .map(([why, n]) => `<tr><td class="mono">${escapeHtml(why)}</td>`
        + `${barCell(n, maxRefusal)}</tr>`).join('');

  const runRows = [...runs].reverse().map(r => {
    // An `accumulate` run folds new records and never proposes, so "0 proposed" would read as a
    // failure to propose rather than as a stage with nothing to propose from.
    const outcome = r.failed ? 'error'
      : r.stage === 'accumulate' ? `folded ${r.fresh} record(s)`
        : r.producedNothing ? 'produced nothing'
          : `${r.proposed} proposed`;
    return `<tr${r.producedNothing ? ' class="nothing"' : ''}>`
      + `<td class="mono">${cell(r.ts)}</td><td class="mono">${cell(r.stage)}</td>`
      + `<td class="mono">${cell(r.trigger)}</td><td class="mono">${cell(r.exitReason)}</td>`
      + `<td>${escapeHtml(outcome)}</td><td class="mono">${cell(r.fresh)}</td>`
      + `<td class="mono">${r.refusalCount === 0 ? '0' : escapeHtml(r.refusals.join(', '))}</td>`
      + `<td class="mono">${cell(r.durationMs)} ms</td></tr>`;
  }).join('');

  const modelCalls = sum(r => r.modelCalls);

  return `<p class="note">${runs.length} run(s), of which ${proposeRuns.length} reached the propose
stage. <strong>${nothing}</strong> ran every gate and correctly produced nothing &mdash; those rows
are the reason this section reads the run line rather than the surviving clause files, because a run
that proposes nothing leaves no file and no commit and is otherwise indistinguishable from a
scheduler that stopped firing. ${failed} ended in an error.
${rotated === 0 ? '' : `${rotated} run(s) saw a rotated trail, so their window is short by however
much rotation dropped.`}
The pipeline calls no model: <span class="mono">modelCalls</span> summed over every run above is
${modelCalls}, and a nonzero there would be a change of kind rather than of degree.</p>

${funnel(stages)}

<h3>What was refused, and why</h3>
<p class="note">A refusal is the pipeline declining to propose. Every code below is a designed
outcome, not a fault &mdash; <span class="mono">below-floor</span> means a shape has not earned a
rule yet, <span class="mono">contradicted</span> means a written practice already says otherwise.
Counted per run, so a cluster refused on five runs is five.</p>
<table>
<thead><tr><th>refusal</th><th>times</th></tr></thead>
<tbody>${refusalRows}</tbody>
</table>

<h3>Every run</h3>
<table>
<thead><tr><th>when</th><th>stage</th><th>trigger</th><th>exit</th><th>outcome</th>
<th>new records</th><th>refusals</th><th>took</th></tr></thead>
<tbody>${runRows}</tbody>
</table>`;
}

export function renderHtml(records: readonly DecisionRecord[], meta: HtmlMeta): string {
  const instants = records.map(r => r.ts).filter(Boolean).sort();
  const revs = [...new Set(records.map(r => r.rev ?? null))];
  const truncated = meta.total > records.length;

  const byRung = new Map<string, number>();
  const outcomeByDay = new Map<string, Map<string, number>>();
  const byClause = new Map<string, { count: number; last: string }>();
  const latencyByRung = new Map<string, number[]>();
  /** Per revision: model-tier decisions, and how many of them rewrote the cached prefix. */
  const byRev = new Map<string, { model: number; rewrites: number; created: number }>();
  let cacheRead = 0;
  let cacheCreation = 0;
  let uncached = 0;
  let modelRows = 0;
  let prefixRewrites = 0;

  for (const r of records) {
    const rung = rungOf(r);
    byRung.set(rung, (byRung.get(rung) ?? 0) + 1);
    const day = r.ts.slice(0, 10);
    const mix = outcomeByDay.get(day) ?? new Map<string, number>();
    const outcome = outcomeOf(r);
    mix.set(outcome, (mix.get(outcome) ?? 0) + 1);
    outcomeByDay.set(day, mix);
    if (typeof r.latencyMs === 'number') {
      const bucket = latencyByRung.get(rung) ?? [];
      bucket.push(r.latencyMs);
      latencyByRung.set(rung, bucket);
    }
    if (r.clause) {
      const seen = byClause.get(r.clause);
      byClause.set(r.clause, {
        count: (seen?.count ?? 0) + 1,
        last: !seen || r.ts > seen.last ? r.ts : seen.last,
      });
    }
    // Filter to `telemetry !== null` BEFORE any cache figure, and carry the surviving count as the
    // denominator. Rungs 1-5 call no model, so a null there is "no cache to hit" and emphatically
    // not a miss; an average over every decision reports a number nobody can interpret.
    if (r.telemetry) {
      modelRows++;
      cacheRead += r.telemetry.cache_read_input_tokens;
      cacheCreation += r.telemetry.cache_creation_input_tokens;
      uncached += r.telemetry.input_tokens;
      const rewrote = r.telemetry.cache_creation_input_tokens > 0;
      if (rewrote) { prefixRewrites++; }
      // Grouped by revision, because that is what makes the count actionable. A prefix rewrite is
      // expected once per revision — the first call after an artifact change pays for the write —
      // and a *pile* of them inside one revision is the cache regression, which no ratio shows.
      const rev = r.rev ?? 'unstamped';
      const bucket = byRev.get(rev) ?? { model: 0, rewrites: 0, created: 0 };
      bucket.model++;
      if (rewrote) { bucket.rewrites++; }
      bucket.created += r.telemetry.cache_creation_input_tokens;
      byRev.set(rev, bucket);
    }
  }

  const maxRung = Math.max(1, ...byRung.values());
  const rungRows = [...byRung.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([rung, count]) => {
      const p50 = quantile(latencyByRung.get(rung) ?? [], 0.5);
      const p95 = quantile(latencyByRung.get(rung) ?? [], 0.95);
      return `<tr><td class="mono">${cell(rung)}</td><td>${cell(RUNG_LABEL[rung])}</td>`
        + `${barCell(count, maxRung)}`
        + `<td>${p50 === null ? NOT_RECORDED : `${p50} ms`}</td>`
        + `<td>${p95 === null ? NOT_RECORDED : `${p95} ms`}</td></tr>`;
    }).join('');

  const maxClause = Math.max(1, ...[...byClause.values()].map(c => c.count));
  const clauseRows = byClause.size === 0
    ? `<tr><td colspan="3">${NOT_RECORDED} — no decision in this window cited a clause</td></tr>`
    : [...byClause.entries()].sort((a, b) => b[1].count - a[1].count)
      .map(([clause, c]) => `<tr><td>${cell(clause)}</td>${barCell(c.count, maxClause)}`
        + `<td class="mono">${cell(c.last)}</td></tr>`).join('');

  // Local records carry `inputSummary`; a team projection dropped it and carries `toolShape`. One
  // expression covers both, because the projection ran before this function did.
  const denials = records.filter(r => r.decision === 'deny' || r.rewritten).reverse();
  const denialRows = denials.length === 0
    ? `<tr><td colspan="4">${NOT_RECORDED} — nothing was denied or rewritten in this window</td></tr>`
    : denials.slice(0, DENIAL_ROWS).map(r => {
      const asked = r.inputSummary
        ?? (r as unknown as { toolShape?: string }).toolShape ?? r.tool;
      return `<tr><td class="mono">${cell(r.ts)}</td><td class="mono">${cell(rungOf(r))}</td>`
        + `<td class="mono">${cell(asked)}</td><td>${cell(r.clause)}</td></tr>`;
    }).join('');

  // Leads the cost section, not the ratio. A prefix rewrite is expected once per revision; a pile of
  // them inside one revision is the 6.8x regression, and averaging it into a hit-rate percentage is
  // exactly how that spike disappears.
  const maxRewrites = Math.max(1, ...[...byRev.values()].map(b => b.rewrites));
  const revRows = byRev.size === 0
    ? `<tr><td colspan="4">${NOT_RECORDED} — no decision in this window called a model</td></tr>`
    : [...byRev.entries()].sort((a, b) => b[1].rewrites - a[1].rewrites)
      .map(([rev, b]) => `<tr><td class="mono">${rev === 'unstamped'
        ? '<span class="none">unstamped</span>' : escapeHtml(rev)}</td>`
        + `${barCell(b.rewrites, maxRewrites)}<td class="mono">${b.model}</td>`
        + `<td class="mono">${b.created}</td></tr>`).join('');

  const promptTokens = cacheRead + cacheCreation + uncached;
  const cacheShare = modelRows > 0 && promptTokens > 0
    ? `cache read ${((cacheRead / promptTokens) * 100).toFixed(1)}% of prompt tokens`
    : null;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session Sitter decisions — snapshot</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Session Sitter decisions — snapshot</h1>
<div id="stale"></div>

<div class="band">
  <dl>
    <dt>generated</dt><dd class="mono" id="generated-at">${meta.generatedAt.toISOString()}</dd>
    <dt>window</dt><dd class="mono">${
  instants.length === 0 ? NOT_RECORDED
    : `${escapeHtml(instants[0])} → ${escapeHtml(instants[instants.length - 1])}`}</dd>
    <dt>records</dt><dd>${records.length}${
  truncated ? ` — <strong>truncated</strong> by --limit from ${meta.total} in the window` : ''}</dd>
    <dt>revisions</dt><dd class="mono">${revs.map(r => r === null || r === undefined
    ? '<span class="none">unstamped</span>' : escapeHtml(r)).join(', ')}</dd>
    <dt>scope</dt><dd>${meta.scope}</dd>
    <dt>produced by</dt><dd class="mono">session-sitter ${escapeHtml(BUILD_VERSION)} on ${
  escapeHtml(meta.host)}</dd>
  </dl>
  <p class="note">This file is frozen at the instant above. It cannot tail, query, roll up across
  machines, or alert — climb a tier for those. Every instant in it is absolute, on purpose.
  Regenerate it with:</p>
  <pre>${escapeHtml(meta.regenerateCommand)}</pre>
</div>

<h2>What is in force</h2>
${renderConfig(meta.config, meta.scope)}

<h2>The outcome mix, and whether its shape is changing</h2>
<p class="note">The count is elsewhere; this is about proportion. A deny band that steps up on one day
is a practices edit. A <span class="mono">fail closed</span> band appearing at all is a broken
artifact or loader, and it is the one series whose rise is unambiguously bad news — which is why it is
not merged into the denials it technically belongs to. Every column carries its exact counts, and the
tables below carry all of them as text, so no fact here depends on telling two colours apart.</p>
${outcomeChart(outcomeByDay)}

<h2>The ladder, and what each rung cost</h2>
<p class="note">The rung is derived from <span class="mono">(actor, decision)</span>, never stored.
Rung 1 deciding most calls is the system working; rung 7 climbing means a broken artifact or loader;
rung 6 is the only rung allowed to be slow, which is why the latency split is here and not merged.
A record written before the <span class="mono">correction</span> actor existed reports rung 2&#39; as
rung 3 and cannot be recovered — those two are only separable going forward.</p>
<table>
<thead><tr><th>rung</th><th>what decided</th><th>decisions</th><th>p50</th><th>p95</th></tr></thead>
<tbody>${rungRows}</tbody>
</table>

<h2>Which clauses fired</h2>
<p class="note">Hits only. A clause in the artifact that never fired has no row here — that join
needs the artifact, and <span class="mono">session-sitter policy</span> is where it lives.</p>
<table>
<thead><tr><th>clause</th><th>fired</th><th>last fired</th></tr></thead>
<tbody>${clauseRows}</tbody>
</table>

<h2>What the model rung cost</h2>
<p class="note">Every figure below is over the ${modelRows} decision(s) that called a model, of
${records.length} in the window. Rungs 1&ndash;5 call none, so they have no cache to hit and are not
a miss; a rate across all decisions does not exist and is not printed.</p>

<h3>Prefix rewrites, by revision &mdash; the number to read first</h3>
<p class="note">A rewrite is a decision whose
<span class="mono">cache_creation_input_tokens</span> was above zero: it paid to write the cached
prefix instead of reading it. <strong>One per revision is correct</strong> &mdash; the first call
after an artifact change pays for the write. Several inside a single revision means something is
mutating the prompt under the runtime, which is the 6.8&times; cost regression the whole pinning
design exists to prevent. It is a count and not a rate on purpose: a hit-rate percentage averages
that spike away, and the spike is the entire signal.</p>
<table>
<thead><tr><th>revision</th><th>prefix rewrites</th><th>model-tier decisions</th>
<th>tokens written</th></tr></thead>
<tbody>${revRows}</tbody>
</table>

<h3>The rest of it</h3>
<table>
<thead><tr><th>figure</th><th>value</th></tr></thead>
<tbody>
<tr><td>model-tier decisions</td><td>${modelRows === 0 ? NOT_RECORDED : modelRows}</td></tr>
<tr><td>prefix rewrites, all revisions</td>
<td>${modelRows === 0 ? NOT_RECORDED : prefixRewrites}</td></tr>
<tr><td>prompt tokens read from cache</td><td>${cacheShare === null ? NOT_RECORDED
    : escapeHtml(cacheShare)}</td></tr>
</tbody>
</table>
<p class="note">A partial hit is the normal case &mdash; the judging instruction rides a trailing user
turn after the cached prefix by design &mdash; so there is no hit/miss boolean, and the share above
is second to the count above it.</p>

<h2>The denials and rewrites, as a list</h2>
<p class="note">The newest ${Math.min(DENIAL_ROWS, denials.length)} of ${denials.length} in the
window. Nobody debugs a policy from a bar chart; they read the thing that got blocked. In the team
scope this shows the shape, because the projection already dropped the command line.</p>
<table>
<thead><tr><th>when</th><th>rung</th><th>what was asked</th><th>clause</th></tr></thead>
<tbody>${denialRows}</tbody>
</table>

<h2>The offline side &mdash; what <span class="mono">learn</span> did</h2>
${renderPipeline(meta.runs)}

<script>${AGE_SCRIPT}</script>
</body>
</html>
`;
}

// ── The command ─────────────────────────────────────────────────────────────

function parseScope(raw: string | undefined): Scope {
  if (raw === undefined || raw === 'local') { return 'local'; }
  if (raw === 'team') { return 'team'; }
  throw new CliError(`--scope must be local or team, got "${raw}"`);
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  const args = parseFlags(argv, EXPORT_SPEC);
  if (flagBool(args, '--help') || flagBool(args, '-h')) { io.out(HELP); return 0; }

  const wantJsonline = flagBool(args, '--jsonline');
  const wantHtml = flagBool(args, '--html');
  if (wantJsonline === wantHtml) {
    throw new CliError('export needs exactly one of --jsonline or --html');
  }

  const scope = parseScope(flagString(args, '--scope'));
  const sinceRaw = flagString(args, '--since');
  const since = sinceRaw === undefined ? null : parseSince(sinceRaw, io.now());
  const limit = flagNumber(args, '--limit') ?? DEFAULT_LIMIT;

  const file = decisionsPath();
  if (!fs.existsSync(file)) {
    throw new CliError(`no decision trail at ${file} — nothing has been governed on this machine`, 1);
  }

  const all = readJsonl<DecisionRecord>(file)
    .filter(r => typeof r?.ts === 'string')
    .filter(r => since === null || new Date(r.ts).getTime() >= since.getTime())
    .sort((a, b) => a.ts.localeCompare(b.ts));
  // Newest N: a window is truncated at its old end, because the recent one is the interesting one.
  const kept = all.slice(Math.max(0, all.length - limit));

  const key = scope === 'team' ? hmacKey() : null;
  const project = (r: DecisionRecord): Record<string, unknown> =>
    key === null ? (r as unknown as Record<string, unknown>) : projectTeam(r, key);
  // Local is the record as written, on the machine that wrote it, so the real name. Team is the same
  // per-machine HMAC the other pseudonyms use. One key, one code path, two values.
  const machine = key === null
    ? os.hostname()
    : createHmac('sha256', key).update(os.hostname(), 'utf8').digest('hex').slice(0, 16);

  // The offline side. Absent is normal and not an error: a machine that has never run `learn` has no
  // pipeline file, which is a true statement about it rather than a failure to read one.
  const runs = readJsonl<RunLine>(pipelinePath())
    .filter(r => typeof r?.ts === 'string')
    .filter(r => since === null || new Date(r.ts).getTime() >= since.getTime())
    .sort((a, b) => a.ts.localeCompare(b.ts));

  if (wantJsonline) {
    // `project` already stamps both on the team path; the local path is the record as written, so it
    // gets them here. Spread last so neither can be shadowed by a field of the same name on a
    // record from a future version.
    io.out(kept.map(r => `${JSON.stringify({ ...project(r), kind: 'decision', machine })}\n`)
      .join(''));
    // Both kinds down one pipe, so a reader ships the online and the offline story with one command
    // and `kind` tells them apart. Runs after decisions only so a single `curl` sees the smaller,
    // rarer shape last; nothing depends on the order.
    io.out(runs.map(r => `${JSON.stringify(projectRun(r, machine))}\n`).join(''));
    return 0;
  }

  const regenerate = ['session-sitter export --html', ...argv.filter(a => a !== '--html')]
    .join(' ') + ' > report.html';
  io.out(renderHtml(
    // The HTML applies the same projection, so a team snapshot is as safe to forward as a team
    // stream is to ship. One function decides which keys exist, in one place.
    kept.map(r => project(r) as unknown as DecisionRecord),
    {
      generatedAt: io.now(),
      scope,
      total: all.length,
      host: os.hostname(),
      regenerateCommand: regenerate,
      runs: runs.map(r => projectRun(r, machine)) as unknown as ProjectedRun[],
      config: await resolvedConfig(),
    },
  ));
  return 0;
}
