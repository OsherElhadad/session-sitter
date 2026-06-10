import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ClaudeSession {
  sessionId: string;    // UUID from filename (e.g. "d61ee3f8-38ea-4316-8b4e-c90a8dd2e45e")
  projectName: string;  // last path segment of cwd (e.g. "my-project")
  projectPath: string;  // full cwd from first user record
  title: string;        // first user message text, truncated to 60 chars
  updatedAt: Date;      // file mtime (last write time)
}

interface JsonlRecord {
  type?: string;
  cwd?: string;
  message?: {
    content?: string | unknown[];
  };
}

export class SessionManager implements vscode.Disposable {
  private readonly _onDidChangeSessions = new vscode.EventEmitter<ClaudeSession[]>();
  readonly onDidChangeSessions: vscode.Event<ClaudeSession[]> = this._onDidChangeSessions.event;

  private _sessions: ClaudeSession[] = [];
  private readonly _watcher: vscode.FileSystemWatcher;
  private readonly _projectsDir: string;

  constructor(context: vscode.ExtensionContext) {
    this._projectsDir = path.join(os.homedir(), '.claude', 'projects');

    // Initial scan
    this._sessions = this._scanSessions();

    // Set up file system watcher for all .jsonl files under the projects directory
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(this._projectsDir),
      '**/*.jsonl'
    );
    this._watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const refresh = () => {
      this._sessions = this._scanSessions();
      this._onDidChangeSessions.fire(this._sessions);
    };

    this._watcher.onDidCreate(refresh, this, context.subscriptions);
    this._watcher.onDidChange(refresh, this, context.subscriptions);
    this._watcher.onDidDelete(refresh, this, context.subscriptions);

    // Register for automatic disposal
    context.subscriptions.push(this);
  }

  getSessions(): ClaudeSession[] {
    return this._sessions;
  }

  dispose(): void {
    this._watcher.dispose();
    this._onDidChangeSessions.dispose();
  }

  private _scanSessions(): ClaudeSession[] {
    const sessions: ClaudeSession[] = [];

    const jsonlFiles = this._findJsonlFiles(this._projectsDir);
    for (const filePath of jsonlFiles) {
      try {
        const session = this._parseSessionFile(filePath);
        if (session) {
          sessions.push(session);
        }
      } catch {
        // Silently skip files that fail to parse
      }
    }

    // Sort by updatedAt descending (most recent first)
    sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return sessions;
  }

  private _findJsonlFiles(dir: string): string[] {
    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...this._findJsonlFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          results.push(fullPath);
        }
      }
    } catch {
      // Directory doesn't exist or isn't readable — return empty
    }
    return results;
  }

  private _parseSessionFile(filePath: string): ClaudeSession | null {
    const sessionId = path.basename(filePath, '.jsonl');

    // Get file mtime
    const stat = fs.statSync(filePath);
    const updatedAt = stat.mtime;

    // Read only the first ~4KB
    const fd = fs.openSync(filePath, 'r');
    let rawChunk: Buffer;
    try {
      rawChunk = Buffer.alloc(4096);
      const bytesRead = fs.readSync(fd, rawChunk, 0, 4096, 0);
      rawChunk = rawChunk.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }

    const chunk = rawChunk.toString('utf8');
    const lines = chunk.split('\n');

    let title = sessionId;
    let projectPath = '';
    let projectName = '';
    let foundUser = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const record = JSON.parse(trimmed) as JsonlRecord;
        if (record.type === 'user') {
          const content = record.message?.content;
          let text: string | null = null;
          if (typeof content === 'string' && content.trim().length > 0) {
            text = content.trim();
          } else if (Array.isArray(content)) {
            // Content may be an array of content blocks; find first text block
            for (const block of content) {
              if (
                block !== null &&
                typeof block === 'object' &&
                (block as { type?: string; text?: string }).type === 'text' &&
                typeof (block as { type?: string; text?: string }).text === 'string' &&
                ((block as { type?: string; text?: string }).text ?? '').trim().length > 0
              ) {
                text = ((block as { type?: string; text?: string }).text ?? '').trim();
                break;
              }
            }
          }

          if (text !== null) {
            title = text.slice(0, 60);
            if (typeof record.cwd === 'string' && record.cwd.length > 0) {
              projectPath = record.cwd;
              projectName = path.basename(projectPath);
            }
            foundUser = true;
            break;
          }
        }
      } catch {
        // Malformed JSON line — skip
      }
    }

    if (!foundUser) {
      // No valid user record; use defaults
      title = sessionId;
      projectPath = '';
      projectName = '';
    }

    return {
      sessionId,
      projectName,
      projectPath,
      title,
      updatedAt,
    };
  }
}
