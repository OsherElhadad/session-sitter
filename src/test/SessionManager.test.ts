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

    it('completed session: last record is assistant → status = idle', async () => {
      const file = await writeTempJsonl(tmpDir, 'done-session', [
        { type: 'user', cwd: '/p', message: { content: 'do something' } },
        { type: 'assistant', message: { content: 'done' } },
      ]);
      const result = await manager._parseSessionFile(file);
      expect(result?.status).toBe('idle');
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
      // Each queue-operation line is ~50 bytes; 50 × 50 = ~2500 bytes > 2 KB tail.
      const unknownLines = Array.from({ length: 50 }, (_, i) =>
        JSON.stringify({ type: 'queue-operation', seq: i, padding: 'x'.repeat(30) })
      );
      const filePath = path.join(tmpDir, 'no-known-tail.jsonl');
      await fs.promises.writeFile(
        filePath,
        [userLine, ...unknownLines].join('\n') + '\n',
        'utf8',
      );
      const result = await manager._parseSessionFile(filePath);
      expect(result?.status).toBe('idle');
    });
  });
});
