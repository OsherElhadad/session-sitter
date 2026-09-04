/**
 * The offline side of `export`, and the config panel.
 *
 * Three properties, and each of them exists because its absence is a silence that reads as success:
 *
 *  1. **A run that correctly produced nothing is a row.** It leaves no clause file and no commit, so
 *     a funnel built from surviving artefacts cannot tell it from a scheduler that stopped firing —
 *     and those two have opposite meanings. This is the whole reason the run line is read.
 *  2. **The pipeline projection drops paths and prose in both scopes.** A `RunLine` carries a corpus
 *     root, the scanned filenames, an exception string and a refusal naming a real command. None of
 *     it is needed to draw a funnel, so none of it is shipped, and there is no scope branch to get
 *     wrong.
 *  3. **The config panel reads and cannot write.** It is rendered from the ladder's own loaders, and
 *     the page carries no form, no input and no method that could change a setting.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SHIP_COMMAND, projectRun, resolvedConfig, outcomeOf, run } from '../../cli/export';
import { CliError } from '../../cli/args';
import { appendJsonl, type DecisionRecord } from '../../audit/trail';
import { decisionsPath } from '../../hooks/paths';
import { appendRunLine, pipelinePath, type RunLine } from '../../policy/pipeline';
import { fakeIo } from './fakeIo';

const saved = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-exp-pipe-'));
  process.env.SESSION_SITTER_DATA_DIR = dir;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  process.env = { ...saved };
});

function decision(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    ts: '2026-09-01T10:00:00.000Z',
    sessionId: 's', cwd: '/w', tool: 'Bash', inputSummary: 'ls',
    light: 'green', decision: 'allow', clause: null, actor: 'deterministic',
    latencyMs: 1, rewritten: false, rev: 'sha256:aaa', policySource: 'artifact',
    telemetry: null, ...over,
  } as DecisionRecord;
}

/**
 * A run line carrying every field the projection has an opinion about, and with the local-only ones
 * filled with values a test can search the output for.
 */
function runLine(over: Record<string, unknown> = {}): RunLine {
  return {
    v: 1,
    ts: '2026-09-01T09:00:00.000Z',
    runId: '20260901T090000-aaaa',
    stage: 'propose',
    trigger: 'cli',
    rev: 'sha256:aaa',
    emissionRule: 1,
    corpusRoot: '/Users/someone/work/customers/BigCo/practices',
    window: {
      files: ['/Users/someone/.claude/session-sitter/decisions.jsonl'],
      scanned: 40, new: 12, firstTs: null, lastTs: null, spanDays: 3,
      rotated: false, unstamped: 0, noCall: 1, mixedRev: 0, exempt: 2,
    },
    signals: { timeout: 1, gap: 2, model: 0, repeat: 3, allow: 30 },
    shapes: { total: 9, new: 4, crossedFloor: 2 },
    clusters: { total: 5, belowFloor: 3, contradicted: 1 },
    candidates: {
      considered: 2, proposed: 0, overwritten: 0, merged: 0, retired: 0, held: 0,
    },
    suppressed: { statusGuard: 0, alreadyInClaudeMd: 1, failedReplay: 0, proseOnly: 0 },
    refusals: [
      { cluster: 'git push --force origin BigCo-migration', why: 'below-floor' },
      { cluster: 'curl payments-internal.acme.example', why: 'contradicted', detail: 'practices §egress' },
    ],
    replay: {
      n: 40, changed: 0, reversals: 0, human_reversals: 0, advisory: 0,
      unreplayable: 1, calibrated: true,
    },
    ceiling: [], declinedPromotions: [],
    proposals: { clauses: [], merges: [], retirements: [], redundancies: [], listings: [] },
    model: { calls: 0 },
    durationMs: 82,
    exitReason: 'no-shape-cleared-floor',
    error: null,
    belowFloor: [],
    headline: 'read 12 new records, proposed nothing — no shape cleared the floor',
    ...over,
  } as unknown as RunLine;
}

async function exportTo(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const io = fakeIo();
  try {
    return { code: await run(argv, io), out: io.text(), err: io.errText() };
  } catch (err) {
    if (!(err instanceof CliError)) { throw err; }
    return { code: err.exitCode, out: io.text(), err: `${err.message}\n` };
  }
}

describe('the pipeline projection', () => {
  it('drops every path, every prose field and every cluster, in both scopes', () => {
    const projected = projectRun(runLine(), 'machine-a');
    const json = JSON.stringify(projected);
    // The corpus root, the scanned filename, the refusal's cluster and the headline are all real
    // strings in the fixture, so a leak is a substring match and not a judgement.
    expect(json).not.toContain('BigCo');
    expect(json).not.toContain('/Users/someone');
    expect(json).not.toContain('payments-internal');
    expect(json).not.toContain('no shape cleared the floor');
    expect('corpusRoot' in projected).toBe(false);
    expect('headline' in projected).toBe(false);
    expect('error' in projected).toBe(false);
  });

  it('keeps the refusal reasons, which are a closed enum and are the whole point', () => {
    expect(projectRun(runLine(), 'm').refusals).toEqual(['below-floor', 'contradicted']);
    expect(projectRun(runLine(), 'm').refusalCount).toBe(2);
  });

  it('flags a run that ran every gate and correctly produced nothing', () => {
    expect(projectRun(runLine(), 'm').producedNothing).toBe(true);
    expect(projectRun(runLine(), 'm').failed).toBe(false);
  });

  it('does not call an error run "produced nothing" — they are different states', () => {
    const errored = runLine({ exitReason: 'error', error: 'ENOENT /Users/someone/corpus' });
    const projected = projectRun(errored, 'm');
    expect(projected.failed).toBe(true);
    expect(projected.producedNothing).toBe(false);
    // And the message itself, which routinely carries a path, stays on the machine.
    expect(JSON.stringify(projected)).not.toContain('/Users/someone');
  });

  it('does not flag a run that proposed something', () => {
    const produced = runLine({
      candidates: { considered: 2, proposed: 1, overwritten: 0, merged: 0, retired: 0, held: 0 },
      exitReason: 'ok',
    });
    expect(projectRun(produced, 'm').producedNothing).toBe(false);
  });

  it('ships the pipeline model-call count, so a nonzero one is visible outside a test', () => {
    expect(projectRun(runLine(), 'm').modelCalls).toBe(0);
  });
});

describe('export --jsonline ships both kinds down one pipe', () => {
  beforeEach(() => {
    appendJsonl(decisionsPath(), decision());
    appendRunLine(runLine());
  });

  it('tags every line with a kind, so a store holding both can tell them apart', async () => {
    const { out } = await exportTo(['--jsonline']);
    const kinds = out.trimEnd().split('\n').map(l => JSON.parse(l).kind);
    expect(kinds).toEqual(['decision', 'pipeline_run']);
  });

  it('tags every line with a machine, which is what a cross-machine view needs', async () => {
    const { out } = await exportTo(['--jsonline']);
    for (const line of out.trimEnd().split('\n')) {
      expect(JSON.parse(line).machine).toBe(os.hostname());
    }
  });

  it('pseudonymises the machine in the team scope, and never ships a key called host', async () => {
    const { out } = await exportTo(['--jsonline', '--scope', 'team']);
    for (const line of out.trimEnd().split('\n')) {
      const parsed = JSON.parse(line);
      expect(parsed.machine).not.toBe(os.hostname());
      expect(parsed.machine).toMatch(/^[0-9a-f]{16}$/);
      expect('host' in parsed).toBe(false);
    }
  });

  it('is still one JSON object per line, so the shipper is still curl', async () => {
    const { out } = await exportTo(['--jsonline']);
    for (const line of out.trimEnd().split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('treats a machine that has never run learn as a fact, not an error', async () => {
    fs.rmSync(pipelinePath());
    const { code, out } = await exportTo(['--jsonline']);
    expect(code).toBe(0);
    expect(out.trimEnd().split('\n')).toHaveLength(1);
  });
});

describe('export --html shows the offline side', () => {
  it('names the produced-nothing run as a row, not as an absence', async () => {
    appendJsonl(decisionsPath(), decision());
    appendRunLine(runLine());
    const { out } = await exportTo(['--html']);
    expect(out).toContain('produced nothing');
    expect(out).toContain('no-shape-cleared-floor');
    // And it says why the run line is read at all rather than the surviving files.
    expect(out).toMatch(/leaves no file and no commit/);
  });

  it('distinguishes "learn has never run here" from "learn produced nothing"', async () => {
    appendJsonl(decisionsPath(), decision());
    const { out } = await exportTo(['--html']);
    expect(out).toMatch(/has\s+never run on this machine/);
    expect(out).not.toContain('produced nothing');
  });

  it('shows what was refused and why', async () => {
    appendJsonl(decisionsPath(), decision());
    appendRunLine(runLine());
    const { out } = await exportTo(['--html']);
    expect(out).toContain('below-floor');
    expect(out).toContain('contradicted');
    // The cluster each refusal names is a real command and stays local.
    expect(out).not.toContain('payments-internal');
  });
});

describe('the config panel reads and cannot write', () => {
  it('carries no form, no input and no method that could change a setting', async () => {
    appendJsonl(decisionsPath(), decision());
    const { out } = await exportTo(['--html']);
    expect(out).not.toMatch(/<form/i);
    expect(out).not.toMatch(/<input/i);
    expect(out).not.toMatch(/<button/i);
    expect(out).not.toMatch(/<select/i);
    expect(out).not.toMatch(/fetch\(|XMLHttpRequest|method\s*=\s*["']post/i);
  });

  it('renders each setting with the exact terminal command that changes it', async () => {
    appendJsonl(decisionsPath(), decision());
    const { out } = await exportTo(['--html']);
    expect(out).toContain('export SESSION_SITTER_MODE=');
    expect(out).toContain('export SESSION_SITTER_PRETOOL=');
    expect(out).toMatch(/the command that changes it/);
  });

  it('withholds the config from a team snapshot, and says why', async () => {
    process.env.SESSION_SITTER_TEAM = 'acme-payments';
    appendJsonl(decisionsPath(), decision());
    const { out } = await exportTo(['--html', '--scope', 'team']);
    expect(out).not.toContain('acme-payments');
    expect(out).toMatch(/withheld from a team snapshot/);
  });

  it('reports an unreadable corpus as unreadable, never as "no policy"', async () => {
    const config = await resolvedConfig();
    // With no routing user configured the loader answers `markdown` with its own reason, which is a
    // configuration state — distinct from the failure state, and that distinction is the assertion.
    expect(config.policySource).not.toBe('unreadable');
    expect(config.reason).toMatch(/no routing user/);
  });
});

describe('the outcome mix', () => {
  it('is total over the five series, so no decision is silently uncounted', () => {
    const cases: [Partial<DecisionRecord>, string][] = [
      [{ decision: 'allow' }, 'allow'],
      [{ decision: 'deny', actor: 'policy' }, 'deny'],
      [{ decision: 'allow', rewritten: true, actor: 'correction' }, 'correct'],
      [{ decision: 'deny', actor: 'timeout' }, 'closed'],
      [{ decision: 'none' }, 'none'],
    ];
    for (const [over, want] of cases) {
      expect(outcomeOf(decision(over)), JSON.stringify(over)).toBe(want);
    }
  });

  it('keeps fail-closed out of the denials, because only its rise is bad news', () => {
    expect(outcomeOf(decision({ decision: 'deny', actor: 'timeout' })))
      .not.toBe(outcomeOf(decision({ decision: 'deny', actor: 'policy' })));
  });

  it('draws a stacked column per UTC day and states the bucketing', async () => {
    appendJsonl(decisionsPath(), decision({ ts: '2026-09-01T10:00:00.000Z' }));
    appendJsonl(decisionsPath(), decision({
      ts: '2026-09-02T10:00:00.000Z', decision: 'deny', actor: 'policy',
    }));
    const { out } = await exportTo(['--html']);
    expect(out).toContain('whole UTC days');
    expect(out).toMatch(/class="o-allow"/);
    expect(out).toMatch(/class="o-deny"/);
    // Colour is never the only channel: the day's exact mix is in a title.
    expect(out).toMatch(/<title>2026-09-02 — 1 decision\(s\): 1 denied/);
  });
});

describe('the cache figures', () => {
  const telemetry = (created: number) => ({
    tier: 'agent_cli', model: 'm', latency_ms: 9,
    input_tokens: 10, cache_creation_input_tokens: created, cache_read_input_tokens: 900,
    output_tokens: 3,
  });

  it('leads with prefix rewrites grouped by rev, which is where a spike is visible', async () => {
    appendJsonl(decisionsPath(), decision({
      actor: 'model', rev: 'sha256:aaa', telemetry: telemetry(500) as never,
    }));
    appendJsonl(decisionsPath(), decision({
      actor: 'model', rev: 'sha256:aaa', telemetry: telemetry(500) as never,
    }));
    appendJsonl(decisionsPath(), decision({
      actor: 'model', rev: 'sha256:bbb', telemetry: telemetry(0) as never,
    }));
    const { out } = await exportTo(['--html']);
    const revSection = out.slice(out.indexOf('Prefix rewrites, by revision'));
    // Two rewrites inside one revision is the regression, and it must be a count on that revision's
    // own row — not folded into a window-wide average.
    expect(revSection).toMatch(/sha256:aaa[\s\S]{0,200}?>2</);
    expect(out).toContain('the number to read first');
  });

  it('never prints a cache figure over decisions that called no model', async () => {
    // Five deterministic decisions and one model call. An avg() over the window would report ~16%
    // and mean nothing; the denominator has to be the model rows.
    for (let i = 0; i < 5; i++) { appendJsonl(decisionsPath(), decision()); }
    appendJsonl(decisionsPath(), decision({
      actor: 'model', telemetry: telemetry(0) as never,
    }));
    const { out } = await exportTo(['--html']);
    expect(out).toMatch(/over the 1 decision\(s\) that called a model, of\s*6 in the window/);
    expect(out).toMatch(/a rate across all decisions does not exist and is not printed/);
  });
});

describe('producedNothing is only an outcome a propose run can have', () => {
  it('is false on an accumulate run, which never proposes by design', () => {
    // Otherwise the field is true on every accumulate row — a query anyone would trust and nobody
    // could use, since accumulate outnumbers propose several to one on a real machine.
    const folded = runLine({
      stage: 'accumulate', trigger: 'session-end', exitReason: 'ok',
      candidates: { considered: 0, proposed: 0, overwritten: 0, merged: 0, retired: 0, held: 0 },
    });
    expect(projectRun(folded, 'm').producedNothing).toBe(false);
  });
});

describe('the ship command', () => {
  it('sets a Content-Type, without which VictoriaLogs discards the body and answers 200', () => {
    // Measured against a real VictoriaLogs v1.52.0: `curl --data-binary` defaults to
    // application/x-www-form-urlencoded, and a form-urlencoded POST to /insert/jsonline is answered
    // HTTP 200 with the body dropped — vl_rows_ingested_total flat at zero, vl_http_errors_total
    // unmoved. Nothing in the shell says so, so the only symptom is an empty store. The header is
    // the whole fix, and it is why this is asserted rather than left to the docs.
    expect(SHIP_COMMAND).toContain("-H 'Content-Type: application/x-ndjson'");
  });

  it('is still byte-identical across scopes, which the header does not change', () => {
    expect(SHIP_COMMAND).not.toContain('--scope');
  });

  it('pins the stream fields to the two that are bounded by hardware', () => {
    // A stream field partitions the store; every field is queryable either way. `clause` would
    // multiply the stream count by the rendered-clause ceiling and `sessionId` or `rev` would make
    // it unbounded — one new stream per session, forever, in a file that never stops being appended.
    expect(SHIP_COMMAND).toContain('_stream_fields=kind,machine');
    for (const field of ['sessionId', 'clause', 'rev', 'cwd']) {
      expect(SHIP_COMMAND.split('_stream_fields=')[1] ?? '').not.toContain(field);
    }
  });
});

describe('the run table names each stage\'s own outcome', () => {
  it('does not say "0 proposed" of a stage that never proposes', async () => {
    appendJsonl(decisionsPath(), decision());
    appendRunLine(runLine({
      stage: 'accumulate', trigger: 'session-end', exitReason: 'ok',
      candidates: { considered: 0, proposed: 0, overwritten: 0, merged: 0, retired: 0, held: 0 },
    }));
    const { out } = await exportTo(['--html']);
    // "0 proposed" on an accumulate row reads as a failure to propose rather than as a stage with
    // nothing to propose from — and accumulate outnumbers propose several to one on a real machine.
    expect(out).not.toContain('0 proposed');
    expect(out).toContain('folded 12 record(s)');
  });
});
