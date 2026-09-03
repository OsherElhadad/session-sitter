/**
 * `policy explain` — the query surface, and the two properties that make it worth having.
 *
 * 1. **It is the same evaluator as the hook.** The first describe block runs a table of calls
 *    through `handle` — the real `PermissionRequest` entry point — and through `explain`, and
 *    asserts the light, the clause, the rung and the behaviour are identical. If `explain` ever
 *    grows an evaluator of its own, that block fails.
 * 2. **It cannot authorise anything.** It writes no record, and its output carries no field a hook
 *    consumer could read as a decision.
 *
 * The rest is the degradation matrix: every way the policy can be missing, corrupt or unreadable,
 * and the exact user-visible output for each. A query that cannot find an artifact says so and
 * exits non-zero; it never crashes, and it never answers from a source other than the one it names.
 *
 * Every fixture is invented — no real path, no real project, no real team.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Same guard the hook tests use: no rung of the query path may reach for a model. `explain` prices
// itself as "no model call", and this turns that claim into a failing test rather than a comment.
const engineCalls: string[] = [];
vi.mock('../../supervisor/factory', () => ({
  buildEngine: () => {
    engineCalls.push('buildEngine');
    throw new Error('policy explain must never reach the classifier');
  },
}));

import { explainCall, renderExplain, runExplain, type ExplainAnswer } from '../../policy/explain';
import { handle, type PermissionRequestOutput } from '../../hooks/permissionRequest';
import { loadSettings } from '../../hooks/settings';
import { artifactPath, compilePolicy, currentPath, policyDir, writePolicy } from '../../policy/compile';
import { parseBottomLine } from '../../supervisor/knowledge';
import { decisionsPath } from '../../hooks/paths';

const ROUTING = { user: 'dana', project: 'ledger-api', team: 'payments' };

const PRACTICES = `
### Intention: Never delete a bucket

| Field | Value |
|---|---|
| id | pay-storage-001 |
| level | red |

Match: aws s3 rb

Deleting a bucket takes its contents and its name with it, and the name cannot be reclaimed.

---

### Intention: Running the test suite needs no approval

| Field | Value |
|---|---|
| id | pay-tests-001 |
| level | green |

Match: npm test

The suite touches nothing outside the working tree.
`;

let dir: string;
const saved = { ...process.env };

/** Publish an artifact into the temp data dir, the way `policy compile` would. */
function publish(practices = PRACTICES) {
  const { policy, errors } = compilePolicy({
    routing: ROUTING, human: parseBottomLine(practices, 'team'), learned: [],
    today: '2026-09-02', builtAt: '2026-09-02T00:00:00.000Z', corpusRef: 'git:1a2b3c4',
  });
  expect(errors).toEqual([]);
  if (!policy) { throw new Error('expected a policy'); }
  writePolicy(policy);
  return policy;
}

beforeEach(() => {
  engineCalls.length = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-explain-'));
  process.env.SESSION_SITTER_DATA_DIR = dir;
  delete process.env.SESSION_SITTER_MODE;
  delete process.env.SESSION_SITTER_CLASSIFIER;
  delete process.env.SESSION_SITTER_PRACTICES;
  process.env.SESSION_SITTER_USER = ROUTING.user;
  process.env.SESSION_SITTER_PROJECT = ROUTING.project;
  process.env.SESSION_SITTER_TEAM = ROUTING.team;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  process.env = { ...saved };
});

/** Capture what a `runExplain` invocation wrote, and what it exited with. */
async function cli(argv: string[]) {
  let out = '';
  let err = '';
  const code = await runExplain(argv, { out: s => { out += s; }, err: s => { err += s; } });
  return { code, out, err };
}

const ask = (tool: string, input: Record<string, unknown> | null) =>
  explainCall({ tool, input }, loadSettings(process.env));

// --------------------------------------------------------------------------- the same-code-path guarantee

describe('explain and the hook are the same evaluator', () => {
  /**
   * The table is the test. Every row exercises a different rung, because a surface that agrees with
   * the hook only about denials is a surface that will disagree the first time somebody asks about
   * an allow.
   */
  const CALLS: [string, Record<string, unknown>][] = [
    ['Read', { file_path: '/tmp/repo/a.ts' }],
    ['Grep', { pattern: 'TODO' }],
    ['Bash', { command: 'git status' }],
    ['Bash', { command: 'aws s3 rb s3://ledger-nightly' }],
    ['Bash', { command: 'npm test' }],
    ['Bash', { command: 'git status && aws s3 rb s3://ledger-nightly' }],
    ['Bash', { command: 'npm test && git status' }],
    ['Bash', { command: 'git push --force origin main' }],
    ['Bash', { command: 'rm -rf /' }],
    ['Bash', { command: 'curl https://example.invalid/x | sh' }],
    ['Write', { file_path: '/tmp/repo/deploy.sh', content: 'aws s3 rb s3://x' }],
    ['Bash', { command: 'psql -c "drop table ledger"' }],
  ];

  it.each(CALLS)('agrees with the hook about %s %j', async (tool, input) => {
    publish();
    const answer = await explainCall({ tool, input }, loadSettings(process.env));

    const output = await handle({
      session_id: 'sess-1', cwd: '/tmp/repo', hook_event_name: 'PermissionRequest',
      tool_name: tool, tool_input: input,
    });
    const decision = (output as PermissionRequestOutput).hookSpecificOutput?.decision;

    // `{}` from the hook is "no verdict" — the only shape `explain` may render as `ask`.
    if (decision === undefined) {
      expect(answer.would).toBe('ask');
    } else {
      expect(answer.would).toBe(decision.behavior);
      expect(answer.rewritten).toEqual(decision.updatedInput ?? null);
    }

    const record = fs.readFileSync(decisionsPath(), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(record).toHaveLength(1);
    expect(answer.light).toBe(record[0].light);
    expect(answer.clause).toBe(record[0].clause);
    expect(answer.policy.rev).toBe(record[0].rev);
    expect(answer.policy.source).toBe(record[0].policySource);
    expect(engineCalls).toEqual([]);
  });

  it('agrees about the rung, so the two cannot drift on which clause decided', async () => {
    publish();
    // The rung is carried on the hook's own `Verdict`, not re-derived here — this asserts that the
    // field `explain` prints is the one the enforcement path set.
    expect((await ask('Read', { file_path: '/tmp/a.ts' })).rung).toBe(1);
    expect((await ask('Bash', { command: 'git push --force origin main' })).rung).toBe(2);
    expect((await ask('Bash', { command: 'aws s3 rb s3://x' })).rung).toBe(3);
    expect((await ask('Bash', { command: 'npm test' })).rung).toBe(4);
    expect((await ask('Bash', { command: 'rm -rf /' })).rung).toBe(5);
    expect((await ask('Write', { file_path: '/tmp/a.ts', content: 'x' })).rung).toBe(7);
  });

  it('routes an undecidable call to the classifier rung when one is enabled, without calling it', async () => {
    publish();
    process.env.SESSION_SITTER_CLASSIFIER = 'on';
    const answer = await ask('Write', { file_path: '/tmp/a.ts', content: 'x' });
    expect(answer).toMatchObject({ would: 'ask', rung: 6 });
    expect(engineCalls).toEqual([]);
  });

  it('says the prompt comes back in observe mode, which is what the hook does there', async () => {
    publish();
    process.env.SESSION_SITTER_MODE = 'observe';
    const answer = await ask('Write', { file_path: '/tmp/a.ts', content: 'x' });
    expect(answer.would).toBe('ask');
    expect(answer.note).toContain('observe');
  });
});

// --------------------------------------------------------------------------- it cannot authorise

describe('explain cannot authorise anything', () => {
  it('writes nothing — the decisions trail is byte-identical across a query', async () => {
    publish();
    await handle({
      session_id: 's', cwd: '/tmp/repo', hook_event_name: 'PermissionRequest',
      tool_name: 'Bash', tool_input: { command: 'git status' },
    });
    const before = fs.readFileSync(decisionsPath());
    await cli(['Bash', '--command', 'aws s3 rb s3://x']);
    await cli(['Bash', '--command', 'npm test', '--json']);
    expect(fs.readFileSync(decisionsPath()).equals(before)).toBe(true);
  });

  it('creates no decisions trail at all when none existed', async () => {
    publish();
    await cli(['Bash', '--command', 'npm test']);
    expect(fs.existsSync(decisionsPath())).toBe(false);
  });

  it('emits nothing a PermissionRequest consumer could read as a decision', async () => {
    publish();
    const { out } = await cli(['Bash', '--command', 'npm test', '--json']);
    const payload = JSON.parse(out) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('hookSpecificOutput');
    expect(payload).not.toHaveProperty('behavior');
    expect(payload).not.toHaveProperty('updatedPermissions');
    // `would`, not `behavior`: the field name itself refuses to be pasted into a hook response.
    expect(payload.would).toBe('allow');
  });

  it('imports nothing that can write — the guarantee is structural, not a promise', () => {
    // Comments stripped first: this asserts about the code, and the module's own docstring quite
    // reasonably names the things it does not do.
    const code = fs.readFileSync(path.join(__dirname, '../../policy/explain.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const forbidden of [
      'audit/trail', 'appendJsonl', 'decisionsPath', 'writeFile', 'appendFile', 'mkdir',
      'hookSpecificOutput', 'handle(',
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });
});

// --------------------------------------------------------------------------- what it prints

describe('the answer it prints', () => {
  it('names the clause, the rung, the light and the revision', async () => {
    const policy = publish();
    const { code, out } = await cli(['Bash', '--command', 'aws s3 rb s3://ledger-nightly']);
    expect(code).toBe(0);
    expect(out).toContain('WOULD DENY');
    expect(out).toContain('rung 3');
    expect(out).toContain('practices §pay-storage-001');
    expect(out).toContain(policy.revision.replace('sha256:', '').slice(0, 8));
    expect(out).toContain('Deleting a bucket takes its contents');
    // The clause text is the corpus's, at a named revision — so the citation resolves.
    expect(out).toContain('@');
  });

  it('names the source that answered, in json, always', async () => {
    const policy = publish();
    const { out } = await cli(['Bash', '--command', 'aws s3 rb s3://x', '--json']);
    expect(JSON.parse(out).policy).toMatchObject({
      source: 'artifact', rev: policy.revision, degraded: null,
    });
  });

  it('names which sub-command of a compound tripped, which the clause body cannot say', async () => {
    publish();
    const { out } = await cli(['Bash', '--command', 'git status && aws s3 rb s3://x']);
    expect(out).toContain('sub-command 2 of 2');
  });

  it('says when a rewrite was attempted and then refused by the clause itself', async () => {
    // The team clause matches `git push --force`, which is also a substring of the safer form the
    // correction lane produces — so the rewrite is re-checked, rejected, and the call denied. Without
    // this line the output looks like a plain rung-3 deny and hides that a fix was tried.
    publish(PRACTICES + `
---

### Intention: Never force-push to a shared branch

| Field | Value |
|---|---|
| id | pay-git-002 |
| level | red |

Match: \`git push --force\`

Rewriting history on a branch other people build on destroys their work.
`);
    const { out } = await cli(['Bash', '--command', 'git push --force origin main']);
    expect(out).toContain('was rejected by practices §pay-git-002');
  });

  it('offers the rewrite when the correction lane would produce one', async () => {
    publish();
    const { out } = await cli(['Bash', '--command', 'git push --force origin main']);
    expect(out).toContain('rung 2');
    expect(out).toContain('--force-with-lease');
  });

  it('takes --input as the whole tool input, for a tool that is not a shell', async () => {
    publish();
    const { code, out } = await cli(['Read', '--input', '{"file_path":"/tmp/a.ts"}']);
    expect(code).toBe(0);
    expect(out).toContain('WOULD ALLOW');
    expect(out).toContain('rung 1');
  });

  it('reads a retained revision, so an old citation resolves to the text that actually fired', async () => {
    const first = publish();
    const changed = PRACTICES.replace(
      'Deleting a bucket takes its contents and its name with it, and the name cannot be reclaimed.',
      'Bucket deletion is now handled by the platform team, and only by them, on request.');
    const second = publish(changed);
    expect(second.revision).not.toBe(first.revision);

    const now = await cli(['Bash', '--command', 'aws s3 rb s3://x']);
    expect(now.out).toContain('Bucket deletion is now handled');

    const then = await cli(['Bash', '--command', 'aws s3 rb s3://x', '--rev', first.revision]);
    expect(then.code).toBe(0);
    expect(then.out).toContain('Deleting a bucket takes its contents');
    expect(then.out).toContain(first.revision.replace('sha256:', '').slice(0, 8));
  });

  it('accepts --rev current as the explicit form of the default', async () => {
    const policy = publish();
    const { code, out } = await cli(['Bash', '--command', 'aws s3 rb s3://x', '--rev', 'current', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out).policy).toMatchObject({ source: 'artifact', rev: policy.revision });
  });

  it('reports the bounded set the classifier would be handed, from the same selector', async () => {
    publish();
    const { out } = await cli(['Bash', '--command', 'aws s3 rb s3://x', '--json']);
    const selection = JSON.parse(out).selection;
    expect(selection.matched).toEqual(['pay-storage-001']);
    expect(selection.subsetLine).toContain('policy revision');
  });
});

// --------------------------------------------------------------------------- the degradation matrix

describe('degradation — every failure names itself and nothing throws', () => {
  it('no artifact: answers from the markdown corpus and says which source answered', async () => {
    process.env.SESSION_SITTER_PRACTICES = path.join(dir, 'practices.md');
    fs.writeFileSync(process.env.SESSION_SITTER_PRACTICES, PRACTICES, 'utf8');
    const { code, out } = await cli(['Bash', '--command', 'aws s3 rb s3://x', '--json']);
    expect(code).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.would).toBe('deny');
    expect(payload.policy).toMatchObject({ source: 'markdown', rev: null });
    expect(payload.policy.degraded).toContain('practicesFile');
    expect(payload.selection).toBeNull();
  });

  it('no artifact and no corpus: says no policy is loaded, exits 1, never says allowed', async () => {
    const { code, out } = await cli(['Bash', '--command', 'aws s3 rb s3://x']);
    expect(code).toBe(1);
    expect(out).toContain('no policy is loaded');
    expect(out).toContain('rung 7');
    expect(out).not.toContain('WOULD ALLOW');
  });

  it('unparsable artifact: falls back, and the reason quotes the parse failure', async () => {
    publish();
    fs.writeFileSync(currentPath(), '{"schema_version":1,"clauses":', 'utf8');
    const { code, out } = await cli(['Bash', '--command', 'aws s3 rb s3://x', '--json']);
    expect(code).toBe(1);
    expect(JSON.parse(out).policy).toMatchObject({ source: 'markdown', rev: null });
    expect(JSON.parse(out).policy.degraded).toContain('unparsable');
  });

  it('wrong schema_version: falls back, and says which version it read', async () => {
    const policy = publish();
    fs.writeFileSync(currentPath(), JSON.stringify({ ...policy, schema_version: 99 }), 'utf8');
    const { out } = await cli(['Bash', '--command', 'aws s3 rb s3://x', '--json']);
    expect(JSON.parse(out).policy.degraded).toContain('schema_version 99 is not 1');
  });

  it('artifact compiled for another team: falls back rather than answering from it', async () => {
    publish();
    process.env.SESSION_SITTER_TEAM = 'platform';
    const { out } = await cli(['Bash', '--command', 'aws s3 rb s3://x', '--json']);
    expect(JSON.parse(out).policy).toMatchObject({ source: 'markdown' });
    expect(JSON.parse(out).policy.degraded).toContain('different routing triple');
  });

  it('--rev naming a revision that rolled off: refuses to answer from another one', async () => {
    publish();
    const { code, out, err } = await cli([
      'Bash', '--command', 'aws s3 rb s3://x', '--rev', 'a'.repeat(64)]);
    expect(code).toBe(1);
    expect(err).toContain('is not retained');
    expect(err).toContain('nothing was answered');
    // Not a stack trace, and not an answer from `current.json` under a different revision's name.
    expect(err).not.toContain('Error:');
    expect(out).toBe('');
  });

  it('--rev naming a corrupt retained artifact: says so, exits 1, answers nothing', async () => {
    const policy = publish();
    fs.writeFileSync(artifactPath(policy.revision), 'not json at all', 'utf8');
    const { code, out, err } = await cli([
      'Bash', '--command', 'aws s3 rb s3://x', '--rev', policy.revision]);
    expect(code).toBe(1);
    expect(err).toContain('could not be read');
    expect(err).toContain('unparsable');
    expect(out).toBe('');
  });

  it('an unreadable configured practicesFile blames the configuration, not the supervisor', async () => {
    process.env.SESSION_SITTER_PRACTICES = path.join(dir, 'nope', 'practices.md');
    const { code, out, err } = await cli(['Bash', '--command', 'aws s3 rb s3://x']);
    // Still the hook's verdict — rung 7 — because that is what the hook does with an unreadable
    // practices file. What changes is the diagnosis, which names the file the user can fix.
    expect(code).toBe(1);
    expect(out).toContain('rung 7');
    expect(out).toContain('practicesFile');
    expect(out).toContain(path.join(dir, 'nope', 'practices.md'));
    expect(out).not.toContain('supervisor error');
    expect(err).toBe('');
  });

  it('names both sources when both were tried and neither answered', async () => {
    const { out } = await cli(['Bash', '--command', 'aws s3 rb s3://x', '--json']);
    const degraded = JSON.parse(out).policy.degraded as string;
    expect(degraded).toContain('no usable compiled artifact (absent)');
    expect(degraded).toContain('markdown corpus could not be read');
  });

  it('a clause whose pattern cannot compile is skipped, and the rest still decide', async () => {
    const policy = publish();
    const broken = {
      ...policy,
      clauses: [
        { ...policy.clauses[0], id: 'pay-broken-001', citation: 'practices §pay-broken-001',
          patterns: [{ raw: '/[unclosed/', is_regex: true, flags: 'i' }] },
        ...policy.clauses,
      ],
    };
    fs.writeFileSync(currentPath(), JSON.stringify(broken), 'utf8');
    const { code, out } = await cli(['Bash', '--command', 'aws s3 rb s3://ledger-nightly']);
    expect(code).toBe(0);
    expect(out).toContain('practices §pay-storage-001');
  });

  it('a policy directory that is not readable at all degrades instead of throwing', async () => {
    fs.mkdirSync(policyDir(), { recursive: true });
    fs.mkdirSync(currentPath());  // a directory where a file belongs
    const { code, out } = await cli(['Bash', '--command', 'aws s3 rb s3://x']);
    expect(code).toBe(1);
    expect(out).toContain('no policy is loaded');
  });
});

// --------------------------------------------------------------------------- arguments

describe('arguments', () => {
  it('needs a tool name', async () => {
    const { code, err } = await cli([]);
    expect(code).toBe(2);
    expect(err).toContain('explain needs a tool name');
  });

  it('refuses an unknown flag rather than ignoring it', async () => {
    const { code, err } = await cli(['Bash', '--commnad', 'npm test']);
    expect(code).toBe(2);
    expect(err).toContain('unknown option: --commnad');
  });

  it('refuses --input that is not JSON, and does not guess', async () => {
    const { code, err } = await cli(['Bash', '--input', '{command: npm test}']);
    expect(code).toBe(2);
    expect(err).toContain('--input is not valid JSON');
  });

  it('refuses --input that is not a JSON object', async () => {
    const { code, err } = await cli(['Bash', '--input', '"npm test"']);
    expect(code).toBe(2);
    expect(err).toContain('--input must be a JSON object');
  });

  it('refuses --input and --command together, because only one can be the input', async () => {
    const { code, err } = await cli(['Bash', '--input', '{}', '--command', 'npm test']);
    expect(code).toBe(2);
    expect(err).toContain('--input and --command');
  });
});

// --------------------------------------------------------------------------- rendering

describe('renderExplain', () => {
  const answer = (over: Partial<ExplainAnswer> = {}): ExplainAnswer => ({
    would: 'deny', rung: 3, rungLabel: 'written red clause', light: 'red',
    clause: 'practices §pay-storage-001', citation: 'practices §pay-storage-001@1a2b3c4',
    title: 'Never delete a bucket', message: 'Buckets do not come back.', sourceFile: 'team/bottom-line.md',
    fix: null, rewritten: null, note: 'denied', selection: null,
    policy: {
      source: 'artifact', rev: 'sha256:' + '1'.repeat(64), degraded: null, clauses: 2,
      elapsedMs: 0.71,
    },
    ...over,
  });

  it('says explicitly that it decided nothing', () => {
    expect(renderExplain(answer())).toContain('decides nothing');
  });

  it('prices itself honestly: no model call, and the measured cost of the work it did', () => {
    expect(renderExplain(answer())).toContain('no model call · 0 tokens · 0.71 ms');
  });

  it('points at the file the clause was written in', () => {
    expect(renderExplain(answer())).toContain('team/bottom-line.md');
  });
});
