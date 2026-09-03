import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AUDIT_FILE, auditToDecision, filterDecisions, isCorrection, isDenial, readAuditTrail,
  readDecisions, readSupervisionRecords, resolveState, type AuditRecord, type Decision,
} from '../../cli/audit';

// Fixtures rather than a real state dir: these tests must pass on a machine that has never run the
// supervisor, and must not depend on what a machine that has happens to contain.
let stateDir: string;

async function writeAudit(records: Array<AuditRecord | string>): Promise<void> {
  const lines = records.map(r => (typeof r === 'string' ? r : JSON.stringify(r)));
  await fs.promises.writeFile(path.join(stateDir, AUDIT_FILE), `${lines.join('\n')}\n`, 'utf8');
}

async function writeRecord(name: string, record: object): Promise<void> {
  await fs.promises.mkdir(path.join(stateDir, 'records'), { recursive: true });
  await fs.promises.writeFile(
    path.join(stateDir, 'records', name), JSON.stringify(record), 'utf8');
}

const CORRECTION: AuditRecord = {
  v: 1,
  at: '2026-08-31T21:04:11.000Z',
  via: 'hook',
  session_id: 's-1',
  session_name: 'nightly bump',
  host: 'buildbox',
  agent: 'claude',
  tool: 'Bash',
  outcome: 'correct',
  light: 'yellow',
  actor: 'rule',
  clause: { id: 'practices§4', text: 'never force-push to a shared branch' },
  original_input: { command: 'git push --force' },
  updated_input: { command: 'git push --force-with-lease' },
  latency_ms: 7,
  reason: 'rewritten to --force-with-lease',
  ask: 'bump the pinned deps',
  cost_usd: 0.0012,
};

beforeEach(async () => {
  stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ss-audit-'));
});

afterEach(async () => {
  await fs.promises.rm(stateDir, { recursive: true, force: true });
});

describe('auditToDecision', () => {
  it('carries every field the writer recorded', () => {
    const d = auditToDecision(CORRECTION, 'audit.jsonl:1');
    expect(d).toMatchObject({
      from: 'audit',
      id: 'audit.jsonl:1',
      sessionId: 's-1',
      sessionName: 'nightly bump',
      host: 'buildbox',
      agent: 'claude',
      tool: 'Bash',
      light: 'yellow',
      outcome: 'correct',
      actor: 'rule',
      clauseId: 'practices§4',
      clauseText: 'never force-push to a shared branch',
      rewritten: true,
      latencyMs: 7,
      costUsd: 0.0012,
    });
    expect(d.at.toISOString()).toBe('2026-08-31T21:04:11.000Z');
    // The original is what a replay has to re-decide, so it wins over the rewrite.
    expect(d.input).toEqual({ command: 'git push --force' });
  });

  it('leaves an unrecorded field empty rather than filling it in', () => {
    const d = auditToDecision({ at: '2026-08-31T21:04:11.000Z' }, 'x');
    expect(d.tool).toBe('');
    expect(d.clauseId).toBe('');
    expect(d.actor).toBe('');
    expect(d.latencyMs).toBeNull();
    expect(d.costUsd).toBeNull();
    expect(d.input).toBeUndefined();
    expect(d.rewritten).toBe(false);
  });

  it('reads a light as an outcome only for the unambiguous pair', () => {
    const at = '2026-08-31T21:04:11.000Z';
    expect(auditToDecision({ at, light: 'red' }, 'x').outcome).toBe('deny');
    expect(auditToDecision({ at, light: 'green' }, 'x').outcome).toBe('allow');
    // Yellow and orange do not say by themselves what happened, so nothing is inferred.
    expect(auditToDecision({ at, light: 'yellow' }, 'x').outcome).toBe('unknown');
    expect(auditToDecision({ at, light: 'orange' }, 'x').outcome).toBe('unknown');
  });

  it('does not invent an outcome it does not recognise', () => {
    expect(auditToDecision({ at: '2026-08-31T21:04:11.000Z', outcome: 'shrug' }, 'x').outcome)
      .toBe('unknown');
  });

  it('falls back to the session id when no name was recorded', () => {
    expect(auditToDecision({ at: '2026-08-31T21:04:11.000Z', session_id: 's-9' }, 'x').sessionName)
      .toBe('s-9');
  });
});

describe('readAuditTrail', () => {
  it('is empty, not an error, when nothing has been decided yet', async () => {
    expect(await readAuditTrail(stateDir)).toEqual([]);
    expect(await readAuditTrail(path.join(stateDir, 'nowhere'))).toEqual([]);
  });

  it('skips a half-written line and keeps the rest of the trail', async () => {
    // A crash mid-write must not make the log unqueryable in the situation you most need it.
    await writeAudit([CORRECTION, '{"at":"2026-08-31T21:', { ...CORRECTION, tool: 'Read' }]);
    const decisions = await readAuditTrail(stateDir);
    expect(decisions.map(d => d.tool)).toEqual(['Bash', 'Read']);
  });

  it('skips a line with no usable timestamp', async () => {
    await writeAudit([
      { tool: 'Bash' } as unknown as AuditRecord,
      { at: 'not a date', tool: 'Read' },
      CORRECTION,
    ]);
    expect((await readAuditTrail(stateDir)).map(d => d.tool)).toEqual(['Bash']);
  });

  it('numbers each decision by its line, so a record traces back to the file', async () => {
    await writeAudit([CORRECTION, CORRECTION]);
    expect((await readAuditTrail(stateDir)).map(d => d.id))
      .toEqual(['audit.jsonl:1', 'audit.jsonl:2']);
  });
});

describe('readSupervisionRecords', () => {
  it('reads a blocked record as a denial, with no clause claimed', async () => {
    await writeRecord('req-aaa.json', {
      request_id: 'req-aaa',
      session_id: 's-legacy',
      session_name: 'supervised task',
      host: 'buildbox.example.com',
      source: 'bob',
      state: 'red_blocked',
      decided_by: 'supervisor',
      assessment: {
        traffic_light: 'red',
        summary: 'tried to delete the workspace',
        user_intent: 'clean the build output',
      },
      events: [{ type: 'red_blocked', at: '2026-08-31T20:00:05Z' }],
    });
    const [d] = await readSupervisionRecords(stateDir);
    expect(d).toMatchObject({
      from: 'supervision',
      id: 'req-aaa',
      sessionId: 's-legacy',
      light: 'red',
      outcome: 'deny',
      // 'supervisor' in a record, 'classifier' in the audit trail — one vocabulary for the reader.
      actor: 'classifier',
      agent: 'bob',
      ask: 'clean the build output',
      // These records predate clause citation, and the gap stays visible instead of being papered.
      clauseId: '',
      costUsd: null,
      latencyMs: null,
    });
    expect(d.host).toBe('buildbox');
  });

  it('reads a rule decision by what the rule did, which the state alone cannot say', async () => {
    await writeRecord('req-allow.json', {
      request_id: 'req-allow',
      session_id: 's-legacy',
      state: 'rule_applied',
      decided_by: 'rule',
      rule: { kind: 'approval', pattern: 'Read *', decision: 'approveOnce', tool_name: 'Read' },
      events: [{ type: 'rule_applied', at: '2026-08-31T20:04:00Z' }],
    });
    await writeRecord('req-deny.json', {
      request_id: 'req-deny',
      session_id: 's-legacy',
      state: 'rule_applied',
      decided_by: 'rule',
      rule: { kind: 'approval', pattern: 'Bash *', decision: 'reject', tool_name: 'Bash' },
      events: [{ type: 'rule_applied', at: '2026-08-31T20:05:00Z' }],
    });
    const byId = new Map((await readSupervisionRecords(stateDir)).map(d => [d.id, d]));
    expect(byId.get('req-allow')?.outcome).toBe('allow');
    expect(byId.get('req-allow')?.tool).toBe('Read');
    expect(byId.get('req-deny')?.outcome).toBe('deny');
  });

  it('reads a timed-out countdown as a denial — silence is never approval', async () => {
    await writeRecord('req-timeout.json', {
      request_id: 'req-timeout',
      session_id: 's-legacy',
      state: 'orange_timed_out',
      decided_by: 'supervisor',
      assessment: { traffic_light: 'orange' },
      events: [{ type: 'orange_timed_out', at: '2026-08-31T20:40:00Z' }],
    });
    const [d] = await readSupervisionRecords(stateDir);
    expect(d.outcome).toBe('timeout');
    expect(isDenial(d)).toBe(true);
  });

  it('is empty when the directory does not exist, and skips a corrupt record', async () => {
    expect(await readSupervisionRecords(stateDir)).toEqual([]);
    await fs.promises.mkdir(path.join(stateDir, 'records'), { recursive: true });
    await fs.promises.writeFile(path.join(stateDir, 'records', 'req-bad.json'), '{not json', 'utf8');
    expect(await readSupervisionRecords(stateDir)).toEqual([]);
  });

  it('ignores files that are not records', async () => {
    await writeRecord('_consumed_updates.json', ['1', '2']);
    expect(await readSupervisionRecords(stateDir)).toEqual([]);
  });
});

describe('readDecisions', () => {
  it('merges both writers into one chronological list', async () => {
    await writeAudit([{ ...CORRECTION, at: '2026-08-31T22:00:00.000Z' }]);
    await writeRecord('req-early.json', {
      request_id: 'req-early',
      session_id: 's-legacy',
      state: 'green_completed',
      decided_by: 'supervisor',
      assessment: { traffic_light: 'green' },
      events: [{ type: 'green_completed', at: '2026-08-31T20:00:00Z' }],
    });
    const decisions = await readDecisions(stateDir);
    expect(decisions.map(d => d.from)).toEqual(['supervision', 'audit']);
  });
});

describe('filterDecisions', () => {
  const at = (iso: string): Date => new Date(iso);
  const base: Decision = {
    from: 'audit', id: 'x', at: at('2026-08-31T21:00:00Z'), sessionId: 's-1', sessionName: 's-1',
    host: 'h', agent: 'claude', tool: 'Bash', light: 'green', outcome: 'allow', actor: 'rule',
    clauseId: '', clauseText: '', rewritten: false, reason: '', ask: '', latencyMs: null,
    costUsd: null,
  };
  const decisions: Decision[] = [
    base,
    { ...base, id: 'deny', outcome: 'deny', light: 'red' },
    { ...base, id: 'timeout', outcome: 'timeout' },
    { ...base, id: 'correct', outcome: 'correct' },
    { ...base, id: 'rewrite', rewritten: true },
    { ...base, id: 'other-session', sessionId: 's-2' },
    { ...base, id: 'other-tool', tool: 'Write' },
    { ...base, id: 'late', at: at('2026-09-01T09:00:00Z') },
  ];

  it('counts a timeout as denied — the countdown expiring is a block', () => {
    expect(filterDecisions(decisions, { denied: true }).map(d => d.id))
      .toEqual(['deny', 'timeout']);
  });

  it('counts a rewritten input as corrected even when the outcome does not say so', () => {
    expect(filterDecisions(decisions, { corrected: true }).map(d => d.id))
      .toEqual(['correct', 'rewrite']);
  });

  it('filters by session, by tool (case-insensitively) and by window', () => {
    expect(filterDecisions(decisions, { sessionId: 's-2' }).map(d => d.id)).toEqual(['other-session']);
    expect(filterDecisions(decisions, { tool: 'write' }).map(d => d.id)).toEqual(['other-tool']);
    expect(filterDecisions(decisions, { since: at('2026-09-01T00:00:00Z') }).map(d => d.id))
      .toEqual(['late']);
    expect(filterDecisions(decisions, { until: at('2026-08-31T22:00:00Z') })).toHaveLength(7);
  });

  it('combines filters as an AND', () => {
    expect(filterDecisions(decisions, { denied: true, tool: 'Write' })).toEqual([]);
  });

  it('is the identity with no filter at all', () => {
    expect(filterDecisions(decisions, {})).toHaveLength(decisions.length);
  });
});

describe('isCorrection and isDenial', () => {
  const base = { rewritten: false } as Decision;
  it('name the two lanes the audit trail exists to distinguish', () => {
    expect(isCorrection({ ...base, outcome: 'correct' })).toBe(true);
    expect(isCorrection({ ...base, outcome: 'allow', rewritten: true })).toBe(true);
    expect(isCorrection({ ...base, outcome: 'allow' })).toBe(false);
    expect(isDenial({ ...base, outcome: 'deny' })).toBe(true);
    expect(isDenial({ ...base, outcome: 'escalate' })).toBe(false);
  });

  it('keys on the rewrite, not on the actor, so the new `correction` actor cannot widen it', () => {
    // Rung 2' — the correction lane's rewrite was REJECTED by a red clause — reports
    // `actor: 'correction'` but no rewrite ever ran, so it must stay out of `log --corrected`.
    // The guard is that `isCorrection` reads `outcome`/`rewritten` and never `actor`.
    expect(isCorrection({ ...base, actor: 'correction', outcome: 'deny' })).toBe(false);
    expect(isCorrection({ ...base, actor: 'correction', outcome: 'allow', rewritten: true }))
      .toBe(true);
    // And an actor value the reader has never seen still flows through as itself, because nothing
    // switches exhaustively on it — `actor` is typed as a plain string on both the record and the
    // reader's own view.
    expect(auditToDecision({ at: '2026-08-31T21:00:00Z', actor: 'correction' }, 'x').actor)
      .toBe('correction');
  });
});

describe('resolveState', () => {
  it('honours an explicit directory even when it is empty', () => {
    const resolved = resolveState(path.join(stateDir, 'elsewhere'));
    expect(resolved.dir).toBe(path.join(stateDir, 'elsewhere'));
    expect(resolved.populated).toBe(false);
    expect(resolved.searched).toEqual([resolved.dir]);
  });

  it('reports an explicit directory that does hold a trail as populated', async () => {
    await writeAudit([CORRECTION]);
    expect(resolveState(stateDir).populated).toBe(true);
  });

  it('finds the state dir under a working directory, and lists where it looked', async () => {
    const repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ss-repo-'));
    try {
      await fs.promises.mkdir(path.join(repo, '.supervisor-state', 'records'), { recursive: true });
      const resolved = resolveState(undefined, repo);
      expect(resolved.populated).toBe(true);
      expect(resolved.dir).toBe(path.join(repo, '.supervisor-state'));

      const missing = resolveState(undefined, path.join(repo, 'no-such-repo'));
      expect(missing.populated).toBe(false);
      // Saying "nothing" without saying "nothing, here" sends people hunting a bug that is a path.
      expect(missing.searched.length).toBeGreaterThan(1);
    } finally {
      await fs.promises.rm(repo, { recursive: true, force: true });
    }
  });
});
