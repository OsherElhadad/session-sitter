import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ClaudeSession {
  sessionId: string;    // UUID from filename (e.g. "d61ee3f8-38ea-4316-8b4e-c90a8dd2e45e")
  projectName: string;  // last path segment of cwd (e.g. "my-project")
  projectPath: string;  // full cwd from first user record
  title: string;        // AI-generated title if available, otherwise first user message (≤60 chars)
  updatedAt: Date;      // file mtime (last write time)
  status: 'idle' | 'waiting' | 'active'; // idle=done, waiting=user sent/no reply yet, active=tools running
}

interface JsonlRecord {
  type?: string;
  cwd?: string;
  aiTitle?: string;     // present in ai-title records written by Claude Code
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

    const stat = await fs.promises.stat(filePath);
    const updatedAt = stat.mtime;

    // VS Code plugin sessions can have large attachment records before the first
    // user message. Read in 16 KB chunks up to 256 KB, collecting:
    //   - firstUserText + projectPath  (from the first user record)
    //   - aiTitle                      (from the ai-title record Claude Code writes)
    // Use aiTitle as the display title when available — it matches what VS Code
    // shows in the editor tab — and fall back to the raw first user message.
    const CHUNK_SIZE = 16384;
    const MAX_BYTES  = 262144;

    const fh = await fs.promises.open(filePath, 'r');
    try {
      let fileOffset = 0;
      let leftover = '';
      let firstUserText: string | null = null;
      let projectPath = '';
      let aiTitle: string | null = null;

      outer: while (fileOffset < MAX_BYTES) {
        const buf = Buffer.alloc(CHUNK_SIZE);
        const { bytesRead } = await fh.read(buf, 0, CHUNK_SIZE, fileOffset);
        if (bytesRead === 0) { break; }
        fileOffset += bytesRead;

        const chunk = leftover + buf.subarray(0, bytesRead).toString('utf8');
        const lines = chunk.split('\n');
        leftover = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) { continue; }
          try {
            const record = JSON.parse(trimmed) as JsonlRecord;

            if (record.type === 'user' && firstUserText === null) {
              const content = record.message?.content;
              let text: string | null = null;
              if (typeof content === 'string' && content.trim().length > 0) {
                text = content.trim();
              } else if (Array.isArray(content)) {
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
                firstUserText = text;
                projectPath = typeof record.cwd === 'string' && record.cwd.length > 0
                  ? record.cwd : '';
              }
            }

            if (record.type === 'ai-title' &&
                typeof record.aiTitle === 'string' &&
                record.aiTitle.trim().length > 0) {
              aiTitle = record.aiTitle.trim();
            }

          } catch {
            // Malformed JSON line — skip
          }
        }

        // Stop once we have both pieces; ai-title appears shortly after the
        // first assistant reply so we never need to read far.
        if (firstUserText !== null && aiTitle !== null) { break outer; }
      }

      if (firstUserText === null) {
        return null;
      }

      const title = (aiTitle ?? firstUserText).slice(0, 60);
      const projectName = projectPath ? path.basename(projectPath) : '';
      const status = await this._readStatus(fh, stat.size);
      return { sessionId, projectName, projectPath, title, updatedAt, status };
    } finally {
      await fh.close();
    }
  }

  // Read the last ~2 KB of the file and return the status inferred from the
  // last parseable record type.
  private async _readStatus(fh: Awaited<ReturnType<typeof fs.promises.open>>, fileSize: number): Promise<'idle' | 'waiting' | 'active'> {
    if (fileSize === 0) {
      return 'idle';
    }
    const TAIL = 2048;
    const offset = Math.max(0, fileSize - TAIL);
    const size = fileSize - offset;
    const buf = Buffer.alloc(size);
    const { bytesRead } = await fh.read(buf, 0, size, offset);
    const chunk = buf.subarray(0, bytesRead).toString('utf8');

    // Walk lines in reverse to find the last parseable record
    const lines = chunk.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed) { continue; }
      try {
        const record = JSON.parse(trimmed) as JsonlRecord;
        if (record.type === 'assistant') { return 'idle'; }
        if (record.type === 'user')      { return 'waiting'; }
        if (record.type === 'tool_use' || record.type === 'tool_result') { return 'active'; }
        // Other record types (queue-operation, attachment, etc.) — keep scanning
      } catch {
        // Partial line at the start of the tail window — skip
      }
    }
    return 'idle';
  }
}
