import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectIdeCli, discoverOwnIpcSocket, type ProcFs,
  writeWindowEntry, readLiveWindows, removeWindowEntry, windowsDir, type WindowEntry,
} from '../WindowRegistry';

function fakeProc(tree: Record<number, { ppid: number; environ?: string }>): ProcFs {
  return {
    listPids: () => Object.keys(tree).map(Number),
    readPpid: (pid) => tree[pid]?.ppid ?? 1,
    readEnviron: (pid) => tree[pid]?.environ ?? '',
  };
}

describe('detectIdeCli', () => {
  it('returns the remote-cli executable path when present (IBM Bob)', () => {
    const execPath = '/home/u/.bobide-server/bin/abc123/node';
    const readdir = vi.fn().mockReturnValue(['helpers', 'bobide', '.keep']);
    expect(detectIdeCli(execPath, 'IBM Bob', readdir)).toBe(
      '/home/u/.bobide-server/bin/abc123/bin/remote-cli/bobide',
    );
    expect(readdir).toHaveBeenCalledWith('/home/u/.bobide-server/bin/abc123/bin/remote-cli');
  });

  it('falls back to "bobide" by appName when remote-cli dir is unreadable', () => {
    const readdir = vi.fn(() => { throw new Error('ENOENT'); });
    expect(detectIdeCli('/usr/lib/code/node', 'IBM Bob', readdir)).toBe('bobide');
  });

  it('falls back to "code" for VS Code desktop', () => {
    const readdir = vi.fn(() => { throw new Error('ENOENT'); });
    expect(detectIdeCli('/usr/lib/code/node', 'Visual Studio Code', readdir)).toBe('code');
  });
});

describe('discoverOwnIpcSocket', () => {
  const SOCK = '/run/user/1000/vscode-ipc-abc.sock';

  it('returns the socket carried by a descendant of selfPid', () => {
    const proc = fakeProc({
      100: { ppid: 1 },                                   // server
      200: { ppid: 100 },                                 // our ext host (selfPid)
      300: { ppid: 200, environ: `PATH=/x\0VSCODE_IPC_HOOK_CLI=${SOCK}\0` }, // descendant
    });
    expect(discoverOwnIpcSocket(200, proc)).toBe(SOCK);
  });

  it('ignores sockets carried by processes from another window', () => {
    const proc = fakeProc({
      200: { ppid: 1 },                                   // our ext host
      900: { ppid: 1 },                                   // another window ext host
      901: { ppid: 900, environ: `VSCODE_IPC_HOOK_CLI=/run/other.sock\0` },
    });
    expect(discoverOwnIpcSocket(200, proc)).toBeNull();
  });

  it('returns null when no descendant carries the var', () => {
    const proc = fakeProc({ 200: { ppid: 1 }, 300: { ppid: 200, environ: 'PATH=/x\0' } });
    expect(discoverOwnIpcSocket(200, proc)).toBeNull();
  });
});

describe('window registry files', () => {
  let home: string;
  beforeEach(async () => { home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wr-')); });
  afterEach(async () => { await fs.promises.rm(home, { recursive: true, force: true }); });

  const entry = (pid: number): WindowEntry => ({
    pid, workspaceFolders: [`/ws/${pid}`], ideCli: 'bobide', ipcSocket: `/s/${pid}.sock`, updatedAt: 1000,
  });

  it('round-trips a live entry', async () => {
    await writeWindowEntry(entry(42), home);
    const live = await readLiveWindows({ homedir: home, isAlive: () => true, now: 2000 });
    expect(live).toEqual([entry(42)]);
  });

  it('drops dead pids and unlinks their files', async () => {
    await writeWindowEntry(entry(42), home);
    const live = await readLiveWindows({ homedir: home, isAlive: () => false, now: 2000 });
    expect(live).toEqual([]);
    expect(fs.existsSync(path.join(windowsDir(home), '42.json'))).toBe(false);
  });

  it('drops entries older than 24h', async () => {
    await writeWindowEntry(entry(42), home); // updatedAt 1000
    const live = await readLiveWindows({ homedir: home, isAlive: () => true, now: 1000 + 25 * 3600 * 1000 });
    expect(live).toEqual([]);
  });

  it('removeWindowEntry deletes the file', async () => {
    await writeWindowEntry(entry(42), home);
    await removeWindowEntry(42, home);
    expect(fs.existsSync(path.join(windowsDir(home), '42.json'))).toBe(false);
  });
});
