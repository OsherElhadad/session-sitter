import * as fs from 'fs';
import * as path from 'path';

export interface WindowEntry {
  pid: number;
  workspaceFolders: string[];
  ideCli: string;
  ipcSocket: string;
  updatedAt: number;
}

const HELPER_NAMES = new Set(['helpers']);

// Determine the CLI used to focus a window. On remote IDEs the launcher lives in
// <serverBin>/bin/remote-cli/ next to the node execPath (Bob → "bobide", VS Code → "code").
// Returns an absolute path when found, else a bare name resolved via PATH.
export function detectIdeCli(
  execPath: string = process.execPath,
  appName = '',
  readdir: (p: string) => string[] = fs.readdirSync,
): string {
  const cliDir = path.join(path.dirname(execPath), 'bin', 'remote-cli');
  try {
    const exec = readdir(cliDir).find(e => !HELPER_NAMES.has(e) && !e.startsWith('.'));
    if (exec) { return path.join(cliDir, exec); }
  } catch { /* not a remote IDE layout */ }
  if (appName.toLowerCase().includes('bob')) { return 'bobide'; }
  return 'code';
}

export interface ProcFs {
  listPids(): number[];
  readEnviron(pid: number): string;
  readPpid(pid: number): number;
}

const realProcFs: ProcFs = {
  listPids: () => fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(Number),
  readEnviron: (pid) => { try { return fs.readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch { return ''; } },
  readPpid: (pid) => {
    try {
      // /proc/<pid>/stat: "pid (comm) state ppid ..." — comm may contain spaces/parens,
      // so parse after the last ')'.
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const after = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      return parseInt(after[1], 10) || 1; // fields after comm: state(0), ppid(1)
    } catch { return 1; }
  },
};

function isDescendantOf(pid: number, ancestor: number, proc: ProcFs): boolean {
  let cur = pid;
  for (let i = 0; i < 64 && cur > 1; i++) {
    const ppid = proc.readPpid(cur);
    if (ppid === ancestor) { return true; }
    if (ppid === cur) { break; }
    cur = ppid;
  }
  return false;
}

// Find this window's own VSCODE_IPC_HOOK_CLI by scanning descendant processes.
// Returns null on platforms without /proc or when no descendant carries the var.
export function discoverOwnIpcSocket(
  selfPid: number = process.pid,
  proc: ProcFs = realProcFs,
): string | null {
  let pids: number[];
  try { pids = proc.listPids(); } catch { return null; }
  for (const pid of pids) {
    const env = proc.readEnviron(pid);
    const m = env.split('\0').find(e => e.startsWith('VSCODE_IPC_HOOK_CLI='));
    if (!m) { continue; }
    if (pid === selfPid || isDescendantOf(pid, selfPid, proc)) {
      return m.slice('VSCODE_IPC_HOOK_CLI='.length);
    }
  }
  return null;
}
