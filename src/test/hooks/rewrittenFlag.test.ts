import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handle } from '../../hooks/permissionRequest';
import { writeVerdict } from '../../hooks/escalate';
import { writeHeartbeat, heartbeatPath } from '../../daemonHeartbeat';
import { pendingAsks } from '../../hooks/escalate';

// `rewritten` was computed as `verdict.decision.updatedInput !== undefined` — "did the verdict carry
// an updatedInput", not "did the input actually change". Rung 7's human-allow path returns the
// ORIGINAL input as `updatedInput`, so a human answering plain "allow" was recorded `rewritten: true`
// and rendered by `session-sitter log` as `correct` / `rewritten`. Nothing was rewritten: the command
// is byte-identical to the one that was asked.
//
// Why this is not cosmetic. `session-sitter learn` mines this trail. A `rewritten: true` record
// asserts the correction lane produced a safer form of the call, so a miner counting corrections — or
// generalising "calls of this shape get corrected" — learns from a correction that never happened. It
// is the mirror of the wave-2 defect where a corrected call was recorded as an allow of the original:
// both make the trail misdescribe what the safety mechanism did.
//
// Fixed at the single place the flag is computed rather than by stripping `updatedInput` from one
// caller, because the wrong question would still be asked of every future one.
describe('the rewritten flag records whether the input changed', () => {
  let dir: string;
  let saved: NodeJS.ProcessEnv;

  const practices = `# Bottom line

---

### Intention: A force push must be leased, never blind

| Field | Value |
|---|---|
| id | force-push |
| level | yellow |

The clause the built-in correction rule cites. No Match line on purpose.
`;

  beforeEach(async () => {
    saved = { ...process.env };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-rewritten-'));
    process.env.SESSION_SITTER_DATA_DIR = dir;
    process.env.SESSION_SITTER_MODE = 'enforce';
    process.env.SESSION_SITTER_PRACTICES = path.join(dir, 'practices.md');
    fs.writeFileSync(process.env.SESSION_SITTER_PRACTICES, practices, 'utf8');
    delete process.env.SESSION_SITTER_CLASSIFIER;
    delete process.env.SESSION_SITTER_USER;
  });

  afterEach(() => {
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const records = (): Record<string, unknown>[] =>
    fs.readFileSync(path.join(dir, 'decisions.jsonl'), 'utf8')
      .trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);

  it('is true when the correction lane actually changes the command', async () => {
    await handle({
      session_id: 'rw-1', cwd: '/tmp/repo', hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'git push --force origin main', description: 'force push' },
    });
    const [r] = records();
    expect(r.decision).toBe('allow');
    expect(r.actor).toBe('correction');
    expect(r.rewritten).toBe(true);
  });

  it('is FALSE when a human allows the call unchanged at rung 7', async () => {
    // A live daemon, so escalation is attempted rather than refused outright.
    process.env.SESSION_SITTER_ESCALATE = 'on';
    process.env.SESSION_SITTER_ESCALATE_WAIT = '20';
    await writeHeartbeat({
      pid: process.pid, host: os.hostname().split('.')[0],
      startedAt: new Date().toISOString(), lastPassAt: new Date().toISOString(),
      passes: 1, processed: 0, reading: true, stateDir: dir, mode: 'loop',
    }, heartbeatPath());

    const call = {
      session_id: 'rw-2', cwd: '/tmp/repo', hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'echo hello > /tmp/out.txt', description: 'write' },
    };
    const pending = handle(call);
    // Answer the ask the way the daemon would, once the hook has written it.
    for (let i = 0; i < 200; i++) {
      const asks = await pendingAsks(new Date());
      if (asks.length > 0) {
        await writeVerdict({
          askId: asks[0].askId, decision: 'allow', by: 'a human', text: 'allow',
          at: new Date().toISOString(),
        });
        break;
      }
      await new Promise(r => setTimeout(r, 25));
    }
    await pending;

    const [r] = records();
    expect(r.decision).toBe('allow');
    expect(r.actor).toBe('human');
    // The whole point: the command was not touched, so nothing may claim it was corrected.
    expect(r.rewritten).toBe(false);
  });

  it('is false on a plain denial', async () => {
    await handle({
      session_id: 'rw-3', cwd: '/tmp/repo', hook_event_name: 'PermissionRequest',
      tool_name: 'Bash', tool_input: { command: 'echo hi > /tmp/x', description: 'write' },
    });
    const [r] = records();
    expect(r.decision).toBe('deny');
    expect(r.rewritten).toBe(false);
  });
});
