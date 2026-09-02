import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The classifier tier is the ONLY rung allowed to spawn anything. Making `buildEngine` throw turns
// "did the deterministic path call a model?" into a test that fails loudly instead of one that
// inspects mocks: if any deterministic rung reaches for the engine, the assertion below breaks.
const engineCalls: string[] = [];
vi.mock('../../supervisor/factory', () => ({
  buildEngine: () => {
    engineCalls.push('buildEngine');
    throw new Error('classifier must not be reached on the deterministic path');
  },
}));

import {
  PermissionDecision,
  PermissionRequestOutput,
  decideDeterministically,
  failClosedOutput,
  handle,
} from '../../hooks/permissionRequest';
import { parsePractices } from '../../policy/practices';
import { compilePolicy, currentPath, writePolicy } from '../../policy/compile';
import { parseBottomLine } from '../../supervisor/knowledge';
import { parseLearnedClause } from '../../supervisor/learnedClauses';
import { DecisionRecord, readJsonl } from '../../audit/trail';
import { decisionsPath } from '../../hooks/paths';

const PRACTICES = `
### Intention: Never force-push to a shared branch

| Field | Value |
|---|---|
| id | force-push |
| level | red |

Match: \`git push --force-with-lease origin main\`

Even the lease-guarded form is forbidden on main here.

---

### Intention: Delete nothing recursively

| Field | Value |
|---|---|
| id | no-recursive-delete |
| level | red |

Match: rm -rf

Deletion has no safer form, so it is denied rather than corrected.

---

### Intention: Running the test suite needs no approval

| Field | Value |
|---|---|
| id | tests-are-free |
| level | green |

Match: npm test

The suite touches nothing outside the working tree.
`;

const clauses = parsePractices(PRACTICES, 'team');

const req = (tool: string, input: Record<string, unknown>) => ({
  session_id: 'sess-1',
  cwd: '/tmp/repo',
  hook_event_name: 'PermissionRequest',
  tool_name: tool,
  tool_input: input,
});

/** `handle` may legitimately return `{}` (observe mode), so reach for the decision explicitly. */
const decisionOf = (output: unknown): PermissionDecision =>
  (output as PermissionRequestOutput).hookSpecificOutput.decision;

let dir: string;
const saved = { ...process.env };

beforeEach(() => {
  engineCalls.length = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-hook-'));
  process.env.SESSION_SITTER_DATA_DIR = dir;
  delete process.env.SESSION_SITTER_MODE;
  delete process.env.SESSION_SITTER_CLASSIFIER;
  delete process.env.SESSION_SITTER_PERSIST_RULES;
  delete process.env.SESSION_SITTER_PRACTICES;
  delete process.env.SESSION_SITTER_USER;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  process.env = { ...saved };
});

// --------------------------------------------------------------------------- the ladder

describe('decideDeterministically — rung 1, deterministic green', () => {
  it('allows a read with no clause and no model', () => {
    const v = decideDeterministically(req('Read', { file_path: '/tmp/a.ts' }), []);
    expect(v?.decision.behavior).toBe('allow');
    expect(v?.actor).toBe('deterministic');
    expect(v?.light).toBe('green');
    expect(v?.decision.updatedInput).toBeUndefined();
  });

  it('allows a safe shell command', () => {
    expect(decideDeterministically(req('Bash', { command: 'git status' }), [])?.decision.behavior)
      .toBe('allow');
  });

  it('treats a Claude Code read tool as green without any alias mapping', () => {
    for (const tool of ['Read', 'Glob', 'Grep', 'NotebookRead', 'BashOutput']) {
      expect(decideDeterministically(req(tool, { file_path: '/tmp/a.ts' }), [])?.decision.behavior)
        .toBe('allow');
    }
  });

  it('does not treat a write as green', () => {
    expect(decideDeterministically(req('Write', { file_path: '/tmp/a.ts', content: 'x' }), []))
      .toBeNull();
  });
});

describe('decideDeterministically — rung 2, the correction lane', () => {
  it('rewrites a force push and cites the clause', () => {
    const v = decideDeterministically(req('Bash', { command: 'git push --force origin dev' }), []);
    expect(v?.decision.behavior).toBe('allow');
    expect(v?.decision.updatedInput).toEqual({ command: 'git push --force-with-lease origin dev' });
    expect(v?.clause).toBe('practices §force-push');
    expect(v?.light).toBe('yellow');
    expect(v?.actor).toBe('policy');
  });

  it('refuses the rewrite when a red clause still forbids the safer form', () => {
    // The practices above forbid `--force-with-lease origin main` outright, so the correction
    // lane must not smuggle the rewritten call through.
    const v = decideDeterministically(req('Bash', { command: 'git push --force origin main' }), clauses);
    expect(v?.decision.behavior).toBe('deny');
    expect(v?.clause).toBe('practices §force-push');
    expect(v?.decision.updatedInput).toBeUndefined();
  });

  it('never marks a rewrite as settled, so it can never become a standing rule', () => {
    const v = decideDeterministically(req('Bash', { command: 'git push -f origin dev' }), []);
    expect(v?.settled).toBe(false);
  });
});

describe('decideDeterministically — rung 3, a written red clause', () => {
  it('denies and cites the clause', () => {
    const v = decideDeterministically(req('Bash', { command: 'rm -rf ./build' }), clauses);
    expect(v?.decision.behavior).toBe('deny');
    expect(v?.clause).toBe('practices §no-recursive-delete');
    expect(v?.decision.message).toContain('practices §no-recursive-delete');
    expect(v?.decision.message).toContain('Delete nothing recursively');
    expect(v?.actor).toBe('policy');
  });

  it('never attaches updatedInput or updatedPermissions to a deny', () => {
    const v = decideDeterministically(req('Bash', { command: 'rm -rf ./build' }), clauses);
    expect(v?.decision.updatedInput).toBeUndefined();
    expect(v?.decision.updatedPermissions).toBeUndefined();
  });
});

describe('decideDeterministically — rung 4, a written green clause', () => {
  it('allows and cites the clause', () => {
    const v = decideDeterministically(req('Bash', { command: 'npm test -- --run' }), clauses);
    expect(v?.decision.behavior).toBe('allow');
    expect(v?.clause).toBe('practices §tests-are-free');
    expect(v?.actor).toBe('policy');
  });
});

describe('decideDeterministically — rung 5, the built-in red table', () => {
  it('denies a destructive call no clause covers', () => {
    const v = decideDeterministically(req('Bash', { command: 'DROP TABLE users' }), []);
    expect(v?.decision.behavior).toBe('deny');
    expect(v?.actor).toBe('deterministic');
    expect(v?.clause).toBeNull();
    expect(v?.decision.message).toContain('built-in');
  });

  it('lets a written green clause win over the built-in table', () => {
    // The built-in table has no opinion about `npm test`, but a clause that overlaps the table
    // must still win — that is what makes written practices a policy layer rather than a hint.
    const own = parsePractices('### Intention: Cleaning build output is fine\n\n| Field | Value |\n'
      + '|---|---|\n| id | clean-ok |\n| level | green |\n\nMatch: rm -rf ./build\n', 'project');
    const v = decideDeterministically(req('Bash', { command: 'rm -rf ./build' }), own);
    expect(v?.decision.behavior).toBe('allow');
    expect(v?.clause).toBe('practices §clean-ok');
  });
});

describe('decideDeterministically — ambiguous', () => {
  it('returns null so a later rung decides', () => {
    expect(decideDeterministically(req('Bash', { command: 'npm run build' }), clauses)).toBeNull();
  });
});

// --------------------------------------------------------------------------- the wire contract

describe('handle — output contract', () => {
  it('emits hookEventName and a decision object', async () => {
    const output = await handle(req('Read', { file_path: '/tmp/a.ts' }));
    expect(output).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });

  it('makes no model call on the deterministic path', async () => {
    await handle(req('Read', { file_path: '/tmp/a.ts' }));
    await handle(req('Bash', { command: 'git status' }));
    await handle(req('Bash', { command: 'git push --force origin dev' }));
    await handle(req('Bash', { command: 'DROP TABLE users' }));
    expect(engineCalls).toEqual([]);
  });

  it('fails closed for an ambiguous call when no classifier is configured', async () => {
    const output = await handle(req('Write', { file_path: '/tmp/a.ts', content: 'x' }));
    const decision = decisionOf(output);
    expect(decision.behavior).toBe('deny');
    expect(decision.message).toContain('silence is not approval');
    expect(engineCalls).toEqual([]); // the classifier is off, so it is never even constructed
  });

  it('denies rather than approving when the classifier is unreachable', async () => {
    process.env.SESSION_SITTER_CLASSIFIER = 'on';
    const output = await handle(req('Write', { file_path: '/tmp/a.ts', content: 'x' }));
    const decision = decisionOf(output);
    expect(decision.behavior).toBe('deny');
    expect(decision.message).toContain('silence is not approval');
    expect(engineCalls).toEqual(['buildEngine']);
  });

  it('denies when the configured practices file cannot be read', async () => {
    process.env.SESSION_SITTER_PRACTICES = path.join(dir, 'nope.md');
    const output = await handle(req('Read', { file_path: '/tmp/a.ts' }));
    const decision = decisionOf(output);
    expect(decision.behavior).toBe('deny');
    expect(decision.message).toContain('practices:');
  });

  it('returns no verdict in observe mode', async () => {
    process.env.SESSION_SITTER_MODE = 'observe';
    expect(await handle(req('Write', { file_path: '/tmp/a.ts', content: 'x' }))).toEqual({});
  });

  it('still enforces the deterministic rungs in observe mode', async () => {
    process.env.SESSION_SITTER_MODE = 'observe';
    const output = await handle(req('Bash', { command: 'rm -rf /' }));
    expect(decisionOf(output).behavior).toBe('deny');
  });

  it('fail-closed output is a deny that names the reason', () => {
    const decision = failClosedOutput('boom').hookSpecificOutput.decision;
    expect(decision.behavior).toBe('deny');
    expect(decision.message).toContain('boom');
    expect(decision.updatedInput).toBeUndefined();
  });
});

describe('handle — questions to a human are never decided', () => {
  // Found by driving a real session: the agent asked "should I force-push?" via AskUserQuestion,
  // and because the question's own input carries the words `--force`, the built-in destructive
  // matcher denied the *question*. A question to a human stays a question to the human.
  const question = {
    session_id: 'sess-1', cwd: '/tmp/repo', tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [{
        question: 'Force-push to origin/main will overwrite remote history. Proceed?',
        header: 'Force push',
        options: [{ label: 'Yes, force push now', description: 'Run git push --force as written.' }],
      }],
    },
  };

  it('returns no verdict for AskUserQuestion, even when its text names a destructive command',
    async () => {
      expect(await handle(question)).toEqual({});
    });

  it('returns no verdict for ExitPlanMode', async () => {
    expect(await handle({ session_id: 'sess-1', tool_name: 'ExitPlanMode', tool_input: { plan: 'rm -rf /' } }))
      .toEqual({});
  });

  it('records it as no verdict, attributed to the human — not as a denial', async () => {
    await handle(question);
    const [record] = readJsonl<DecisionRecord>(decisionsPath());
    expect(record).toMatchObject({ tool: 'AskUserQuestion', decision: 'none', actor: 'human' });
    expect(record.note).toContain('question to a human');
  });

  it('exempts them before loading any policy, so a broken practices file cannot deny a question',
    async () => {
      process.env.SESSION_SITTER_PRACTICES = path.join(dir, 'nope.md');
      expect(await handle(question)).toEqual({});
    });

  it('still governs an ordinary tool whose input merely mentions a question', async () => {
    const output = await handle(req('Bash', { command: 'rm -rf /', description: 'ask the user?' }));
    expect(decisionOf(output).behavior).toBe('deny');
  });
});

describe('handle — updatedPermissions', () => {
  const suggestion = {
    type: 'addRules', behavior: 'allow',
    rules: [{ toolName: 'Read', ruleContent: '/tmp/**' }],
  };

  it('does not echo permission_suggestions by default', async () => {
    const output = await handle({ ...req('Read', { file_path: '/tmp/a.ts' }), permission_suggestions: [suggestion] });
    expect(decisionOf(output).updatedPermissions).toBeUndefined();
  });

  it('echoes them into localSettings once the operator opts in', async () => {
    process.env.SESSION_SITTER_PERSIST_RULES = '1';
    const output = await handle({ ...req('Read', { file_path: '/tmp/a.ts' }), permission_suggestions: [suggestion] });
    expect(decisionOf(output).updatedPermissions).toEqual([
      { ...suggestion, destination: 'localSettings' },
    ]);
  });

  it('never echoes them for a correction, which is a per-call rewrite', async () => {
    process.env.SESSION_SITTER_PERSIST_RULES = '1';
    const output = await handle({
      ...req('Bash', { command: 'git push --force origin dev' }),
      permission_suggestions: [suggestion],
    });
    expect(decisionOf(output).updatedPermissions).toBeUndefined();
  });

  it('never echoes them for a deny', async () => {
    process.env.SESSION_SITTER_PERSIST_RULES = '1';
    const output = await handle({ ...req('Bash', { command: 'rm -rf /' }), permission_suggestions: [suggestion] });
    expect(decisionOf(output).updatedPermissions).toBeUndefined();
  });
});

// --------------------------------------------------------------------------- the audit record

describe('handle — the audit record', () => {
  const only = (): DecisionRecord => {
    const records = readJsonl<DecisionRecord>(decisionsPath());
    expect(records).toHaveLength(1);
    return records[0];
  };

  it('records a corrected call as rewritten, with the clause and the actor', async () => {
    await handle(req('Bash', { command: 'git push --force origin dev' }));
    const r = only();
    expect(r).toMatchObject({
      sessionId: 'sess-1',
      cwd: '/tmp/repo',
      tool: 'Bash',
      inputSummary: 'git push --force origin dev',
      light: 'yellow',
      decision: 'allow',
      clause: 'practices §force-push',
      actor: 'policy',
      rewritten: true,
    });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.ts).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('records a deterministic allow with no clause and no rewrite', async () => {
    await handle(req('Read', { file_path: '/tmp/a.ts' }));
    expect(only()).toMatchObject({
      decision: 'allow', actor: 'deterministic', clause: null, rewritten: false,
    });
  });

  it('records a fail-closed deny as the timeout actor', async () => {
    await handle(req('Write', { file_path: '/tmp/a.ts', content: 'x' }));
    expect(only()).toMatchObject({ decision: 'deny', actor: 'timeout', light: null });
  });

  it('records what observe mode would have denied', async () => {
    process.env.SESSION_SITTER_MODE = 'observe';
    await handle(req('Write', { file_path: '/tmp/a.ts', content: 'x' }));
    expect(only()).toMatchObject({ decision: 'none', note: expect.stringContaining('observe mode') });
  });

  it('redacts a secret out of the recorded summary', async () => {
    process.env.SESSION_SITTER_MODE = 'observe';
    await handle(req('Bash', { command: `curl -H "Authorization: Bearer ${'z'.repeat(32)}"` }));
    expect(only().inputSummary).not.toContain('zzzz');
  });
});

// --------------------------------------------------------------------------- the compiled artifact

describe('the compiled policy artifact on the hot path', () => {
  const only = (): DecisionRecord => {
    const records = readJsonl<DecisionRecord>(decisionsPath());
    expect(records).toHaveLength(1);
    return records[0];
  };

  const ROUTING = { user: 'dana', project: 'ledger-api', team: 'payments' };

  /** Publish an artifact into the temp data dir, the way `policy compile` would. */
  const publish = (over: Parameters<typeof compilePolicy>[0]['learned'] = []) => {
    const { policy, errors } = compilePolicy({
      routing: ROUTING, human: parseBottomLine(ARTIFACT_PRACTICES, 'team'), learned: over,
      today: '2026-09-02', builtAt: '2026-09-02T00:00:00.000Z', corpusRef: 'git:1a2b3c4',
    });
    expect(errors).toEqual([]);
    if (!policy) { throw new Error('expected a policy'); }
    writePolicy(policy);
    return policy;
  };

  const ARTIFACT_PRACTICES = `
### Intention: Never delete a bucket

| Field | Value |
|---|---|
| id | pay-storage-001 |
| level | red |

Match: aws s3 rb

Deleting a bucket takes its contents and its name with it, and the name cannot be reclaimed.
`;

  beforeEach(() => {
    process.env.SESSION_SITTER_USER = ROUTING.user;
    process.env.SESSION_SITTER_PROJECT = ROUTING.project;
    process.env.SESSION_SITTER_TEAM = ROUTING.team;
  });

  it('decides from the artifact and stamps the revision it was evaluated against', async () => {
    const policy = publish();
    const output = await handle(req('Bash', { command: 'aws s3 rb s3://ledger-nightly' }));
    expect(decisionOf(output).behavior).toBe('deny');
    expect(only()).toMatchObject({
      clause: 'practices §pay-storage-001',
      rev: policy.revision,
      policySource: 'artifact',
    });
  });

  it('falls back to the markdown corpus when there is no artifact, and says so', async () => {
    await handle(req('Bash', { command: 'aws s3 rb s3://ledger-nightly' }));
    // No artifact and no configured corpus: the existing rule holds unchanged — a
    // configured-but-unreadable policy source denies rather than reading as "no rules". What is new
    // is only that the record says which source was tried.
    expect(only()).toMatchObject({
      decision: 'deny', actor: 'timeout', rev: null, policySource: 'markdown',
    });
  });

  it('falls back rather than reading a corrupt artifact as "no rules"', async () => {
    publish();
    fs.writeFileSync(currentPath(), '{"schema_version":1,"clauses":', 'utf8');
    await handle(req('Bash', { command: 'aws s3 rb s3://ledger-nightly' }));
    // An unparsable artifact must never mean an empty policy: in enforce mode that denies the world
    // for a reason nobody can see. It falls back to the corpus, which here is unconfigured, so the
    // existing fail-closed deny stands.
    expect(only()).toMatchObject({ decision: 'deny', policySource: 'markdown', rev: null });
  });

  it('never lets an audit clause change the outcome', async () => {
    process.env.SESSION_SITTER_MODE = 'observe';
    const trial = parseLearnedClause(`---
id: pay-trial-001
status: audit
level: red
evidence: EXTRACTED
support: 3
weight: 3
contradictions: 0
learned_at: 2026-08-30
learned_from:
  sessions: []
  decisions: [d-11aa22]
---

### Intention: Terraform apply outside the sandbox is a change nobody reviewed

Match: terraform apply

An apply against a shared workspace changes infrastructure other people depend on, and the plan
nobody read is the one that deletes a database.
`, 'team', 'data/knowledge/teams/payments/learned/pay-trial-001.md');
    if (!trial.clause) { throw new Error('fixture does not parse'); }
    publish([trial.clause]);
    await handle(req('Bash', { command: 'terraform apply -auto-approve' }));
    expect(only()).toMatchObject({ decision: 'none', clause: null, policySource: 'artifact' });
  });

  it('records no revision for an exempt tool, because no policy was consulted', async () => {
    publish();
    await handle(req('AskUserQuestion', { question: 'ship it?' }));
    expect(only()).toMatchObject({ decision: 'none', rev: null, policySource: 'none' });
  });
});
