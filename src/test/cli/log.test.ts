import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Decision } from '../../cli/audit';
import {
  CSV_HEADER, applyLimit, clauseOf, csvCell, decisionJson, renderCsv, renderText, run,
} from '../../cli/log';
import { fakeIo } from './fakeIo';

const NOW = new Date('2026-09-01T09:00:00.000Z');

function decision(over: Partial<Decision> = {}): Decision {
  return {
    from: 'audit',
    id: 'audit.jsonl:1',
    at: new Date('2026-08-31T21:04:11.000Z'),
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
    reason: 'rewritten to --force-with-lease',
    ask: 'bump the pinned deps',
    latencyMs: 7,
    costUsd: 0.0012,
    ...over,
  };
}

describe('clauseOf', () => {
  it('leads with the citable id, which is the whole product claim in one column', () => {
    expect(clauseOf(decision())).toBe('practices§4: never force-push to a shared branch');
  });

  it('prints a partial citation rather than none', () => {
    expect(clauseOf(decision({ clauseText: '' }))).toBe('practices§4');
    expect(clauseOf(decision({ clauseId: '' }))).toBe('never force-push to a shared branch');
    expect(clauseOf(decision({ clauseId: '', clauseText: '' }))).toBe('');
  });
});

describe('applyLimit', () => {
  const decisions = [1, 2, 3, 4, 5].map(n => decision({ id: String(n) }));

  it('keeps the most recent N, still in chronological order', () => {
    expect(applyLimit(decisions, 2).map(d => d.id)).toEqual(['4', '5']);
  });

  it('0 means no limit', () => {
    expect(applyLimit(decisions, 0)).toHaveLength(5);
  });

  it('never mutates its input', () => {
    applyLimit(decisions, 2);
    expect(decisions).toHaveLength(5);
  });
});

describe('renderText', () => {
  it('says "not recorded" where the writer recorded nothing, and never a zero', () => {
    const io = fakeIo({ now: NOW });
    const out = renderText([decision({ tool: '', clauseId: '', clauseText: '', actor: '', light: '' })], io);
    expect(out.match(/not recorded/g)).toHaveLength(4); // light, tool, clause, actor
    expect(out).not.toContain('undefined');
    expect(out).not.toContain('null');
  });

  it('marks the correction lane distinctly from an untouched call', () => {
    const io = fakeIo({ now: NOW });
    expect(renderText([decision()], io)).toContain('rewritten');
    expect(renderText([decision({ rewritten: false, outcome: 'allow' })], io)).toContain('as written');
  });

  it('emits no escapes into a pipe', () => {
    const io = fakeIo({ now: NOW });
    // eslint-disable-next-line no-control-regex
    expect(renderText([decision()], io)).not.toMatch(/\u001b\[/);
  });

  it('is empty for no decisions, so a caller can print its own message', () => {
    expect(renderText([], fakeIo({ now: NOW }))).toBe('');
  });
});

describe('csvCell', () => {
  it('quotes only what needs quoting, doubling embedded quotes', () => {
    expect(csvCell('Bash')).toBe('Bash');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
  });
});

describe('renderCsv', () => {
  it('writes the documented header and one row per decision', () => {
    const csv = renderCsv([decision()]).trim().split('\n');
    expect(csv[0]).toBe(CSV_HEADER.join(','));
    expect(csv[1]).toContain('2026-08-31T21:04:11.000Z');
    expect(csv[1]).toContain('practices§4');
    expect(csv[1]).toContain('true');
  });

  it('leaves an unrecorded number empty rather than writing 0', () => {
    // A spreadsheet that reads a missing cost as zero would under-report it in every total.
    const row = renderCsv([decision({ latencyMs: null, costUsd: null })]).trim().split('\n')[1];
    expect(row.endsWith(',,,rewritten to --force-with-lease')).toBe(true);
  });

  it('quotes a clause containing a comma', () => {
    const row = renderCsv([decision({ clauseText: 'no force-push, ever' })]).trim().split('\n')[1];
    expect(row).toContain('"no force-push, ever"');
  });

  it('writes a header even with no rows, so the file is still a valid CSV', () => {
    expect(renderCsv([]).trim()).toBe(CSV_HEADER.join(','));
  });
});

describe('decisionJson', () => {
  it('matches the documented version 1 shape', () => {
    expect(decisionJson(decision())).toEqual({
      id: 'audit.jsonl:1',
      from: 'audit',
      at: '2026-08-31T21:04:11.000Z',
      sessionId: 's-1',
      sessionName: 'nightly bump',
      host: 'buildbox',
      agent: 'claude',
      tool: 'Bash',
      light: 'yellow',
      outcome: 'correct',
      actor: 'rule',
      clause: { id: 'practices§4', text: 'never force-push to a shared branch' },
      rewritten: true,
      reason: 'rewritten to --force-with-lease',
      latencyMs: 7,
      costUsd: 0.0012,
    });
  });

  it('reports "no clause was cited" as null, distinct from an empty citation', () => {
    expect(decisionJson(decision({ clauseId: '', clauseText: '' })).clause).toBeNull();
  });

  it('keeps an unrecorded number null rather than defaulting it', () => {
    const json = decisionJson(decision({ latencyMs: null, costUsd: null }));
    expect(json.latencyMs).toBeNull();
    expect(json.costUsd).toBeNull();
  });
});

describe('run', () => {
  const read = async (): Promise<Decision[]> => [
    decision({ id: 'a', outcome: 'allow', rewritten: false, at: new Date('2026-08-31T20:00:00Z') }),
    decision({ id: 'b', outcome: 'deny', at: new Date('2026-08-31T21:00:00Z'), rewritten: false }),
    decision({ id: 'c', outcome: 'correct', at: new Date('2026-08-31T22:00:00Z') }),
  ];

  it('prints help and exits 0', async () => {
    const io = fakeIo({ now: NOW });
    expect(await run(['--help'], io, read)).toBe(0);
    expect(io.text()).toContain('session-sitter log');
  });

  it('--denied keeps only what was blocked', async () => {
    const io = fakeIo({ now: NOW });
    expect(await run(['--denied', '--json'], io, read)).toBe(0);
    const json = JSON.parse(io.text());
    expect(json.decisions.map((d: { id: string }) => d.id)).toEqual(['b']);
  });

  it('--corrected keeps only the correction lane', async () => {
    const io = fakeIo({ now: NOW });
    await run(['--corrected', '--json'], io, read);
    expect(JSON.parse(io.text()).decisions.map((d: { id: string }) => d.id)).toEqual(['c']);
  });

  it('--tool and --session narrow to one call and one session', async () => {
    const io = fakeIo({ now: NOW });
    await run(['--tool', 'bash', '--session', 's-1', '--json'], io, read);
    expect(JSON.parse(io.text()).count).toBe(3);
    const other = fakeIo({ now: NOW });
    await run(['--session', 's-nope', '--json'], other, read);
    expect(JSON.parse(other.text()).count).toBe(0);
  });

  it('--limit keeps the most recent', async () => {
    const io = fakeIo({ now: NOW });
    await run(['--limit', '1', '--json'], io, read);
    expect(JSON.parse(io.text()).decisions.map((d: { id: string }) => d.id)).toEqual(['c']);
  });

  it('--json reports which state dir it read, so a surprising result is traceable', async () => {
    const io = fakeIo({ now: NOW });
    await run(['--json'], io, read);
    const json = JSON.parse(io.text());
    expect(json.version).toBe(1);
    expect(typeof json.stateDir).toBe('string');
    expect(typeof json.populated).toBe('boolean');
  });

  /**
   * The regression this change exists for, driven end to end through the real reader rather than an
   * injected one: on a terminal-only machine the hooks are the only writer, and `log` used to answer
   * "No supervision state found" while `decisions.jsonl` had been filling up all along.
   */
  it('finds the hook trail with no state dir anywhere — the terminal-only machine', async () => {
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ss-log-data-'));
    const saved = process.env.SESSION_SITTER_DATA_DIR;
    process.env.SESSION_SITTER_DATA_DIR = dataDir;
    try {
      await fs.promises.writeFile(path.join(dataDir, 'decisions.jsonl'), `${JSON.stringify({
        ts: '2026-08-31T21:10:00.000Z',
        sessionId: 'h-1',
        cwd: '/repo',
        tool: 'Bash',
        inputSummary: 'npm publish',
        light: 'red',
        decision: 'deny',
        clause: 'practices §no-publish',
        actor: 'policy',
        latencyMs: 4,
        rewritten: false,
      })}\n`, 'utf8');

      const io = fakeIo({ now: NOW });
      // No injected reader: this has to go through readDecisions and resolveState for real.
      expect(await run(['--json', '--since', '2026-08-01'], io)).toBe(0);
      const json = JSON.parse(io.text());
      expect(json.populated).toBe(true);
      expect(json.hookTrail).toBe(path.join(dataDir, 'decisions.jsonl'));
      expect(json.count).toBe(1);
      expect(json.decisions[0]).toMatchObject({
        outcome: 'deny',
        clause: { id: 'practices §no-publish', text: '' },
      });
    } finally {
      if (saved === undefined) { delete process.env.SESSION_SITTER_DATA_DIR; }
      else { process.env.SESSION_SITTER_DATA_DIR = saved; }
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('--csv writes the header and rows', async () => {
    const io = fakeIo({ now: NOW });
    await run(['--csv'], io, read);
    expect(io.text().split('\n')[0]).toBe(CSV_HEADER.join(','));
  });

  it('rejects --json with --csv, a bad --limit and a positional', async () => {
    const io = fakeIo({ now: NOW });
    await expect(run(['--json', '--csv'], io, read)).rejects.toThrow(/cannot be combined/);
    await expect(run(['--limit', '1.5'], io, read)).rejects.toThrow(/whole number/);
    await expect(run(['everything'], io, read)).rejects.toThrow(/takes no arguments/);
  });

  it('names the directory it searched when there is nothing to show', async () => {
    const io = fakeIo({ now: NOW });
    expect(await run(['--session', 'nothing-matches'], io, async () => [])).toBe(0);
    expect(io.text()).toMatch(/No (decisions match|supervision state found)/);
  });
});
