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
 */
export const SHIP_COMMAND =
  'session-sitter export --jsonline --since 7d \\\n'
  + '  | curl -s -X POST --data-binary @- \\\n'
  + "    '127.0.0.1:9428/insert/jsonline"
  + "?_time_field=ts&_msg_field=note,inputSummary&_stream_fields=tool,actor'";

/**
 * The keys a team payload carries. An allow-list, so a field added to `DecisionRecord` later is
 * dropped by default rather than shipped by default — the direction that fails safe.
 */
export const TEAM_FIELDS: readonly string[] = [
  'ts', 'latencyMs', 'tool', 'decision', 'light', 'actor', 'rewritten', 'clause', 'rev',
  'policySource', 'telemetry', 'sessionId', 'cwd', 'toolShape', 'inputFingerprint',
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

/** Per-day decision counts as one inline `<svg>` — the only chart, and it ships in the file. */
function sparkline(byDay: Map<string, number>): string {
  const days = [...byDay.keys()].sort();
  if (days.length < 2) { return `<p class="none">not recorded — one day of records or fewer</p>`; }
  const max = Math.max(...byDay.values());
  const w = 8;
  const bars = days.map((day, i) => {
    const h = Math.max(1, Math.round((byDay.get(day)! / max) * 60));
    return `<rect x="${i * (w + 2)}" y="${60 - h}" width="${w}" height="${h}">`
      + `<title>${escapeHtml(day)}: ${byDay.get(day)}</title></rect>`;
  }).join('');
  return `<svg class="spark" viewBox="0 0 ${days.length * (w + 2)} 60" height="60" `
    + `role="img" aria-label="decisions per day">${bars}</svg>`
    + `<p class="axis">${escapeHtml(days[0])} → ${escapeHtml(days[days.length - 1])}`
    + ` · tallest bar ${max}</p>`;
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
code, pre, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
#stale { display: none; background: var(--warnbg); color: var(--warn); border-radius: 6px;
  padding: .7rem 1rem; margin: 0 0 1rem; font-weight: 600; }
.spark rect { fill: var(--bar); }
p.axis { color: var(--dim); margin: .2rem 0 0; font-size: .85rem; }
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
}

export function renderHtml(records: readonly DecisionRecord[], meta: HtmlMeta): string {
  const instants = records.map(r => r.ts).filter(Boolean).sort();
  const revs = [...new Set(records.map(r => r.rev ?? null))];
  const truncated = meta.total > records.length;

  const byRung = new Map<string, number>();
  const byDay = new Map<string, number>();
  const byClause = new Map<string, { count: number; last: string }>();
  const latencyByRung = new Map<string, number[]>();
  let cacheRead = 0;
  let cacheCreation = 0;
  let uncached = 0;
  let modelRows = 0;
  let prefixRewrites = 0;

  for (const r of records) {
    const rung = rungOf(r);
    byRung.set(rung, (byRung.get(rung) ?? 0) + 1);
    byDay.set(r.ts.slice(0, 10), (byDay.get(r.ts.slice(0, 10)) ?? 0) + 1);
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
      if (r.telemetry.cache_creation_input_tokens > 0) { prefixRewrites++; }
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

<h2>Decisions per day</h2>
${sparkline(byDay)}

<h2>What the model rung cost</h2>
<p class="note">Every figure below is over the ${modelRows} decision(s) that called a model, of
${records.length} in the window. Rungs 1&ndash;5 call none, so they have no cache to hit and are not
a miss; a rate across all decisions does not exist and is not printed.</p>
<table>
<thead><tr><th>figure</th><th>value</th></tr></thead>
<tbody>
<tr><td>model-tier decisions</td><td>${modelRows === 0 ? NOT_RECORDED : modelRows}</td></tr>
<tr><td>prefix rewrites (<span class="mono">cache_creation_input_tokens &gt; 0</span>)</td>
<td>${modelRows === 0 ? NOT_RECORDED : prefixRewrites}</td></tr>
<tr><td>prompt tokens read from cache</td><td>${cacheShare === null ? NOT_RECORDED
    : escapeHtml(cacheShare)}</td></tr>
</tbody>
</table>
<p class="note">A partial hit is the normal case — the judging instruction rides a trailing user turn
after the cached prefix by design — so there is no hit/miss boolean. The number worth watching is the
prefix-rewrite count inside one revision: a spike there is the cache regression.</p>

<h2>The denials and rewrites, as a list</h2>
<p class="note">The newest ${Math.min(DENIAL_ROWS, denials.length)} of ${denials.length} in the
window. Nobody debugs a policy from a bar chart; they read the thing that got blocked. In the team
scope this shows the shape, because the projection already dropped the command line.</p>
<table>
<thead><tr><th>when</th><th>rung</th><th>what was asked</th><th>clause</th></tr></thead>
<tbody>${denialRows}</tbody>
</table>

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

  if (wantJsonline) {
    io.out(kept.map(r => `${JSON.stringify(project(r))}\n`).join(''));
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
    },
  ));
  return 0;
}
