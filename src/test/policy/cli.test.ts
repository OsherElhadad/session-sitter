import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compile, lint, replay } from '../../policy/cli';
import { currentPath } from '../../policy/compile';
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

// --------------------------------------------------------------------------- policy compile

describe('policy compile', () => {
  let tmp: string;
  const saved = { ...process.env };
  const out: string[] = [];
  const err: string[] = [];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-policy-cli-'));
    process.env.SESSION_SITTER_DATA_DIR = path.join(tmp, 'data');
    out.length = 0;
    err.length = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation(s => { out.push(String(s)); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation(s => { err.push(String(s)); return true; });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...saved };
  });

  const RATIONALE =
    'An apply against a shared workspace changes infrastructure other people depend on, and the '
    + 'plan nobody read is the one that deletes a database.';

  /** An invented corpus checkout: one human tier, one learned clause. */
  const corpus = (learnedBody: string | null): string => {
    const root = path.join(tmp, 'corpus');
    const teamDir = path.join(root, 'data', 'knowledge', 'teams', 'payments');
    fs.mkdirSync(path.join(teamDir, 'learned'), { recursive: true });
    fs.writeFileSync(path.join(teamDir, 'bottom-line.md'),
      '### Intention: Never delete a bucket\n\n| Field | Value |\n|---|---|\n'
      + '| id | pay-storage-001 |\n| level | red |\n\nMatch: aws s3 rb\n\n'
      + 'A bucket takes its contents and its name with it.\n', 'utf8');
    if (learnedBody !== null) {
      fs.writeFileSync(path.join(teamDir, 'learned', 'pay-tf-001.md'), learnedBody, 'utf8');
    }
    return root;
  };

  const learnedClause = (match: string): string => `---
id: pay-tf-001
status: accepted
level: red
evidence: EXTRACTED
support: 12
weight: medium
contradictions: 0
learned_at: 2026-08-30
adopted_at: 2026-09-01
learned_from:
  sessions: []
  decisions: [d-11aa22]
---

### Intention: Terraform apply outside the sandbox is a change nobody reviewed

Match: ${match}

${RATIONALE}
`;

  const run = (learnedBody: string | null, ...argv: string[]) => compile(
    ['--corpus', corpus(learnedBody), '--user', 'dana', '--project', 'ledger-api',
      '--team', 'payments', ...argv]);

  it('publishes an artifact and reports the revision it wrote', async () => {
    expect(await run(learnedClause('terraform apply'))).toBe(0);
    const printed = out.join('');
    expect(printed).toContain('2 clauses');
    expect(printed).toMatch(/revision {3}sha256:[0-9a-f]{64}/);
    expect(fs.existsSync(currentPath())).toBe(true);
  });

  it('writes nothing on --dry-run', async () => {
    expect(await run(learnedClause('terraform apply'), '--dry-run')).toBe(0);
    expect(out.join('')).toContain('dry run');
    expect(fs.existsSync(currentPath())).toBe(false);
  });

  it('refuses a dropped pattern with a non-zero exit and no artifact', async () => {
    expect(await run(learnedClause('`/terraform (apply/`'))).toBe(1);
    expect(err.join('')).toContain('does not compile');
    expect(err.join('')).toContain('no artifact written');
    expect(fs.existsSync(currentPath())).toBe(false);
  });

  it('refuses a malformed learned file, and leaves the previous revision published', async () => {
    expect(await run(learnedClause('terraform apply'))).toBe(0);
    const good = fs.readFileSync(currentPath(), 'utf8');

    const root = corpus(learnedClause('terraform apply').replace('status: accepted', 'status: PURPLE'));
    expect(await compile(['--corpus', root, '--user', 'dana', '--project', 'ledger-api',
      '--team', 'payments'])).toBe(1);
    expect(err.join('')).toContain('unknown `status: PURPLE`');
    // The runtime keeps serving the last good revision while the corpus is broken.
    expect(fs.readFileSync(currentPath(), 'utf8')).toBe(good);
  });

  it('refuses an unknown flag instead of writing somewhere else', async () => {
    // The bug this pins: `--data-dir` was not a flag, so a compile aimed at a scratch directory
    // silently published into the user's live `~/.claude/session-sitter/`.
    expect(await compile(['--corpus', tmp, '--user', 'dev', '--data-durr', '/tmp/x'])).toBe(2);
    expect(err.join('')).toContain('unknown option: --data-durr');
    expect(err.join('')).toContain('--data-dir');
  });

  it('publishes where --data-dir says', async () => {
    const elsewhere = path.join(tmp, 'elsewhere');
    expect(await run(learnedClause('terraform apply'), '--data-dir', elsewhere)).toBe(0);
    expect(fs.existsSync(path.join(elsewhere, 'policy', 'current.json'))).toBe(true);
  });

  it('needs a corpus and a user before it will do anything', async () => {
    expect(await compile([])).toBe(2);
    expect(await compile(['--corpus', tmp])).toBe(2);
  });
});
