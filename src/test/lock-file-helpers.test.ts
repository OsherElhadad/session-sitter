import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn().mockReturnValue(actual.homedir()) };
});

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

import { readActiveLockFiles, getIPCSocketForPid } from '../SessionManager';

describe('readActiveLockFiles', () => {
  let tmpDir: string;
  let ideDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lock-test-'));
    ideDir = path.join(tmpDir, '.claude', 'ide');
    await fs.promises.mkdir(ideDir, { recursive: true });
    vi.mocked(os.homedir).mockReturnValue(tmpDir);
  });

  afterEach(async () => {
    vi.mocked(os.homedir).mockReset();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when ide directory does not exist', async () => {
    await fs.promises.rm(ideDir, { recursive: true });
    expect(await readActiveLockFiles()).toEqual([]);
  });

  it('returns empty array when all PIDs are dead', async () => {
    await fs.promises.writeFile(
      path.join(ideDir, '12345.lock'),
      JSON.stringify({ pid: 999999999, workspaceFolders: ['/home/user/project'] }),
    );
    expect(await readActiveLockFiles()).toEqual([]);
  });

  it('returns entry for a lock file whose PID is alive', async () => {
    await fs.promises.writeFile(
      path.join(ideDir, '8080.lock'),
      JSON.stringify({ pid: process.pid, workspaceFolders: ['/home/user/project'] }),
    );
    const result = await readActiveLockFiles();
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ pid: process.pid, workspaceFolders: ['/home/user/project'], port: 8080 });
  });

  it('skips entries missing pid', async () => {
    await fs.promises.writeFile(
      path.join(ideDir, '9090.lock'),
      JSON.stringify({ workspaceFolders: ['/home/user/project'] }),
    );
    expect(await readActiveLockFiles()).toEqual([]);
  });

  it('skips malformed JSON', async () => {
    await fs.promises.writeFile(path.join(ideDir, '1111.lock'), 'not json');
    expect(await readActiveLockFiles()).toEqual([]);
  });
});

describe('getIPCSocketForPid', () => {
  afterEach(() => { vi.restoreAllMocks(); /* restores fs.promises.readFile spies */ });

  it('returns socket path when VSCODE_IPC_HOOK_CLI is present', async () => {
    const environ = Buffer.from('HOME=/root\0VSCODE_IPC_HOOK_CLI=/run/test.sock\0PATH=/usr/bin');
    vi.spyOn(fs.promises, 'readFile').mockResolvedValueOnce(environ as unknown as string);
    expect(await getIPCSocketForPid(12345)).toBe('/run/test.sock');
  });

  it('returns null when VSCODE_IPC_HOOK_CLI is absent', async () => {
    const environ = Buffer.from('HOME=/root\0PATH=/usr/bin');
    vi.spyOn(fs.promises, 'readFile').mockResolvedValueOnce(environ as unknown as string);
    expect(await getIPCSocketForPid(12345)).toBeNull();
  });

  it('returns null when /proc/<pid>/environ is unreadable', async () => {
    vi.spyOn(fs.promises, 'readFile').mockRejectedValueOnce(new Error('EACCES'));
    expect(await getIPCSocketForPid(12345)).toBeNull();
  });
});
