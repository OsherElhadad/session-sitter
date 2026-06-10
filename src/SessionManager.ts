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
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(context: vscode.ExtensionContext) {
    this._projectsDir = path.join(os.homedir(), '.claude', 'projects');

    // Initial scan (async; sessions will be populated shortly after construction)
    void this._scanSessions().then(sessions => {
      this._sessions = sessions;
      this._onDidChangeSessions.fire([...this._sessions]);
    });

    // Set up file system watcher for all .jsonl files under the projects directory
    // VS Code handles watching non-existent paths without error.
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(this._projectsDir),
      '**/*.jsonl'
    );
    this._watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const refresh = () => {
      // Debounce rapid watcher events (~250ms) to avoid redundant scans
      if (this._debounceTimer !== undefined) {
        clearTimeout(this._debounceTimer);
      }
      this._debounceTimer = setTimeout(() => {
        this._debounceTimer = undefined;
        void this._scanSessions().then(sessions => {
          this._sessions = sessions;
          this._onDidChangeSessions.fire([...this._sessions]);
        });
      }, 250);
    };

    // Do not pass context.subscriptions; the watcher handles cleanup when disposed.
    this._watcher.onDidCreate(refresh);
    this._watcher.onDidChange(refresh);
    this._watcher.onDidDelete(refresh);

    // Register for automatic disposal
    context.subscriptions.push(this);
  }

  getSessions(): ClaudeSession[] {
    // Return a shallow copy so callers cannot mutate internal state
    return [...this._sessions];
  }

  dispose(): void {
    if (this._debounceTimer !== undefined) {
      clearTimeout(this._debounceTimer);
    }
    this._watcher.dispose();
    this._onDidChangeSessions.dispose();
  }

  private async _scanSessions(): Promise<ClaudeSession[]> {
    const sessions: ClaudeSession[] = [];

    const jsonlFiles = await this._findJsonlFiles(this._projectsDir);
    for (const filePath of jsonlFiles) {
      try {
        const session = await this._parseSessionFile(filePath);
        if (session !== null) {
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

  private async _findJsonlFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...(await this._findJsonlFiles(fullPath)));
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          results.push(fullPath);
        }
      }
    } catch {
      // Directory doesn't exist or isn't readable — return empty
    }
    return results;
  }

  private async _parseSessionFile(filePath: string): Promise<ClaudeSession | null> {
    const sessionId = path.basename(filePath, '.jsonl');

    // Get file mtime
    const stat = await fs.promises.stat(filePath);
    const updatedAt = stat.mtime;

    // Read only the first ~4KB
    let rawChunk: Buffer;
    const fh = await fs.promises.open(filePath, 'r');
    try {
      rawChunk = Buffer.alloc(4096);
      const { bytesRead } = await fh.read(rawChunk, 0, 4096, 0);
      rawChunk = rawChunk.subarray(0, bytesRead);

      const chunk = rawChunk.toString('utf8');
      const lines = chunk.split('\n');

      // When we hit the buffer boundary the last element may be a partial JSON
      // record cut mid-line; drop it to avoid silent parse failures.
      if (bytesRead === 4096) {
        lines.pop();
      }

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
                const b = block as { type?: string; text?: string };
                if (
                  block !== null &&
                  typeof block === 'object' &&
                  b.type === 'text' &&
                  typeof b.text === 'string' &&
                  (b.text ?? '').trim().length > 0
                ) {
                  text = (b.text ?? '').trim();
                  break;
                }
              }
            }

            if (text !== null) {
              const projectPath = typeof record.cwd === 'string' && record.cwd.length > 0
                ? record.cwd
                : '';
              const projectName = projectPath ? path.basename(projectPath) : '';
              return {
                sessionId,
                projectName,
                projectPath,
                title: text.slice(0, 60),
                updatedAt,
              };
            }
          }
        } catch {
          // Malformed JSON line — skip
        }
      }
    } finally {
      await fh.close();
    }

    // No valid user record found; exclude this file from the session list
    return null;
  }
}
