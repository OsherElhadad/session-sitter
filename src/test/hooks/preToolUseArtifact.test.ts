import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handle } from '../../hooks/preToolUse';
import { compilePolicy, currentPath, gatherCorpus, writePolicy } from '../../policy/compile';
import { handle as permissionHandle } from '../../hooks/permissionRequest';

// The bug: `PreToolUse` loaded clauses through `loadClauses`, which reads the markdown corpus and
// never consults the compiled artifact — while `PermissionRequest` loads through `loadPolicyInputs`,
// which is artifact-first. So publishing the artifact with `policy compile` silently turned the
// PreToolUse half of enforcement off.
//
// That half is not incidental. `PermissionRequest` fires only when Claude Code was already going to
// prompt; a call it allows on its own — every read — is never offered to the plugin. `PreToolUse` is
// the only hook that sees those, and its own header names `cat .env` as the hole it exists to close.
//
// Measured in a real terminal session before this fix: `cat .env` ran, returned
// `API_KEY=…`/`DB_URL=…` to the model, and wrote NO decision record — because PreToolUse had zero
// clauses and PermissionRequest was never invoked. Compiling the artifact, which is the reviewed and
// prompt-cache-stable path the docs recommend, made enforcement strictly weaker and said nothing.
describe('PreToolUse reads the same policy PermissionRequest does', () => {
  let dir: string;
  let saved: NodeJS.ProcessEnv;

  const practices = `# Bottom line

---

### Intention: Secrets are never read into the transcript

| Field | Value |
|---|---|
| id | sec-003 |
| level | red |

Match: \`/\\.env\\b/\`

A .env read puts live credentials into the transcript.
`;

  beforeEach(async () => {
    saved = { ...process.env };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-pretool-artifact-'));
    process.env.SESSION_SITTER_DATA_DIR = dir;
    process.env.SESSION_SITTER_MODE = 'enforce';
    // Artifact routing, and NOTHING else: no practicesFile, no KNOWLEDGE_LOCAL_REPO. This is exactly
    // the state `session-sitter policy compile` leaves a terminal user in.
    process.env.SESSION_SITTER_USER = 'dev';
    process.env.SESSION_SITTER_PROJECT = 'widget-lab';
    process.env.SESSION_SITTER_TEAM = 'widget-lab';
    delete process.env.SESSION_SITTER_PRACTICES;
    delete process.env.KNOWLEDGE_LOCAL_REPO;
    delete process.env.KB_SITTER_LOCAL_REPO;
    delete process.env.SESSION_SITTER_CLASSIFIER;

    // Compiled from a corpus on disk through the same gatherCorpus the CLI uses, so the artifact
    // under test is the one `session-sitter policy compile` actually publishes.
    const corpus = path.join(dir, 'corpus');
    const tier = path.join(corpus, 'data', 'knowledge', 'teams', 'widget-lab');
    fs.mkdirSync(tier, { recursive: true });
    fs.writeFileSync(path.join(tier, 'bottom-line.md'), practices, 'utf8');
    const { policy, errors } = compilePolicy(await gatherCorpus({
      corpusRoot: corpus, user: 'dev', project: 'widget-lab', team: 'widget-lab',
    }));
    expect(errors).toEqual([]);
    expect(policy).not.toBeNull();
    writePolicy(policy!);
    expect(fs.existsSync(currentPath())).toBe(true);
  });

  afterEach(() => {
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Just enough shape to read a decision out of either hook without reaching for `any`.
  type PreOut = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  type PermOut = { hookSpecificOutput?: { decision?: { behavior?: string; message?: string } } };

  const call = {
    session_id: 'artifact-test',
    cwd: '/tmp/repo',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'cat .env', description: 'read env' },
  };

  it('denies a red clause that exists only in the compiled artifact', async () => {
    const out = await handle(call) as PreOut;
    // The precise failure being pinned: `{}` is a NO-DECISION, so the call proceeds and, because
    // Claude Code allows reads without prompting, PermissionRequest never runs either.
    expect(out).not.toEqual({});
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toMatch(/sec-003/);
  });

  it('writes the denial to the trail, so the bypass could not be silent again', async () => {
    await handle(call);
    const trail = path.join(dir, 'decisions.jsonl');
    const records = fs.readFileSync(trail, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(records).toHaveLength(1);
    expect(records[0].decision).toBe('deny');
    expect(records[0].clause).toMatch(/sec-003/);
  });

  it('agrees with PermissionRequest on the same call, which is the whole point', async () => {
    const pre = await handle(call) as PreOut;
    const perm = await permissionHandle({ ...call, hook_event_name: 'PermissionRequest' }) as PermOut;
    expect(pre.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(perm.hookSpecificOutput?.decision?.behavior).toBe('deny');
    // Same clause cited by both. Two loaders meant two possible answers; one loader means one.
    expect(pre.hookSpecificOutput?.permissionDecisionReason)
      .toBe(perm.hookSpecificOutput?.decision?.message);
  });

  it('still fails OPEN, not closed, when nothing matches', async () => {
    // The inverted fail direction is this hook's entire risk, so it is pinned alongside the fix:
    // reading the artifact must not turn an unmatched call into a denial.
    const out = await handle({ ...call, tool_input: { command: 'ls -la', description: 'list' } });
    expect(out).toEqual({});
  });
});
