import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  buildTranscript,
  cleanUserContent,
  derivePendingAction,
  readBobTranscript,
  SessionExporter,
  ExportTurn,
} from '../SessionExporter';

// ── Pure transform tests (no DB) ─────────────────────────────────────────────

function taskRow(over: Partial<Record<string, string>> = {}) {
  return {
    id: 'legacy-bob-code-abc',
    title: 'Fix failing test',
    status: 'active',
    env: JSON.stringify({ staticEnvInfo: { primaryWorkspace: '/home/boaz/skillberry' } }),
    approval_config: null,
    project_id: 'file:/home/boaz/skillberry',
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function msg(role: string, data: object, ts = 1000): { role: string; data: string; created_at: number } {
  return { role, data: JSON.stringify({ role, ...data }), created_at: ts };
}

describe('cleanUserContent', () => {
  it('unwraps <user_query>', () => {
    expect(cleanUserContent('<environment_details><user_query>do X</user_query></environment_details>')).toBe('do X');
  });
  it('passes through plain text', () => {
    expect(cleanUserContent('  hello  ')).toBe('hello');
  });
});

describe('buildTranscript', () => {
  it('keeps roles and extracts assistant tool calls', () => {
    const rows = [
      msg('user', { content: '<user_query>Fix the test</user_query>' }, 1),
      msg('assistant', {
        content: 'Running push',
        toolCalls: [{ id: 'tc1', name: 'execute_command', arguments: { command: 'git push origin main' } }],
      }, 2),
    ];
    const t = buildTranscript(taskRow(), rows);
    expect(t.sessionId).toBe('legacy-bob-code-abc');
    expect(t.source).toBe('bob');
    expect(t.projectName).toBe('skillberry');
    expect(t.turns).toHaveLength(2);
    expect(t.turns[0].text).toBe('Fix the test');
    expect(t.turns[1].toolCalls?.[0].name).toBe('execute_command');
    expect(t.pendingAction?.name).toBe('execute_command');
    expect(t.pendingAction?.kind).toBe('tool_call');
  });

  it('links tool results and marks resolved calls as not pending', () => {
    const rows = [
      msg('assistant', { content: '', toolCalls: [{ id: 'tc1', name: 'read_file', arguments: {} }] }, 1),
      msg('tool', {
        content: 'file contents',
        toolUsage: { signature: { id: 'tc1', name: 'read_file' }, permission: 'read' },
      }, 2),
    ];
    const t = buildTranscript(taskRow(), rows);
    expect(t.turns[1].toolResult?.callId).toBe('tc1');
    // The only tool call was resolved -> no pending action.
    expect(t.pendingAction).toBeNull();
  });

  it('classifies ask_followup_question as a question', () => {
    const rows = [
      msg('assistant', { content: '', toolCalls: [{ id: 'q1', name: 'ask_followup_question', arguments: { question: 'rebase?' } }] }, 1),
    ];
    const t = buildTranscript(taskRow(), rows);
    expect(t.pendingAction?.kind).toBe('question');
  });

  it('classifies AskUserQuestion (Claude) as a question', () => {
    const rows = [
      msg('assistant', { content: '', toolCalls: [{ id: 'q1', name: 'AskUserQuestion',
        arguments: { questions: [{ question: 'Pick', header: 'H', options: [{ label: 'A' }], multiSelect: false }] } }] }, 1),
    ];
    const t = buildTranscript(taskRow(), rows);
    expect(t.pendingAction?.kind).toBe('question');
    expect(t.pendingAction?.name).toBe('AskUserQuestion');
  });

  it('parses approval_config JSON', () => {
    const t = buildTranscript(taskRow({ approval_config: JSON.stringify({ mode: 'ask' }) }), []);
    expect(t.approvalConfig).toEqual({ mode: 'ask' });
  });

  it('merges a live pending approval (with requestId) over the DB-derived pending action', () => {
    const livePending = {
      requestId: 'req-live-1', toolName: 'execute_command',
      argsText: JSON.stringify({ command: 'git push origin main' }),
      permission: 'execute', hasCommandUse: true, taskId: 'legacy-bob-code-abc',
    };
    const rows = [msg('user', { content: 'do it' }, 1)]; // DB has no tool call
    const t = buildTranscript(taskRow(), rows, livePending);
    expect(t.pendingAction?.requestId).toBe('req-live-1');
    expect(t.pendingAction?.name).toBe('execute_command');
    expect(t.pendingAction?.kind).toBe('tool_call');
    expect((t.pendingAction?.arguments as { command: string }).command).toBe('git push origin main');
  });

  it('classifies a live-pending AskUserQuestion (Claude) as a question', () => {
    // Regression: the supervision handoff exports via the live-pending path, which must
    // recognize Claude's AskUserQuestion as a question (not a tool_call) so the supervisor
    // relays it for a real answer instead of auto-approving it with no selection.
    const livePending = {
      requestId: 'req-q-1', toolName: 'AskUserQuestion',
      argsText: JSON.stringify({ questions: [{ question: 'Pick', header: 'H', options: [{ label: 'A' }], multiSelect: false }] }),
      permission: 'ask', hasCommandUse: false, taskId: 'legacy-bob-code-abc',
    };
    const rows = [msg('user', { content: 'do it' }, 1)];
    const t = buildTranscript(taskRow(), rows, livePending);
    expect(t.pendingAction?.requestId).toBe('req-q-1');
    expect(t.pendingAction?.name).toBe('AskUserQuestion');
    expect(t.pendingAction?.kind).toBe('question');
  });

  it('classifies a live-pending ask_followup_question (Bob) as a question', () => {
    const livePending = {
      requestId: 'req-q-2', toolName: 'ask_followup_question',
      argsText: JSON.stringify({ question: 'rebase?' }),
      permission: 'ask', hasCommandUse: false, taskId: 'legacy-bob-code-abc',
    };
    const rows = [msg('user', { content: 'do it' }, 1)];
    const t = buildTranscript(taskRow(), rows, livePending);
    expect(t.pendingAction?.kind).toBe('question');
  });
});

describe('derivePendingAction', () => {
  it('returns null when there are no tool calls', () => {
    const turns: ExportTurn[] = [{ index: 0, role: 'user', text: 'hi', timestamp: null }];
    expect(derivePendingAction(turns)).toBeNull();
  });
});

// ── DB round-trip (temp bob.db) ──────────────────────────────────────────────

function createBobDb(dbPath: string): void {
  execFileSync('python3', ['-c', `
import sqlite3
c = sqlite3.connect('${dbPath}')
c.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT, env TEXT, approval_config TEXT, created_at INTEGER, updated_at INTEGER)")
c.execute("CREATE TABLE messages (id TEXT PRIMARY KEY, task_id TEXT, role TEXT, data TEXT, created_at INTEGER)")
c.commit(); c.close()
`]);
}

function insertTask(dbPath: string, id: string): void {
  const env = JSON.stringify({ staticEnvInfo: { primaryWorkspace: '/home/boaz/skillberry' } });
  execFileSync('python3', ['-c', `
import sqlite3, json
c = sqlite3.connect('${dbPath}')
c.execute("INSERT INTO tasks (id, project_id, title, status, env, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  ('${id}', 'file:/home/boaz/skillberry', 'Fix test', 'active', ${JSON.stringify(env)}, 1, 2))
c.commit(); c.close()
`]);
}

function insertMessage(dbPath: string, id: string, taskId: string, dataObj: object, ts: number): void {
  execFileSync('python3', ['-c', `
import sqlite3, json
c = sqlite3.connect('${dbPath}')
c.execute("INSERT INTO messages (id, task_id, role, data, created_at) VALUES (?,?,?,?,?)",
  ('${id}', '${taskId}', ${JSON.stringify((dataObj as { role?: string }).role || 'assistant')}, ${JSON.stringify(JSON.stringify(dataObj))}, ${ts}))
c.commit(); c.close()
`]);
}

describe('readBobTranscript + SessionExporter (temp db)', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-'));
    dbPath = path.join(tmpDir, 'bob.db');
    createBobDb(dbPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads a session and derives the pending action', async () => {
    insertTask(dbPath, 'sess-1');
    insertMessage(dbPath, 'm1', 'sess-1', { role: 'user', content: '<user_query>Fix it</user_query>' }, 1);
    insertMessage(dbPath, 'm2', 'sess-1', {
      role: 'assistant', content: 'push',
      toolCalls: [{ id: 'tc1', name: 'execute_command', arguments: { command: 'git push origin main' } }],
    }, 2);
    const t = await readBobTranscript(dbPath, 'sess-1');
    expect(t.turns).toHaveLength(2);
    expect(t.pendingAction?.name).toBe('execute_command');
  });

  it('throws for an unknown session', async () => {
    await expect(readBobTranscript(dbPath, 'nope')).rejects.toThrow();
  });

  it('writes the export to history/<id>.json', async () => {
    insertTask(dbPath, 'sess-1');
    insertMessage(dbPath, 'm1', 'sess-1', { role: 'user', content: 'hi' }, 1);
    const exporter = new SessionExporter(dbPath);
    const historyDir = path.join(tmpDir, 'history');
    const out = await exporter.exportBob('sess-1', historyDir);
    expect(fs.existsSync(out)).toBe(true);
    const written = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(written.sessionId).toBe('sess-1');
    expect(written.schemaVersion).toBe('1.0');
  });
});
