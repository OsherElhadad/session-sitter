import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  filterRecords,
  formatDigest,
  formatLog,
  formatStatus,
  parseArgs,
  parseDuration,
} from '../../audit/cli';
import type { DecisionRecord } from '../../audit/trail';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cli-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const NOW = Date.parse('2026-09-01T12:00:00.000Z');

const record = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  ts: '2026-09-01T11:00:00.000Z',
  sessionId: 'sess-1',
  cwd: '/tmp/repo',
  tool: 'Bash',
  inputSummary: 'ls -la',
  light: 'green',
  decision: 'allow',
  clause: null,
  actor: 'deterministic',
  latencyMs: 2,
  rewritten: false,
  ...over,
});

describe('parseDuration', () => {
  it('reads every unit', () => {
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('24h')).toBe(86_400_000);
    expect(parseDuration('7d')).toBe(604_800_000);
  });
  it('rejects anything else', () => {
    expect(parseDuration('yesterday')).toBeNull();
    expect(parseDuration('24')).toBeNull();
    expect(parseDuration('')).toBeNull();
  });
});

describe('parseArgs', () => {
  it('defaults to log with no filters', () => {
    expect(parseArgs([])).toMatchObject({ command: 'log', since: null, format: 'text' });
  });
  it('reads a command and its flags', () => {
    expect(parseArgs(['digest', '--since', '24h', '--denied'])).toMatchObject({
      command: 'digest', since: 86_400_000, denied: true,
    });
  });
  it('reads the output formats', () => {
    expect(parseArgs(['log', '--json']).format).toBe('json');
    expect(parseArgs(['log', '--csv']).format).toBe('csv');
  });
  it('rejects an unknown command and an unknown option', () => {
    expect(() => parseArgs(['explode'])).toThrow(/unknown command/);
    expect(() => parseArgs(['log', '--nope'])).toThrow(/unknown option/);
  });
  it('rejects a --since that is not a duration', () => {
    expect(() => parseArgs(['log', '--since', 'soon'])).toThrow(/wants a duration/);
  });
});

describe('filterRecords', () => {
  const records = [
    record({ tool: 'Read' }),
    record({ tool: 'Bash', decision: 'deny', sessionId: 'sess-2' }),
    record({ tool: 'Bash', rewritten: true }),
    record({ tool: 'Bash', ts: '2026-08-01T11:00:00.000Z' }),
  ];
  const args = (over = {}) =>
    parseArgs([]) && { ...parseArgs([]), ...over } as ReturnType<typeof parseArgs>;

  it('returns everything by default', () => {
    expect(filterRecords(records, args(), NOW)).toHaveLength(4);
  });
  it('filters by session', () => {
    expect(filterRecords(records, args({ session: 'sess-2' }), NOW)).toHaveLength(1);
  });
  it('filters to denials', () => {
    expect(filterRecords(records, args({ denied: true }), NOW)).toHaveLength(1);
  });
  it('filters to corrections', () => {
    expect(filterRecords(records, args({ corrected: true }), NOW)).toHaveLength(1);
  });
  it('filters by age', () => {
    expect(filterRecords(records, args({ since: 86_400_000 }), NOW)).toHaveLength(3);
  });
});

describe('formatLog', () => {
  it('shows the clause on every line that has one', () => {
    const text = formatLog([record({ clause: 'practices §force-push', rewritten: true })], 'text');
    expect(text).toContain('practices §force-push');
    expect(text).toContain('FIX');
  });
  it('names the actor when there is no clause', () => {
    expect(formatLog([record()], 'text')).toContain('(deterministic)');
  });
  it('marks a denial', () => {
    expect(formatLog([record({ decision: 'deny' })], 'text')).toContain('DENY');
  });
  it('says so when there is nothing', () => {
    expect(formatLog([], 'text')).toBe('no decisions recorded\n');
  });
  it('emits parseable JSON', () => {
    expect(JSON.parse(formatLog([record()], 'json'))).toHaveLength(1);
  });
  it('emits CSV with a header and quotes what needs quoting', () => {
    const csv = formatLog([record({ inputSummary: 'echo "a, b"' })], 'csv').split('\n');
    expect(csv[0].startsWith('ts,sessionId,cwd,tool')).toBe(true);
    expect(csv[1]).toContain('"echo ""a, b"""');
  });
});

describe('formatDigest', () => {
  it('summarizes one session', () => {
    const digest = formatDigest([
      record({ clause: 'practices §a' }),
      record({ decision: 'deny', clause: 'practices §b', inputSummary: 'rm -rf /' }),
      record({ rewritten: true, clause: 'practices §a', actor: 'policy' }),
      record({ actor: 'model', latencyMs: 4000 }),
    ]);
    expect(digest).toContain('session sess-1');
    expect(digest).toContain('4 decisions — 3 allowed, 1 denied, 1 corrected');
    expect(digest).toContain('1 needed the classifier');
    expect(digest).toContain('practices §a');
    expect(digest).toContain('rm -rf /');
  });

  it('separates sessions', () => {
    const digest = formatDigest([record({ sessionId: 'a' }), record({ sessionId: 'b' })]);
    expect(digest).toContain('session a');
    expect(digest).toContain('session b');
  });

  it('says so when there is nothing', () => {
    expect(formatDigest([])).toBe('no decisions recorded\n');
  });
});

describe('formatStatus', () => {
  it('reports a registered session and its decision counts', () => {
    fs.writeFileSync(path.join(dir, 'sess-1.json'), JSON.stringify({
      sessionId: 'sess-1', cwd: '/tmp/repo', name: 'nightly',
    }));
    const status = formatStatus(dir, [record(), record({ decision: 'deny' })]);
    expect(status).toContain('sess-1  running');
    expect(status).toContain('nightly');
    expect(status).toContain('2 decisions, 1 denied');
  });

  it('reports an ended session as ended', () => {
    fs.writeFileSync(path.join(dir, 'sess-1.json'), JSON.stringify({
      sessionId: 'sess-1', endedAt: '2026-09-01T12:00:00.000Z',
    }));
    expect(formatStatus(dir, [])).toContain('ended 2026-09-01T12:00:00.000Z');
  });

  it('says so when nothing is registered', () => {
    expect(formatStatus(dir, [])).toContain('no sessions registered');
    expect(formatStatus(path.join(dir, 'missing'), [])).toContain('no sessions registered');
  });

  it('skips a corrupt registration rather than failing', () => {
    fs.writeFileSync(path.join(dir, 'bad.json'), 'not json');
    fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify({ sessionId: 'good' }));
    expect(formatStatus(dir, [])).toContain('good');
  });
});
