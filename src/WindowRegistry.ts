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
