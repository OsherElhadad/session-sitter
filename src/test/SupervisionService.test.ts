/**
 * The in-process supervision driver: handing an unhandled prompt to the supervisor, dedupe and
 * re-arm, the outbox kick, and the self-scheduling poll loop.
 *
 * This replaces the supervision project's `SupervisionTrigger`, which spawned a Python interpreter per prompt.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// SupervisionService -> SessionExporter -> agents/BobApprover -> agents/BobInspector loads
// 'vscode' at import time; stub it.
vi.mock('vscode', () => ({ extensions: { getExtension: vi.fn() } }));
import { SupervisionService } from '../SupervisionService';
import { loadConfig } from '../supervisor/config';
import type { PendingApproval } from '../agents/BobApprover';

let tmp: string;
let stateDir: string;
const logs: string[] = [];
const log = (m: string): void => { logs.push(m); };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'supervision-service-'));
  stateDir = path.join(tmp, 'state');
  logs.length = 0;
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function service(enabled = true, onDelivered?: () => void): SupervisionService {
  // The extension resolves this from `sessionSitter.*` settings; here we build it directly.
  const supervisorConfig = {
    ...loadConfig({ workspaceRoot: tmp, stateDir }),
    knowledgeLocalRepo: tmp, // no knowledge files here: every tier is simply reported missing
  };
  return new SupervisionService({
    enabled,
    supervisorConfig,
    user: 'alice',
    project: 'demo-project',
    team: 'platform',
    bobDbPath: path.join(tmp, 'no-such-bob.db'),
    pollIntervalSeconds: 1,
  }, log, onDelivered);
}

const pending = (overrides: Partial<PendingApproval> = {}): PendingApproval => ({
  requestId: 'req-abc',
  toolName: 'write_to_file',
  argsText: '{"path":"src/app.ts"}',
  permission: 'write',
  hasCommandUse: false,
  taskId: 'task-1',
  ...overrides,
});

/** Write a transcript export so the orchestrator has something to classify. */
function writeExport(sessionId: string, pendingName = 'read_file'): void {
  const dir = path.join(stateDir, 'history');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({
    schemaVersion: '1.0',
    sessionId,
    source: 'claude',
    turns: [{ index: 0, role: 'user', text: 'read the file' }],
    pendingAction: {
      kind: 'tool_call', name: pendingName, arguments: { path: 'a.ts' }, permission: 'read',
      description: `Read a.ts`, turnIndex: 0, requestId: null,
    },
    waitingReason: 'Awaiting approval.',
  }), 'utf8');
}

describe('configuration', () => {
  it('uses the resolved supervisor configuration it was handed', () => {
    const cfg = service().supervisorConfig();
    expect(cfg.stateDir).toBe(stateDir);
    expect(cfg.workspaceRoot).toBe(path.resolve(tmp));
    expect(cfg.knowledgeLocalRepo).toBe(tmp);
  });

  it('does nothing at all when supervision is disabled', async () => {
    const svc = service(false);
    svc.start();
    expect(logs.join('\n')).toContain('supervision disabled');
    expect(await svc.maybeTrigger(pending())).toBeUndefined();
    svc.dispose();
  });
});

describe('maybeTriggerClaude', () => {
  it('exports, classifies, and records the decision', async () => {
    // A read-only action is decided by the deterministic tier, so no classifier CLI is invoked.
    const svc = service();
    try {
      const record = await svc.maybeTriggerClaude(pending(), async () => {
        writeExport('sess-1');
        return 'sess-1';
      });
      expect(record?.state).toBe('green_completed');
      expect(record?.session_id).toBe('sess-1');
      expect([record?.user, record?.project, record?.team])
        .toEqual(['alice', 'demo-project', 'platform']);
      // The decision is on disk, which is what the activity panel reads.
      expect(fs.readdirSync(path.join(stateDir, 'records')).some(f => f.startsWith('req-')))
        .toBe(true);
    } finally { svc.dispose(); }
  });

  it('hands the same requestId over only once', async () => {
    const svc = service();
    try {
      let exports = 0;
      const doExport = async () => { exports++; writeExport('sess-1'); return 'sess-1'; };
      await svc.maybeTriggerClaude(pending(), doExport);
      await svc.maybeTriggerClaude(pending(), doExport);
      expect(exports).toBe(1);
    } finally { svc.dispose(); }
  });

  it('re-arms after the prompt is no longer pending', async () => {
    const svc = service();
    try {
      let exports = 0;
      const doExport = async () => { exports++; writeExport('sess-1'); return 'sess-1'; };
      await svc.maybeTriggerClaude(pending(), doExport);
      svc.pruneClaude(new Set()); // the request went away
      await svc.maybeTriggerClaude(pending(), doExport);
      expect(exports).toBe(2);
    } finally { svc.dispose(); }
  });

  it('retries next sweep when the export fails', async () => {
    const svc = service();
    try {
      await svc.maybeTriggerClaude(pending(), async () => { throw new Error('no file path'); });
      expect(logs.join('\n')).toContain('export failed');
      // The dedupe mark was released, so a later sweep tries again.
      const record = await svc.maybeTriggerClaude(pending(), async () => {
        writeExport('sess-1'); return 'sess-1';
      });
      expect(record?.state).toBe('green_completed');
    } finally { svc.dispose(); }
  });

  it('retries next sweep when no session could be resolved', async () => {
    const svc = service();
    try {
      expect(await svc.maybeTriggerClaude(pending(), async () => undefined)).toBeUndefined();
      expect(logs.join('\n')).toContain('no target session');
      const record = await svc.maybeTriggerClaude(pending(), async () => {
        writeExport('sess-1'); return 'sess-1';
      });
      expect(record).toBeDefined();
    } finally { svc.dispose(); }
  });

  it('keeps Bob and Claude dedupe sets apart', async () => {
    const svc = service();
    try {
      await svc.maybeTriggerClaude(pending(), async () => { writeExport('sess-1'); return 'sess-1'; });
      // The same requestId on the Bob path is not considered already handled.
      const bob = await svc.maybeTrigger(pending());
      // The export fails (no Bob DB), which is the expected outcome here — the point is that it
      // was attempted at all.
      expect(bob).toBeUndefined();
      expect(logs.join('\n')).toContain('export failed');
    } finally { svc.dispose(); }
  });
});

describe('maybeTrigger (Bob)', () => {
  it('reports an export failure and leaves the prompt for a retry', async () => {
    const svc = service();
    try {
      expect(await svc.maybeTrigger(pending())).toBeUndefined();
      expect(logs.join('\n')).toMatch(/export failed for task-1/);
      svc.prune(new Set(['req-abc'])); // still pending
      expect(await svc.maybeTrigger(pending())).toBeUndefined();
    } finally { svc.dispose(); }
  });
});

describe('the outbox kick', () => {
  it('runs the applier as soon as a delivery is written', async () => {
    let kicks = 0;
    const svc = service(true, () => { kicks++; });
    try {
      // A green decision on a live prompt writes an approval delivery.
      await svc.maybeTriggerClaude(pending(), async () => {
        const dir = path.join(stateDir, 'history');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'sess-1.json'), JSON.stringify({
          sessionId: 'sess-1', source: 'claude',
          turns: [{ index: 0, role: 'user', text: 'read it' }],
          pendingAction: {
            kind: 'tool_call', name: 'read_file', arguments: { path: 'a.ts' },
            permission: 'read', description: 'Read a.ts', requestId: 'req-live',
          },
          waitingReason: 'Awaiting approval.',
        }), 'utf8');
        return 'sess-1';
      });

      expect(kicks).toBeGreaterThan(0);
      const outbox = fs.readdirSync(path.join(stateDir, 'outbox')).filter(f => f.endsWith('.json'));
      expect(outbox).toHaveLength(1);
      const delivery = JSON.parse(
        fs.readFileSync(path.join(stateDir, 'outbox', outbox[0]), 'utf8'));
      expect(delivery).toMatchObject({ channel: 'approval', decision: 'allow', requestId: 'req-live' });
    } finally { svc.dispose(); }
  });
});

describe('the poll loop', () => {
  it('starts, runs at least one pass, and stops cleanly', async () => {
    const svc = service();
    svc.start();
    expect(logs.join('\n')).toContain('supervision started');
    await new Promise(r => setTimeout(r, 60));
    svc.dispose();
    // After dispose no further pass is scheduled.
    const after = logs.length;
    await new Promise(r => setTimeout(r, 60));
    expect(logs.length).toBe(after);
  });

  it('logs a pass error and keeps going', async () => {
    // A transient failure must never kill the loop; otherwise replies stop being consumed and
    // every decision silently times out.
    const svc = service();
    const orch = (svc as unknown as { orch: { poll: () => Promise<unknown> } }).orch;
    const failing = vi.spyOn(orch, 'poll').mockRejectedValueOnce(new Error('transient'));
    try {
      await (svc as unknown as { runPoll: () => Promise<void> }).runPoll();
      expect(logs.join('\n')).toContain('pass error (continuing)');
    } finally {
      failing.mockRestore();
      svc.dispose();
    }
  });
});
