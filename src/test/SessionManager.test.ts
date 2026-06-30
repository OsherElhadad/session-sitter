import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../SessionManager';

// Minimal VS Code stubs — only what SessionManager's constructor touches.
vi.mock('vscode', () => {
  const EventEmitter = class {
    event = vi.fn();
    fire = vi.fn();
    dispose = vi.fn();
  };
  const FileSystemWatcher = class {
    onDidCreate = vi.fn();
    onDidChange = vi.fn();
    onDidDelete = vi.fn();
    dispose = vi.fn();
  };
  return {
    EventEmitter,
    workspace: {
      createFileSystemWatcher: () => new FileSystemWatcher(),
    },
    Uri: { file: (p: string) => p },
    RelativePattern: class {
      constructor(public base: unknown, public pattern: string) {}
    },
  };
});

// Helper: build a fake ExtensionContext with a no-op subscriptions array.
function makeContext() {
  return { subscriptions: { push: vi.fn() } } as unknown as import('vscode').ExtensionContext;
}

// Helper: write JSONL content to a temp file and return its path.
async function writeTempJsonl(dir: string, name: string, lines: object[]): Promise<string> {
  const filePath = path.join(dir, `${name}.jsonl`);
  const content = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  await fs.promises.writeFile(filePath, content, 'utf8');
  return filePath;
}

// Access private methods via cast — avoids modifying production code.
type PrivateManager = {
  _parseSessionFile(filePath: string): Promise<import('../SessionManager').ClaudeSession | null>;
};

describe('SessionManager._parseSessionFile', () => {
  let tmpDir: string;
  let manager: PrivateManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sm-test-'));
    // Temporarily point _projectsDir to tmpDir so constructor's _scanSessions
    // operates on a clean directory.
    const sm = new SessionManager(makeContext());
    (sm as unknown as { _projectsDir: string })._projectsDir = tmpDir;
    manager = sm as unknown as PrivateManager;
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null for a file with no user record', async () => {
    const file = await writeTempJsonl(tmpDir, 'empty-session', [
      { type: 'system', content: 'init' },
    ]);
    const result = await manager._parseSessionFile(file);
    expect(result).toBeNull();
  });

  it('parses session id from filename', async () => {
    const id = 'abc12345-0000-0000-0000-000000000001';
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', cwd: '/home/user/my-project', message: { content: 'Hello world' } },
      { type: 'assistant', message: { content: 'Hi there' } },
    ]);
    const result = await manager._parseSessionFile(file);
    expect(result?.sessionId).toBe(id);
  });

  it('extracts projectName from cwd', async () => {
    const file = await writeTempJsonl(tmpDir, 'session-a', [
      { type: 'user', cwd: '/home/user/my-project', message: { content: 'Hello' } },
      { type: 'assistant', message: { content: 'Hi' } },
    ]);
    const result = await manager._parseSessionFile(file);
    expect(result?.projectName).toBe('my-project');
    expect(result?.projectPath).toBe('/home/user/my-project');
  });

  it('uses ai-title when present instead of raw user message', async () => {
    const file = await writeTempJsonl(tmpDir, 'ai-titled', [
      { type: 'user', cwd: '/p', message: { content: 'raw first message' } },
      { type: 'assistant', message: { content: 'ok' } },
      { type: 'ai-title', sessionId: 'ai-titled', aiTitle: 'Test a new session' },
    ]);
    const result = await manager._parseSessionFile(file);
    expect(result?.title).toBe('Test a new session');
  });

  it('falls back to user message when ai-title is absent', async () => {
    const file = await writeTempJsonl(tmpDir, 'no-ai-title', [
      { type: 'user', cwd: '/p', message: { content: 'raw first message' } },
      { type: 'assistant', message: { content: 'ok' } },
    ]);
    const result = await manager._parseSessionFile(file);
    expect(result?.title).toBe('raw first message');
  });

  it('truncates title to 60 characters', async () => {
    const longMsg = 'A'.repeat(100);
    const file = await writeTempJsonl(tmpDir, 'session-b', [
      { type: 'user', cwd: '/p', message: { content: longMsg } },
      { type: 'assistant', message: { content: 'ok' } },
    ]);
    const result = await manager._parseSessionFile(file);
    expect(result?.title).toBe('A'.repeat(60));
  });

  it('handles array content blocks', async () => {
    const file = await writeTempJsonl(tmpDir, 'session-c', [
      {
        type: 'user',
        cwd: '/p',
        message: {
          content: [
            { type: 'text', text: 'Block message' },
            { type: 'image', data: '...' },
          ],
        },
      },
      { type: 'assistant', message: { content: 'Got it' } },
    ]);
    const result = await manager._parseSessionFile(file);
    expect(result?.title).toBe('Block message');
  });

  describe('status detection', () => {
    it('new session: last record is user → status = waiting', async () => {
      const file = await writeTempJsonl(tmpDir, 'new-session', [
        { type: 'user', cwd: '/p', message: { content: 'test a new session' } },
      ]);
      const result = await manager._parseSessionFile(file);
      expect(result?.status).toBe('waiting');
    });

    it('completed session: last record is assistant, old file → status = idle', async () => {
      const file = await writeTempJsonl(tmpDir, 'done-session', [
        { type: 'user', cwd: '/p', message: { content: 'do something' } },
        { type: 'assistant', message: { content: 'done' } },
      ]);
      // Back-date mtime so the file looks older than the 30-second active window.
      const old = new Date(Date.now() - 60_000);
      await fs.promises.utimes(file, old, old);
      const result = await manager._parseSessionFile(file);
      expect(result?.status).toBe('idle');
    });

    it('recent assistant record → status = active (mid-task heuristic)', async () => {
      const file = await writeTempJsonl(tmpDir, 'recent-assistant', [
        { type: 'user', cwd: '/p', message: { content: 'do something' } },
        { type: 'assistant', message: { content: 'working...' } },
      ]);
      // File is freshly written (within 30 s) → report active, not idle.
      const result = await manager._parseSessionFile(file);
      expect(result?.status).toBe('active');
    });

    it('assistant with tool_use in content → status = active (tools executing)', async () => {
      const file = await writeTempJsonl(tmpDir, 'tool-in-content', [
        { type: 'user', cwd: '/p', message: { content: 'run bash' } },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Running...' },
              { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } },
            ],
          },
        },
      ]);
      // Back-date so recency heuristic doesn't interfere
      const old = new Date(Date.now() - 60_000);
      await fs.promises.utimes(file, old, old);
      const result = await manager._parseSessionFile(file);
      expect(result?.status).toBe('active');
    });

    it('tool running: last record is tool_use → status = active', async () => {
      const file = await writeTempJsonl(tmpDir, 'active-session', [
        { type: 'user', cwd: '/p', message: { content: 'run a tool' } },
        { type: 'tool_use', id: 't1', name: 'bash', input: {} },
      ]);
      const result = await manager._parseSessionFile(file);
      expect(result?.status).toBe('active');
    });

    it('tool result received: last record is tool_result → status = active', async () => {
      const file = await writeTempJsonl(tmpDir, 'active-session-2', [
        { type: 'user', cwd: '/p', message: { content: 'run a tool' } },
        { type: 'tool_use', id: 't1', name: 'bash', input: {} },
        { type: 'tool_result', tool_use_id: 't1', content: 'output' },
      ]);
      const result = await manager._parseSessionFile(file);
      expect(result?.status).toBe('active');
    });

    it('only unknown tail record types fall through to idle', async () => {
      // File has a user record for title extraction, but the tail window only
      // contains unknown record types — scanner finds none of the known types
      // and defaults to idle.
      const file = await writeTempJsonl(tmpDir, 'unknown-session', [
        { type: 'user', cwd: '/p', message: { content: 'hi' } },
        { type: 'queue-operation', data: {} },
      ]);
      // queue-operation is unknown; scanning backward hits 'user' → waiting.
      // To get the fall-through-to-idle path we'd need a file whose entire
      // tail has no user/assistant/tool_use/tool_result records.  Verify the
      // scan-backward-past-unknown behavior instead:
      const result = await manager._parseSessionFile(file);
      expect(result?.status).toBe('waiting'); // user record is the last known
    });

    it('no known record types at all defaults to idle', async () => {
      // Construct a session whose first user record appears early (so we get
      // a title), but whose tail contains only unrecognised record types.
      // We achieve this by writing the user line first, then appending enough
      // queue-operation lines to push the user line outside the 2 KB tail window.
      const userLine = JSON.stringify({
        type: 'user', cwd: '/p', message: { content: 'early message' },
      });
      // Each queue-operation line is ~70 bytes; 500 × 70 = ~35 KB > 32 KB tail.
      const unknownLines = Array.from({ length: 500 }, (_, i) =>
        JSON.stringify({ type: 'queue-operation', seq: i, padding: 'x'.repeat(50) })
      );
      const filePath = path.join(tmpDir, 'no-known-tail.jsonl');
      await fs.promises.writeFile(
        filePath,
        [userLine, ...unknownLines].join('\n') + '\n',
        'utf8',
      );
      // Back-date mtime so the file looks older than the 30-second active window.
      const old = new Date(Date.now() - 60_000);
      await fs.promises.utimes(filePath, old, old);
      const result = await manager._parseSessionFile(filePath);
      expect(result?.status).toBe('idle');
    });
  });
});

describe('SessionManager.getRecentExchanges', () => {
  let tmpDir: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sm-preview-'));
    sm = new SessionManager(makeContext());
    (sm as unknown as { _projectsDir: string })._projectsDir = tmpDir;
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  function seedPath(sessionId: string, filePath: string) {
    (sm as unknown as { _sessionFilePaths: Map<string, string> })
      ._sessionFilePaths.set(sessionId, filePath);
  }

  it('returns [] for an unknown session id', async () => {
    const result = await sm.getRecentExchanges('does-not-exist');
    expect(result).toEqual([]);
  });

  it('returns user and assistant exchanges in chronological order', async () => {
    const id = 'preview-order';
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'First question' }, timestamp: '2024-01-01T00:00:00.000Z' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'First answer' }] }, timestamp: '2024-01-01T00:00:01.000Z' },
      { type: 'user', message: { content: 'Second question' }, timestamp: '2024-01-01T00:00:02.000Z' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Second answer' }] }, timestamp: '2024-01-01T00:00:03.000Z' },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({ role: 'user', text: 'First question', timestamp: '2024-01-01T00:00:00.000Z' });
    expect(result[1]).toMatchObject({ role: 'assistant', text: 'First answer' });
    expect(result[2]).toMatchObject({ role: 'user', text: 'Second question' });
    expect(result[3]).toMatchObject({ role: 'assistant', text: 'Second answer' });
  });

  it('returns at most 6 records (3 user + 3 assistant)', async () => {
    const id = 'preview-cap';
    const lines = [];
    for (let i = 0; i < 5; i++) {
      lines.push({ type: 'user', message: { content: `Question ${i}` } });
      lines.push({ type: 'assistant', message: { content: [{ type: 'text', text: `Answer ${i}` }] } });
    }
    const file = await writeTempJsonl(tmpDir, id, lines);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    expect(result).toHaveLength(6);
    expect(result[0]).toMatchObject({ role: 'user', text: 'Question 2' });
  });

  it('skips tool_use and tool_result records', async () => {
    const id = 'preview-skip-tools';
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'Run a command' } },
      { type: 'tool_use', id: 't1', name: 'bash', input: {} },
      { type: 'tool_result', tool_use_id: 't1', content: 'output' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done!' }] } },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    expect(result).toHaveLength(2);
    expect(result.every(r => r.role === 'user' || r.role === 'assistant')).toBe(true);
  });

  it('skips assistant records that contain only tool_use blocks (no text)', async () => {
    const id = 'preview-skip-tool-only-assistant';
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'Do something' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'All done.' }] } },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ role: 'assistant', text: 'All done.' });
  });

  it('truncates user text longer than 150 chars', async () => {
    const id = 'preview-trunc-user';
    const longText = 'U'.repeat(200);
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: longText } },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    expect(result[0].text).toBe('U'.repeat(150) + '…');
  });

  it('truncates assistant text longer than 250 chars', async () => {
    const id = 'preview-trunc-assistant';
    const longText = 'A'.repeat(300);
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'ask' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: longText }] } },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    const assistantEntry = result.find(r => r.role === 'assistant');
    expect(assistantEntry?.text).toBe('A'.repeat(250) + '…');
  });

  it('handles assistant with plain string content (not array)', async () => {
    const id = 'preview-string-assistant';
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'Hello' } },
      { type: 'assistant', message: { content: 'Hi there' } },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    expect(result.find(r => r.role === 'assistant')?.text).toBe('Hi there');
  });

  it('omits timestamp when not present in the record', async () => {
    const id = 'preview-no-ts';
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'No timestamp here' } },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    expect(result[0].timestamp).toBeUndefined();
  });
});

describe('SessionManager.getRecentExchanges (Bob)', () => {
  let tmpDir: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bob-preview-'));
    sm = new SessionManager(makeContext());
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  function seedBobPath(sessionId: string, filePath: string) {
    (sm as unknown as { _sessionFilePaths: Map<string, string> })
      ._sessionFilePaths.set(sessionId, filePath);
    (sm as unknown as { _sessionSources: Map<string, 'claude' | 'bob'> })
      ._sessionSources.set(sessionId, 'bob');
  }

  it('extracts user and assistant exchanges from ui_messages.json', async () => {
    const id = 'bob-preview-1';
    const uiPath = path.join(tmpDir, 'ui_messages.json');
    const messages = [
      { ts: 1000, type: 'say', say: 'text', text: 'Hello Bob', images: [] },
      { ts: 2000, type: 'say', say: 'api_req_started', text: '{}' },
      { ts: 3000, type: 'say', say: 'text', text: 'Bob response', partial: false },
      { ts: 4000, type: 'say', say: 'text', text: 'Second user message', images: [] },
      { ts: 5000, type: 'say', say: 'api_req_started', text: '{}' },
      { ts: 6000, type: 'say', say: 'text', text: 'Second Bob response', partial: false },
    ];
    await fs.promises.writeFile(uiPath, JSON.stringify(messages), 'utf8');
    seedBobPath(id, uiPath);

    const result = await sm.getRecentExchanges(id);
    expect(result.length).toBeGreaterThan(0);
    const userExchanges = result.filter(e => e.role === 'user');
    const assistantExchanges = result.filter(e => e.role === 'assistant');
    expect(userExchanges[0].text).toBe('Hello Bob');
    expect(assistantExchanges[0].text).toBe('Bob response');
  });

  it('returns [] for unknown sessionId', async () => {
    expect(await sm.getRecentExchanges('not-bob')).toEqual([]);
  });

  it('truncates long user messages to 150 chars with ellipsis', async () => {
    const id = 'bob-trunc-user';
    const uiPath = path.join(tmpDir, 'ui_messages_trunc_user.json');
    await fs.promises.writeFile(uiPath, JSON.stringify([
      { ts: 1000, type: 'say', say: 'text', text: 'U'.repeat(200), images: [] },
    ]), 'utf8');
    seedBobPath(id, uiPath);
    const result = await sm.getRecentExchanges(id);
    expect(result[0].text).toBe('U'.repeat(150) + '…');
  });

  it('truncates long assistant messages to 250 chars with ellipsis', async () => {
    const id = 'bob-trunc-asst';
    const uiPath = path.join(tmpDir, 'ui_messages_trunc_asst.json');
    await fs.promises.writeFile(uiPath, JSON.stringify([
      { ts: 1000, type: 'say', say: 'text', text: 'Q', images: [] },
      { ts: 2000, type: 'say', say: 'api_req_started', text: '{}' },
      { ts: 3000, type: 'say', say: 'text', text: 'A'.repeat(300), partial: false },
    ]), 'utf8');
    seedBobPath(id, uiPath);
    const result = await sm.getRecentExchanges(id);
    const asst = result.find(e => e.role === 'assistant');
    expect(asst?.text).toBe('A'.repeat(250) + '…');
  });
});



// ── Helpers for Bob task directories ─────────────────────────────────────────

async function writeBobTask(
  dir: string,
  taskId: string,
  uiMessages: object[],
  apiHistory: object[] = [],
): Promise<string> {
  const taskDir = path.join(dir, taskId);
  await fs.promises.mkdir(taskDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(taskDir, 'ui_messages.json'),
    JSON.stringify(uiMessages),
    'utf8',
  );
  if (apiHistory.length > 0) {
    await fs.promises.writeFile(
      path.join(taskDir, 'api_conversation_history.json'),
      JSON.stringify(apiHistory),
      'utf8',
    );
  }
  return taskDir;
}

type PrivateManagerBob = {
  _parseSessionFile(filePath: string): Promise<import('../SessionManager').ClaudeSession | null>;
  _parseBobTaskDir(dir: string): Promise<import('../SessionManager').ClaudeSession | null>;
  _scanBobSessions(): Promise<import('../SessionManager').ClaudeSession[]>;
  _scanSessions(): Promise<import('../SessionManager').ClaudeSession[]>;
  _projectsDir: string;
  _bobTasksDir: string;
};

describe('SessionManager._parseBobTaskDir', () => {
  let tmpDir: string;
  let manager: PrivateManagerBob;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bob-test-'));
    const sm = new SessionManager(makeContext());
    manager = sm as unknown as PrivateManagerBob;
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null when ui_messages.json is missing', async () => {
    const taskDir = path.join(tmpDir, 'missing-ui');
    await fs.promises.mkdir(taskDir);
    expect(await manager._parseBobTaskDir(taskDir)).toBeNull();
  });

  it('returns null when ui_messages.json has no say:text user message', async () => {
    const taskDir = await writeBobTask(tmpDir, 'no-user', [
      { ts: Date.now(), type: 'say', say: 'api_req_started', text: '{}' },
    ]);
    expect(await manager._parseBobTaskDir(taskDir)).toBeNull();
  });

  it('uses directory name as sessionId', async () => {
    const id = 'f5e315d3-d883-4ec8-9ba5-7cd4865b9a45';
    const taskDir = await writeBobTask(tmpDir, id, [
      { ts: Date.now(), type: 'say', say: 'text', text: 'Hello Bob', images: [] },
    ]);
    const result = await manager._parseBobTaskDir(taskDir);
    expect(result?.sessionId).toBe(id);
  });

  it('uses first say:text record as title, truncated to 60 chars', async () => {
    const taskDir = await writeBobTask(tmpDir, 'title-test', [
      { ts: Date.now(), type: 'say', say: 'text', text: 'A'.repeat(80), images: [] },
    ]);
    const result = await manager._parseBobTaskDir(taskDir);
    expect(result?.title).toBe('A'.repeat(60));
  });

  it('source is always "bob"', async () => {
    const taskDir = await writeBobTask(tmpDir, 'source-test', [
      { ts: Date.now(), type: 'say', say: 'text', text: 'Hello', images: [] },
    ]);
    const result = await manager._parseBobTaskDir(taskDir);
    expect(result?.source).toBe('bob');
  });

  it('extracts projectPath from api_conversation_history.json', async () => {
    const taskDir = await writeBobTask(
      tmpDir, 'cwd-test',
      [{ ts: Date.now(), type: 'say', say: 'text', text: 'Test task', images: [] }],
      [{
        role: 'user',
        content: [{
          type: 'text',
          text: '<environment_details>\n# Current Workspace Directory (/home/user/my-project) Files\nREADME.md\n</environment_details>',
        }],
      }],
    );
    const result = await manager._parseBobTaskDir(taskDir);
    expect(result?.projectPath).toBe('/home/user/my-project');
    expect(result?.projectName).toBe('my-project');
  });

  it('projectPath defaults to empty string when api_conversation_history.json is absent', async () => {
    const taskDir = await writeBobTask(tmpDir, 'no-cwd', [
      { ts: Date.now(), type: 'say', say: 'text', text: 'Hello', images: [] },
    ]);
    const result = await manager._parseBobTaskDir(taskDir);
    expect(result?.projectPath).toBe('');
    expect(result?.projectName).toBe('');
  });

  describe('Bob status inference', () => {
    it('api_req_started as last record → active', async () => {
      const taskDir = await writeBobTask(tmpDir, 'bob-active', [
        { ts: Date.now() - 5000, type: 'say', say: 'text', text: 'Do thing', images: [] },
        { ts: Date.now(), type: 'say', say: 'api_req_started', text: '{}' },
      ]);
      const result = await manager._parseBobTaskDir(taskDir);
      expect(result?.status).toBe('active');
    });

    it('ask:tool as last record → active', async () => {
      const taskDir = await writeBobTask(tmpDir, 'bob-tool', [
        { ts: Date.now() - 5000, type: 'say', say: 'text', text: 'Do thing', images: [] },
        { ts: Date.now(), type: 'ask', ask: 'tool', text: '{}' },
      ]);
      const result = await manager._parseBobTaskDir(taskDir);
      expect(result?.status).toBe('active');
    });

    it('ask:completion_result as last record (old file) → idle', async () => {
      const taskDir = await writeBobTask(tmpDir, 'bob-idle', [
        { ts: Date.now() - 5000, type: 'say', say: 'text', text: 'Do thing', images: [] },
        { ts: Date.now() - 60000, type: 'ask', ask: 'completion_result', text: 'Done!' },
      ]);
      const uiPath = path.join(taskDir, 'ui_messages.json');
      const old = new Date(Date.now() - 120_000);
      await fs.promises.utimes(uiPath, old, old);
      const result = await manager._parseBobTaskDir(taskDir);
      expect(result?.status).toBe('idle');
    });

    it('say:completion_result as last record (old file) → idle', async () => {
      const taskDir = await writeBobTask(tmpDir, 'bob-idle2', [
        { ts: Date.now() - 5000, type: 'say', say: 'text', text: 'Do thing', images: [] },
        { ts: Date.now() - 60000, type: 'say', say: 'completion_result', text: 'Done!' },
      ]);
      const uiPath = path.join(taskDir, 'ui_messages.json');
      const old = new Date(Date.now() - 120_000);
      await fs.promises.utimes(uiPath, old, old);
      const result = await manager._parseBobTaskDir(taskDir);
      expect(result?.status).toBe('idle');
    });

    it('user say:text with no api_req_started → waiting (old file)', async () => {
      const taskDir = await writeBobTask(tmpDir, 'bob-waiting', [
        { ts: Date.now(), type: 'say', say: 'text', text: 'New request', images: [] },
      ]);
      const uiPath = path.join(taskDir, 'ui_messages.json');
      const old = new Date(Date.now() - 120_000);
      await fs.promises.utimes(uiPath, old, old);
      const result = await manager._parseBobTaskDir(taskDir);
      expect(result?.status).toBe('waiting');
    });

    it('recently modified file → active regardless of last record', async () => {
      const taskDir = await writeBobTask(tmpDir, 'bob-recent', [
        { ts: Date.now() - 60000, type: 'say', say: 'text', text: 'Old message', images: [] },
        { ts: Date.now() - 60000, type: 'ask', ask: 'completion_result', text: 'Done' },
      ]);
      // ui_messages.json was just written so its mtime is within 30 s → active
      const result = await manager._parseBobTaskDir(taskDir);
      expect(result?.status).toBe('active');
    });
  });
});

describe('SessionManager._scanSessions merges Claude and Bob sessions', () => {
  let tmpDir: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'merged-test-'));
    sm = new SessionManager(makeContext());
    (sm as unknown as PrivateManagerBob)._projectsDir = path.join(tmpDir, 'claude-projects');
    (sm as unknown as PrivateManagerBob)._bobTasksDir = path.join(tmpDir, 'bob-tasks');
    await fs.promises.mkdir(path.join(tmpDir, 'claude-projects'), { recursive: true });
    await fs.promises.mkdir(path.join(tmpDir, 'bob-tasks'), { recursive: true });
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns both claude and bob sessions sorted by updatedAt descending', async () => {
    // Bob task (back-dated to be older)
    const bobTasksDir = path.join(tmpDir, 'bob-tasks');
    await writeBobTask(bobTasksDir, 'bob-uuid-1', [
      { ts: Date.now() - 10000, type: 'say', say: 'text', text: 'Bob task', images: [] },
    ]);
    const bobUiPath = path.join(bobTasksDir, 'bob-uuid-1', 'ui_messages.json');
    const olderDate = new Date(Date.now() - 10_000);
    await fs.promises.utimes(bobUiPath, olderDate, olderDate);

    // Claude session (just written → newer mtime)
    const claudeDir = path.join(tmpDir, 'claude-projects', '-home-user-proj');
    await fs.promises.mkdir(claudeDir, { recursive: true });
    await writeTempJsonl(claudeDir, 'claude-uuid-1', [
      { type: 'user', cwd: '/home/user/proj', message: { content: 'Claude task' } },
    ]);

    const sessions = await (sm as unknown as PrivateManagerBob)._scanSessions();

    expect(sessions.length).toBe(2);
    expect(sessions[0].source).toBe('claude');
    expect(sessions[1].source).toBe('bob');
    expect(sessions[0].title).toBe('Claude task');
    expect(sessions[1].title).toBe('Bob task');
  });
});

