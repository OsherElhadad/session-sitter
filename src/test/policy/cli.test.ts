import { describe, it, expect } from 'vitest';
import { lint, replay } from '../../policy/cli';
import { parsePractices } from '../../policy/practices';
import type { DecisionRecord } from '../../audit/trail';

const clause = (body: string) => parsePractices(body, 'project', 'p.md');

describe('lint', () => {
  it('reports a file with no clauses', () => {
    expect(lint(clause('# just prose\n'))[0]).toMatchObject({ level: 'error' });
  });

  it('errors on a red clause with no Match line — it cannot enforce anything', () => {
    const findings = lint(clause(
      '### Intention: No force push\n\n| Field | Value |\n|---|---|\n| id | fp |\n| level | red |\n\n'
      + 'Prose only.\n'));
    expect(findings.some(f => f.level === 'error' && f.message.includes('practices §fp'))).toBe(true);
  });

  it('accepts a red clause that can match', () => {
    const findings = lint(clause(
      '### Intention: No force push\n\n| Field | Value |\n|---|---|\n| id | force-push |\n'
      + '| level | red |\n\nMatch: git push --force\n\nIt destroys other people\'s work.\n'));
    expect(findings.filter(f => f.level === 'error')).toEqual([]);
  });

  it('warns about a clause with no level', () => {
    const findings = lint(clause('### Intention: Vague\n\nMatch: something\n\nA body.\n'));
    expect(findings.some(f => f.level === 'warn' && f.message.includes('no level'))).toBe(true);
  });

  it('warns about a duplicated clause id', () => {
    const findings = lint(clause(
      '### Intention: One\n\n| Field | Value |\n|---|---|\n| id | dup |\n\nA body.\n\n---\n\n'
      + '### Intention: Two\n\n| Field | Value |\n|---|---|\n| id | dup |\n\nA body.\n'));
    expect(findings.some(f => f.message.includes('appears 2 times'))).toBe(true);
  });

  it('warns about a clause with no body, because the denial message would be bare', () => {
    const findings = lint(clause(
      '### Intention: Bare\n\n| Field | Value |\n|---|---|\n| level | red |\n\nMatch: x\n'));
    expect(findings.some(f => f.message.includes('no body'))).toBe(true);
  });

  it('notes a correction rule whose clause the file does not define', () => {
    const findings = lint(clause(
      '### Intention: Something else\n\n| Field | Value |\n|---|---|\n| id | other |\n'
      + '| level | red |\n\nMatch: x\n\nA body.\n'));
    expect(findings.some(f => f.level === 'info' && f.message.includes('force-push'))).toBe(true);
  });
});

describe('replay', () => {
  const record = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
    ts: '2026-09-01T11:00:00.000Z', sessionId: 's', cwd: '/r', tool: 'Bash',
    inputSummary: 'npm run build', light: null, decision: 'deny', clause: null,
    actor: 'timeout', latencyMs: 1, rewritten: false, ...over,
  });

  it('reports a decision the candidate clauses would change', () => {
    const candidate = clause(
      '### Intention: Building is fine\n\n| Field | Value |\n|---|---|\n| id | build-ok |\n'
      + '| level | green |\n\nMatch: npm run build\n\nThe build writes only into out/.\n');
    expect(replay([record()], candidate)).toEqual([
      '  deny → allow   Bash: npm run build  [practices §build-ok]',
    ]);
  });

  it('reports nothing when the verdict is unchanged', () => {
    const candidate = clause(
      '### Intention: No deletes\n\n| Field | Value |\n|---|---|\n| id | nd |\n| level | red |\n\n'
      + 'Match: rm -rf\n\nA body.\n');
    expect(replay([record({ inputSummary: 'rm -rf /tmp/x' })], candidate)).toEqual([]);
  });

  it('reports an allow that the candidate would make ambiguous', () => {
    const changes = replay([record({ decision: 'allow', inputSummary: 'npm run build' })], []);
    expect(changes[0]).toContain('allow → ambiguous');
  });
});
