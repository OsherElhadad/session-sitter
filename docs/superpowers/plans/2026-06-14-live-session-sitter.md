# Live Session Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the disk-scan-driven tab bar with a user-managed `LiveSessionRegistry` so the switcher shows only the sessions the user has pinned, keeps them alive as hidden editor tabs, and correctly switches between them without opening new OS windows.

**Architecture:** A new `LiveSessionRegistry` class holds an ordered list of session IDs persisted in `ExtensionContext.globalState`. `SessionSitterViewProvider` is rewired to drive its tab bar from the registry rather than from the full disk scan. New sessions are auto-added to the registry when a fresh JSONL file is detected within 60 s of creation. A collapsible history panel in the webview lets users add any past session.

**Tech Stack:** TypeScript, VS Code Extension API, plain HTML/CSS/JS webview, vitest for unit tests.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/LiveSessionRegistry.ts` | **Create** | Ordered session ID list; globalState persistence; onDidChange event |
| `src/test/LiveSessionRegistry.test.ts` | **Create** | Unit tests for registry logic |
| `src/SessionSitterViewProvider.ts` | **Modify** | Accept registry; drive tabs from it; handle history messages |
| `src/extension.ts` | **Modify** | Instantiate registry; wire auto-add on new JSONL creation |
| `src/webview/main.js` | **Modify** | History panel toggle; updateHistory handler; addFromHistory message |
| `src/webview/styles.css` | **Modify** | History panel styles |
| `package.json` | **Modify** | Add vitest devDependency and test script |

---

## Task 1: Test infrastructure

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `src/test/LiveSessionRegistry.test.ts` (stub)

- [ ] **Step 1: Add vitest to package.json**

Open `package.json`. Add under `devDependencies` and `scripts`:

```json
{
  "scripts": {
    "vscode:prepublish": "npm run compile",
    "compile": "tsc -p ./",
    "watch": "tsc -watch -p ./",
    "lint": "eslint src",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/vscode": "^1.64.0",
    "typescript": "^5.3.0",
    "@typescript-eslint/eslint-plugin": "^6.0.0",
    "@typescript-eslint/parser": "^6.0.0",
    "eslint": "^8.0.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create vitest config**

Create `vitest.config.ts` at the project root:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/test/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 3: Create empty test file**

Create `src/test/LiveSessionRegistry.test.ts`:

```typescript
// Tests added in Task 2
```

- [ ] **Step 4: Install vitest**

```bash
npm install
```

Expected: vitest appears in `node_modules/.bin/vitest`.

- [ ] **Step 5: Verify test runner works**

```bash
npm test
```

Expected output: `Test Files  0 passed` (no tests yet, exits 0).

- [ ] **Step 6: Commit**

```bash
git add package.json vitest.config.ts src/test/LiveSessionRegistry.test.ts
git commit -m "chore: add vitest for unit tests"
```

---

## Task 2: LiveSessionRegistry

**Files:**
- Create: `src/LiveSessionRegistry.ts`
- Modify: `src/test/LiveSessionRegistry.test.ts`

### Storage interface and class

- [ ] **Step 1: Write failing tests**

Replace `src/test/LiveSessionRegistry.test.ts` with:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { LiveSessionRegistry } from '../LiveSessionRegistry';

// In-memory storage mock — no vscode dependency needed
function makeStorage(initial: string[] = []) {
  const store: Record<string, unknown> = { liveSessionIds: initial };
  return {
    get: <T>(key: string) => store[key] as T | undefined,
    update: (key: string, value: unknown) => { store[key] = value; },
  };
}

describe('LiveSessionRegistry', () => {
  let storage: ReturnType<typeof makeStorage>;
  let registry: LiveSessionRegistry;

  beforeEach(() => {
    storage = makeStorage();
    registry = new LiveSessionRegistry(storage);
  });

  it('starts empty when storage is empty', () => {
    expect(registry.getIds()).toEqual([]);
  });

  it('loads persisted ids from storage on construction', () => {
    const s = makeStorage(['aaa', 'bbb']);
    const r = new LiveSessionRegistry(s);
    expect(r.getIds()).toEqual(['aaa', 'bbb']);
  });

  it('add appends a new id', () => {
    registry.add('aaa');
    expect(registry.getIds()).toEqual(['aaa']);
  });

  it('add is idempotent — does not duplicate', () => {
    registry.add('aaa');
    registry.add('aaa');
    expect(registry.getIds()).toEqual(['aaa']);
  });

  it('add persists to storage', () => {
    registry.add('aaa');
    expect(storage.get<string[]>('liveSessionIds')).toEqual(['aaa']);
  });

  it('remove deletes an existing id', () => {
    registry.add('aaa');
    registry.add('bbb');
    registry.remove('aaa');
    expect(registry.getIds()).toEqual(['bbb']);
  });

  it('remove is a no-op for unknown id', () => {
    registry.add('aaa');
    registry.remove('zzz');
    expect(registry.getIds()).toEqual(['aaa']);
  });

  it('remove persists to storage', () => {
    registry.add('aaa');
    registry.add('bbb');
    registry.remove('aaa');
    expect(storage.get<string[]>('liveSessionIds')).toEqual(['bbb']);
  });

  it('onDidChange fires on add with new ids', () => {
    const received: string[][] = [];
    registry.onDidChange(ids => received.push(ids));
    registry.add('aaa');
    expect(received).toEqual([['aaa']]);
  });

  it('onDidChange fires on remove with new ids', () => {
    registry.add('aaa');
    registry.add('bbb');
    const received: string[][] = [];
    registry.onDidChange(ids => received.push(ids));
    registry.remove('aaa');
    expect(received).toEqual([['bbb']]);
  });

  it('onDidChange does NOT fire when add is a duplicate', () => {
    registry.add('aaa');
    const received: string[][] = [];
    registry.onDidChange(ids => received.push(ids));
    registry.add('aaa');
    expect(received).toEqual([]);
  });

  it('onDidChange does NOT fire when remove targets unknown id', () => {
    registry.add('aaa');
    const received: string[][] = [];
    registry.onDidChange(ids => received.push(ids));
    registry.remove('zzz');
    expect(received).toEqual([]);
  });

  it('disposed listener is not called', () => {
    const received: string[][] = [];
    const sub = registry.onDidChange(ids => received.push(ids));
    sub.dispose();
    registry.add('aaa');
    expect(received).toEqual([]);
  });

  it('getIds returns a copy — mutation does not affect registry', () => {
    registry.add('aaa');
    const ids = registry.getIds();
    ids.push('injected');
    expect(registry.getIds()).toEqual(['aaa']);
  });
});
```

- [ ] **Step 2: Run tests — verify they all fail**

```bash
npm test
```

Expected: `Cannot find module '../LiveSessionRegistry'` — all tests fail.

- [ ] **Step 3: Create LiveSessionRegistry**

Create `src/LiveSessionRegistry.ts`:

```typescript
export interface IRegistryStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): void | Thenable<void>;
}

export class LiveSessionRegistry {
  private static readonly KEY = 'liveSessionIds';

  private _ids: string[];
  private readonly _listeners: Array<(ids: string[]) => void> = [];

  constructor(private readonly _storage: IRegistryStorage) {
    this._ids = _storage.get<string[]>(LiveSessionRegistry.KEY) ?? [];
  }

  add(sessionId: string): void {
    if (this._ids.includes(sessionId)) {
      return;
    }
    this._ids = [...this._ids, sessionId];
    void this._storage.update(LiveSessionRegistry.KEY, [...this._ids]);
    this._notify();
  }

  remove(sessionId: string): void {
    const next = this._ids.filter(id => id !== sessionId);
    if (next.length === this._ids.length) {
      return;
    }
    this._ids = next;
    void this._storage.update(LiveSessionRegistry.KEY, [...this._ids]);
    this._notify();
  }

  getIds(): string[] {
    return [...this._ids];
  }

  onDidChange(listener: (ids: string[]) => void): { dispose(): void } {
    this._listeners.push(listener);
    return {
      dispose: () => {
        const i = this._listeners.indexOf(listener);
        if (i >= 0) {
          this._listeners.splice(i, 1);
        }
      },
    };
  }

  dispose(): void {
    this._listeners.length = 0;
  }

  private _notify(): void {
    const ids = this.getIds();
    for (const l of [...this._listeners]) {
      l(ids);
    }
  }
}
```

- [ ] **Step 4: Run tests — verify they all pass**

```bash
npm test
```

Expected: `14 passed` (all green).

- [ ] **Step 5: Compile TypeScript**

```bash
npm run compile
```

Expected: exits 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/LiveSessionRegistry.ts src/test/LiveSessionRegistry.test.ts vitest.config.ts
git commit -m "feat: add LiveSessionRegistry with persistence and event"
```

---

## Task 3: Update extension.ts

Wire `LiveSessionRegistry` into the extension, pass it to the provider, and auto-add freshly created sessions.

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Read current extension.ts**

```bash
cat src/extension.ts
```

- [ ] **Step 2: Replace extension.ts**

```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { SessionManager } from './SessionManager';
import { SessionSitterViewProvider } from './SessionSitterViewProvider';
import { LiveSessionRegistry } from './LiveSessionRegistry';

const NEW_SESSION_WINDOW_MS = 60_000; // auto-add JSONL files created within this window

export function activate(context: vscode.ExtensionContext) {
  const sessionManager = new SessionManager(context);

  // globalState satisfies IRegistryStorage (get/update with matching signatures)
  const registry = new LiveSessionRegistry(context.globalState);
  context.subscriptions.push(registry);

  const provider = new SessionSitterViewProvider(
    context.extensionUri,
    sessionManager,
    registry,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SessionSitterViewProvider.viewType,
      provider,
    )
  );

  // Auto-add newly created JSONL sessions to the registry
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const creationWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(projectsDir), '**/*.jsonl')
  );
  context.subscriptions.push(creationWatcher);
  context.subscriptions.push(
    creationWatcher.onDidCreate(uri => {
      try {
        const stat = fs.statSync(uri.fsPath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs <= NEW_SESSION_WINDOW_MS) {
          const sessionId = path.basename(uri.fsPath, '.jsonl');
          registry.add(sessionId);
        }
      } catch {
        // File may have been deleted immediately — ignore
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sessionSitter.refresh', () => {
      void vscode.window.showInformationMessage('Claude sessions update automatically.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sessionSitter.newSession', () => {
      void vscode.commands.executeCommand('claude-vscode.newConversation');
    })
  );

  context.subscriptions.push(provider);
}

export function deactivate() {}
```

- [ ] **Step 3: Compile**

```bash
npm run compile
```

Expected: compiler error on `SessionSitterViewProvider` because it doesn't yet accept a third argument. That is expected — it will be fixed in Task 4.

- [ ] **Step 4: Commit (with compile error intentionally noted)**

```bash
git add src/extension.ts
git commit -m "feat: wire LiveSessionRegistry in extension activate"
```

---

## Task 4: Update SessionSitterViewProvider

Replace `_removedSessionIds` with registry-based tab list. Handle new webview messages.

**Files:**
- Modify: `src/SessionSitterViewProvider.ts`

- [ ] **Step 1: Replace SessionSitterViewProvider.ts**

```typescript
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { SessionManager, ClaudeSession } from './SessionManager';
import { LiveSessionRegistry } from './LiveSessionRegistry';

function getNonce(): string {
  return randomBytes(16).toString('hex');
}

export class SessionSitterViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'sessionSitter.view';

  private _view?: vscode.WebviewView;
  private _viewDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _sessionManager: SessionManager,
    private readonly _registry: LiveSessionRegistry,
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._viewDisposables.forEach(d => d.dispose());
    this._viewDisposables = [];

    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Refresh tab metadata when session files change
    this._viewDisposables.push(
      this._sessionManager.onDidChangeSessions(() => {
        this._pushSessions();
      })
    );

    // Rebuild tab list when registry changes
    this._viewDisposables.push(
      this._registry.onDidChange(() => {
        this._pushSessions();
      })
    );

    this._viewDisposables.push(
      webviewView.webview.onDidReceiveMessage(message => {
        switch (message.type) {
          case 'switchSession': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId) { break; }
            void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
            break;
          }
          case 'newSession': {
            void vscode.commands.executeCommand('claude-vscode.newConversation');
            break;
          }
          case 'removeTab': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId) { break; }
            this._registry.remove(sessionId);
            break;
          }
          case 'loadHistory': {
            this._pushHistory();
            break;
          }
          case 'addFromHistory': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId) { break; }
            this._registry.add(sessionId);
            void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
            break;
          }
          case 'ready': {
            this._pushSessions();
            break;
          }
        }
      })
    );

    this._viewDisposables.push(
      webviewView.onDidDispose(() => {
        this._view = undefined;
      })
    );

    this._pushSessions();
  }

  public dispose(): void {
    this._viewDisposables.forEach(d => d.dispose());
    this._viewDisposables = [];
  }

  private _pushSessions(): void {
    if (!this._view) { return; }
    const ids = this._registry.getIds();
    const allSessions = this._sessionManager.getSessions();
    const byId = new Map(allSessions.map(s => [s.sessionId, s]));

    const sessions: ClaudeSession[] = ids.map(id => {
      const found = byId.get(id);
      if (found) { return found; }
      // Session file not yet parseable (still being created) — placeholder
      return {
        sessionId: id,
        projectName: '',
        projectPath: '',
        title: 'Starting…',
        updatedAt: new Date(),
        status: 'waiting' as const,
      };
    });

    void this._view.webview.postMessage({ type: 'updateSessions', sessions });
  }

  private _pushHistory(): void {
    if (!this._view) { return; }
    const registryIds = new Set(this._registry.getIds());
    const history = this._sessionManager.getSessions()
      .filter(s => !registryIds.has(s.sessionId))
      .slice(0, 50);
    void this._view.webview.postMessage({ type: 'updateHistory', sessions: history });
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const mainScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'main.js')
    );
    const stylesUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'styles.css')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${stylesUri}">
  <title>Session Sitter</title>
</head>
<body>
  <div id="tab-bar">
    <button id="new-session-btn" title="New Session">+</button>
    <div id="tab-strip" role="tablist" aria-label="Claude Sessions"></div>
    <button id="history-toggle" aria-expanded="false">History ▶</button>
    <div id="history-panel" hidden></div>
  </div>
  <script nonce="${nonce}" src="${mainScriptUri}"></script>
</body>
</html>`;
  }
}
```

- [ ] **Step 2: Compile**

```bash
npm run compile
```

Expected: exits 0, no errors.

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: `14 passed`.

- [ ] **Step 4: Commit**

```bash
git add src/SessionSitterViewProvider.ts
git commit -m "feat: wire SessionSitterViewProvider to LiveSessionRegistry"
```

---

## Task 5: Update webview main.js

Add history panel toggle, `updateHistory` message handler, and `addFromHistory` messages.

**Files:**
- Modify: `src/webview/main.js`

- [ ] **Step 1: Replace src/webview/main.js**

```javascript
// Webview main script
// Runs inside the VS Code WebView panel — no build step, plain vanilla JS.

(function () {
  'use strict';

  const vscodeApi = acquireVsCodeApi();

  // ── State ────────────────────────────────────────────────────────────────

  /** @type {Array<{sessionId: string, projectName: string, title: string, updatedAt: string, status: string}>} */
  let sessions = [];

  /** @type {Array<{sessionId: string, projectName: string, title: string, updatedAt: string, status: string}>} */
  let historySessions = [];

  let historyOpen = false;

  // ── DOM References ────────────────────────────────────────────────────────

  let tabStrip;
  let historyToggle;
  let historyPanel;

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * @param {string} isoString
   * @returns {string}
   */
  function formatRelativeTime(isoString) {
    const now = Date.now();
    const then = new Date(isoString).getTime();
    if (isNaN(then)) { return ''; }
    const diffSec = Math.floor((now - then) / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHr  = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr  / 24);
    if (diffSec < 60)  { return 'just now'; }
    if (diffMin < 60)  { return diffMin === 1 ? '1 minute ago' : `${diffMin} minutes ago`; }
    if (diffHr  < 24)  { return diffHr  === 1 ? '1 hour ago'   : `${diffHr} hours ago`; }
    if (diffDay < 30)  { return diffDay === 1 ? '1 day ago'    : `${diffDay} days ago`; }
    return new Date(isoString).toLocaleDateString();
  }

  // ── Tab builder ───────────────────────────────────────────────────────────

  /**
   * @param {object} session
   * @returns {HTMLElement}
   */
  function buildTab(session) {
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.dataset.sessionId = session.sessionId;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('tabindex', '0');
    tab.setAttribute('title', (session.title || '(untitled)') + ' — ' + formatRelativeTime(session.updatedAt));

    const statusEl = document.createElement('span');
    statusEl.className = 'status-indicator status-' + (session.status || 'idle');
    statusEl.setAttribute('title',
      session.status === 'active'  ? 'Running' :
      session.status === 'waiting' ? 'Waiting for response' : '');

    const textEl = document.createElement('div');
    textEl.className = 'tab-text';

    const titleEl = document.createElement('span');
    titleEl.className = 'tab-title';
    titleEl.textContent = session.title || '(untitled)';
    textEl.appendChild(titleEl);

    if (session.projectName) {
      const badgeEl = document.createElement('span');
      badgeEl.className = 'tab-badge';
      badgeEl.textContent = session.projectName;
      textEl.appendChild(badgeEl);
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.setAttribute('aria-label', 'Remove from tab bar');
    closeBtn.setAttribute('title', 'Remove from tab bar');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      vscodeApi.postMessage({ type: 'removeTab', sessionId: session.sessionId });
    });

    tab.appendChild(statusEl);
    tab.appendChild(textEl);
    tab.appendChild(closeBtn);

    tab.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'switchSession', sessionId: session.sessionId });
    });
    tab.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        if (event.target === closeBtn) { return; }
        event.preventDefault();
        vscodeApi.postMessage({ type: 'switchSession', sessionId: session.sessionId });
      }
    });

    return tab;
  }

  // ── History item builder ──────────────────────────────────────────────────

  /**
   * @param {object} session
   * @returns {HTMLElement}
   */
  function buildHistoryItem(session) {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.setAttribute('tabindex', '0');
    item.setAttribute('title', (session.title || '(untitled)') + ' — ' + formatRelativeTime(session.updatedAt));

    const textEl = document.createElement('div');
    textEl.className = 'tab-text';

    const titleEl = document.createElement('span');
    titleEl.className = 'tab-title';
    titleEl.textContent = session.title || '(untitled)';
    textEl.appendChild(titleEl);

    if (session.projectName) {
      const badgeEl = document.createElement('span');
      badgeEl.className = 'tab-badge';
      badgeEl.textContent = session.projectName;
      textEl.appendChild(badgeEl);
    }

    const timeEl = document.createElement('span');
    timeEl.className = 'history-time';
    timeEl.textContent = formatRelativeTime(session.updatedAt);
    textEl.appendChild(timeEl);

    item.appendChild(textEl);

    const activate = () => {
      vscodeApi.postMessage({ type: 'addFromHistory', sessionId: session.sessionId });
    };
    item.addEventListener('click', activate);
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });

    return item;
  }

  // ── Render ───────────────────────────────────────────────────────────────

  function renderTabs() {
    if (!tabStrip) { return; }
    tabStrip.innerHTML = '';
    if (sessions.length === 0) {
      const placeholder = document.createElement('span');
      placeholder.className = 'tab-placeholder';
      placeholder.textContent = 'No pinned sessions — click + or open History';
      tabStrip.appendChild(placeholder);
      return;
    }
    sessions.forEach(session => tabStrip.appendChild(buildTab(session)));
  }

  function renderHistory() {
    if (!historyPanel) { return; }
    historyPanel.innerHTML = '';
    if (historySessions.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'tab-placeholder';
      empty.textContent = 'No past sessions found';
      historyPanel.appendChild(empty);
      return;
    }
    historySessions.forEach(session => historyPanel.appendChild(buildHistoryItem(session)));
  }

  function setHistoryOpen(open) {
    historyOpen = open;
    if (!historyToggle || !historyPanel) { return; }
    historyToggle.textContent = open ? 'History ▼' : 'History ▶';
    historyToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    historyPanel.hidden = !open;
    if (open) {
      vscodeApi.postMessage({ type: 'loadHistory' });
    }
  }

  // ── Message handling ─────────────────────────────────────────────────────

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') { return; }

    switch (message.type) {
      case 'updateSessions':
        sessions = Array.isArray(message.sessions) ? message.sessions : [];
        renderTabs();
        break;
      case 'updateHistory':
        historySessions = Array.isArray(message.sessions) ? message.sessions : [];
        renderHistory();
        break;
    }
  });

  // ── Initialization ───────────────────────────────────────────────────────

  function init() {
    tabStrip      = document.getElementById('tab-strip');
    historyToggle = document.getElementById('history-toggle');
    historyPanel  = document.getElementById('history-panel');

    const newBtn = document.getElementById('new-session-btn');
    if (newBtn) {
      newBtn.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'newSession' });
      });
    }

    if (historyToggle) {
      historyToggle.addEventListener('click', () => {
        setHistoryOpen(!historyOpen);
      });
    }

    renderTabs();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); vscodeApi.postMessage({ type: 'ready' }); });
  } else {
    init();
    vscodeApi.postMessage({ type: 'ready' });
  }
}());
```

- [ ] **Step 2: Compile**

```bash
npm run compile
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/webview/main.js
git commit -m "feat: add history panel to webview"
```

---

## Task 6: Update styles.css

Add styles for the history toggle button and history items.

**Files:**
- Modify: `src/webview/styles.css`

- [ ] **Step 1: Append to src/webview/styles.css**

Add the following at the end of the file:

```css
/* ── History Toggle Button ───────────────────────────────────────────────── */

#history-toggle {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  width: 100%;
  height: 28px;
  padding: 0 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--vscode-editor-foreground);
  opacity: 0.6;
  border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-tab-border, #444));
  background-color: var(--vscode-sideBarSectionHeader-background, transparent);
  transition: opacity 0.1s, background-color 0.1s;
  cursor: pointer;
  gap: 6px;
}

#history-toggle:hover {
  opacity: 1;
  background-color: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15));
}

/* ── History Panel ───────────────────────────────────────────────────────── */

#history-panel {
  display: flex;
  flex-direction: column;
  flex: 0 1 auto;
  max-height: 40vh;
  overflow-y: auto;
  overflow-x: hidden;
  border-top: 1px solid var(--vscode-list-inactiveFocusOutline, transparent);
}

/* ── History Item Row ────────────────────────────────────────────────────── */

.history-item {
  display: flex;
  flex-direction: row;
  align-items: center;
  width: 100%;
  min-height: 36px;
  padding: 4px 8px 4px 12px;
  cursor: pointer;
  border-bottom: 1px solid var(--vscode-list-inactiveFocusOutline, transparent);
  background-color: transparent;
  color: var(--vscode-list-inactiveFocusForeground, var(--vscode-editor-foreground));
  opacity: 0.8;
  transition: background-color 0.1s, opacity 0.1s;
  user-select: none;
}

.history-item:hover {
  background-color: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.1));
  color: var(--vscode-list-hoverForeground, var(--vscode-editor-foreground));
  opacity: 1;
}

.history-item:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}

.history-time {
  display: block;
  font-size: 10px;
  opacity: 0.6;
  margin-top: 1px;
}
```

- [ ] **Step 2: Compile**

```bash
npm run compile
```

Expected: exits 0.

- [ ] **Step 3: Run all tests**

```bash
npm test
```

Expected: `14 passed`.

- [ ] **Step 4: Commit**

```bash
git add src/webview/styles.css
git commit -m "feat: style history panel in session switcher webview"
```

---

## Task 7: Build VSIX and manual verification

- [ ] **Step 1: Install vsce if not present**

```bash
npx @vscode/vsce --version 2>/dev/null || npm install -g @vscode/vsce
```

- [ ] **Step 2: Package extension**

```bash
npx @vscode/vsce package --no-dependencies
```

Expected: produces `session-sitter-0.0.1.vsix`.

- [ ] **Step 3: Install in VS Code**

In VS Code: `Ctrl+Shift+P` → `Extensions: Install from VSIX…` → select the `.vsix`.

- [ ] **Step 4: Verify empty state**

Open the Claude Sessions panel in the Secondary Sidebar.  
Expected: tab strip shows "No pinned sessions — click + or open History".

- [ ] **Step 5: Verify new session auto-add**

Click the `+` button in the panel.  
Expected: Claude Code opens a new conversation. Within a few seconds, a new tab appears in the session switcher bar.

- [ ] **Step 6: Verify multiple live sessions**

Click `+` again to open a second session.  
In session 2, start a long Claude task.  
Click the tab for session 1 in the switcher bar.  
Expected: session 1's editor tab comes to the front. Session 2's Claude process continues running in the background (observe its tab — work is progressing).

- [ ] **Step 7: Verify session 2 is still alive**

Click session 2 tab in the switcher.  
Expected: session 2 tab comes to front, task is still in progress or completed — NOT restarted.

- [ ] **Step 8: Verify × does not kill the session**

Click `×` on a tab.  
Expected: tab disappears from the switcher bar. The Claude Code editor tab for that session remains open and active.

- [ ] **Step 9: Verify history panel**

Click "History ▶".  
Expected: expands to show recent sessions from disk that are NOT in the pinned tab bar.  
Click a history item.  
Expected: it appears in the tab bar AND opens/focuses as a Claude Code editor tab.

- [ ] **Step 10: Verify persistence across restart**

Note which sessions are in the tab bar. Reload VS Code window (`Ctrl+Shift+P` → `Developer: Reload Window`).  
Expected: the same sessions reappear in the tab bar.

- [ ] **Step 11: Final commit**

```bash
git add .
git commit -m "chore: bump package for live session switcher release"
```

---

## Self-Review Notes

**Spec coverage check:**
- ✅ `LiveSessionRegistry` with globalState persistence → Task 2
- ✅ Auto-add on `onDidCreate` within 60 s → Task 3 (extension.ts)
- ✅ Placeholder tab for unparseable files → Task 4 (`_pushSessions`)
- ✅ `switchSession` → `primaryEditor.open` → Task 4
- ✅ `removeTab` removes from registry only, does not close panel → Task 4
- ✅ `loadHistory` / `addFromHistory` → Tasks 4 + 5
- ✅ History shows sessions not in registry, capped at 50 → Task 4
- ✅ Collapsible history panel → Task 5 + 6
- ✅ Persistence across VS Code restarts → `globalState` in Task 2/3

**Removed from old code:**
- `_removedSessionIds` → gone (replaced by registry)
- `sessions.filter(s => !this._removedSessionIds.has(s.sessionId))` → gone
