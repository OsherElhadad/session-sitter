import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ablateCommand, compile, lint, replay } from '../../policy/cli';
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
  const record = (over: Partial<DecisionRecord> = {}): DecisionRecord => {
    const command = over.inputSummary ?? 'npm run build';
    return {
      ts: '2026-09-01T11:00:00.000Z', sessionId: 's', cwd: '/r', tool: 'Bash',
      inputSummary: command, light: null, decision: 'deny', clause: null,
      actor: 'timeout', latencyMs: 1, rewritten: false,
      // Replay re-evaluates `call`, never the display summary. A record without it is unreplayable
      // and is reported as such rather than being reconstructed — see the last case in this block.
      call: { tool_name: 'Bash', input: { command } }, ...over,
    };
  };

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
    const changes = replay(
      [record({ decision: 'allow', actor: 'policy', inputSummary: 'npm run build' })], []);
    expect(changes[0]).toContain('allow → ambiguous');
  });

  it('reports a record with no `call` as unreplayable rather than as unchanged', () => {
    // The trail's `call` field is additive, so a record written before it existed cannot be
    // re-evaluated. Silently counting it as unchanged would understate a candidate's blast radius.
    const changes = replay([{ ...record(), call: undefined }], []);
    expect(changes).toEqual([
      '  (1 record(s) have no `call` field and could not be re-evaluated — excluded, not counted as '
      + 'unchanged)',
    ]);
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

// --------------------------------------------------------------------------- policy ablate

describe('policy ablate', () => {
  let tmp: string;
  const saved = { ...process.env };
  const out: string[] = [];
  const err: string[] = [];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-ablate-cli-'));
    // Default the state directory to a scratch path, always. A CLI whose data directory falls back to
    // the user's live `~/.claude` when a flag is missed is how a test run once published into a real
    // config tree, and it could not be cleaned up afterwards.
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

  /** An artifact on disk, written the way `compile` writes one. */
  const artifact = () => {
    const dir = path.join(tmp, 'data', 'policy');
    fs.mkdirSync(dir, { recursive: true });
    const policy = {
      schema_version: 1, revision: 'sha256:abc', corpus_ref: null,
      built_at: '2026-08-01T00:00:00.000Z', built_from: ['bottom-line.md'], selector: 'v1',
      routing: { user: 'devx', project: '', team: 'platform' }, prompt_core: '',
      clauses: [{
        id: 'team-fetch-001', citation: 'practices §team-fetch-001', origin: 'human', tier: 'team',
        level: 'green', status: 'accepted', kind: 'belief', title: 'Fetching is fine',
        body: 'Fetching mutates nothing.',
        patterns: [{ raw: 'git fetch', is_regex: false, flags: 'i' }],
        fix: null, weight: 'medium', expires: null, supersedes: [], source_file: 'bottom-line.md',
        deletable: null,
      }],
    };
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(policy), 'utf8');
  };

  const records = (n: number, command: string) => {
    const lines = Array.from({ length: n }, (_, i) => JSON.stringify({
      ts: `2026-08-${String((i % 28) + 1).padStart(2, '0')}T09:00:00.000Z`,
      sessionId: `s-${i % 4}`, cwd: '/w/checkout', tool: 'Bash', inputSummary: command,
      light: null, decision: 'deny', clause: null, actor: 'timeout', latencyMs: 1,
      rewritten: false, call: { tool_name: 'Bash', input: { command } },
    }));
    fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'data', 'decisions.jsonl'), `${lines.join('\n')}\n`, 'utf8');
  };

  it('refuses the run, not the corpus, when the window is too short', async () => {
    artifact();
    records(20, 'yarn build');
    expect(await ablateCommand([])).toBe(40);
    expect(err.join('')).toContain('at least 100 recorded decisions');
    expect(err.join('')).toContain('refuses the *run*, not the corpus');
  });

  it('refuses when there is no compiled artifact to ablate against', async () => {
    records(200, 'yarn build');
    expect(await ablateCommand([])).toBe(40);
    expect(err.join('')).toContain('run `policy compile` first');
  });

  it('reports a green with zero changes as a retirement candidate, and writes nothing', async () => {
    artifact();
    records(200, 'yarn build');
    const before = fs.readFileSync(path.join(tmp, 'data', 'policy', 'current.json'), 'utf8');
    expect(await ablateCommand([])).toBe(0);
    const text = out.join('');
    expect(text).toContain('RETIRE? green  team-fetch-001');
    expect(text).toContain('1 retirement candidate(s)');
    expect(text).toContain('this run produces evidence, not state');
    // The gate produces evidence; governance's `accept` / `displaces` write the states.
    expect(fs.readFileSync(path.join(tmp, 'data', 'policy', 'current.json'), 'utf8')).toBe(before);
  });

  it('reports a clause that is still doing work without proposing anything', async () => {
    artifact();
    records(200, 'git fetch --all --prune');
    expect(await ablateCommand([])).toBe(0);
    expect(out.join('')).toContain('0 retirement candidate(s)');
    expect(out.join('')).not.toContain('RETIRE?');
  });

  it('refuses an unknown flag rather than ignoring it and writing somewhere else', async () => {
    expect(await ablateCommand(['--window', '500'])).toBe(2);
    expect(err.join('')).toContain('unknown option: --window');
  });
});
