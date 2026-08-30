# Copy Transcript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Right-click any row in the Session Sitter view → **Copy transcript ▸** → **Editor** / **Clipboard** / **File**. Extracts the session's full conversation as handoff-clean markdown from any of the four sources (Claude · Bob · Codex · Chat).

**Architecture:** One new public method on `SessionManager` (`exportFullTranscript(sessionId)`) that dispatches to one of four per-source extractors (`_getClaudeFullTranscript`, `_getBobFullTranscript`, `_getCodexFullTranscript`, `_getChatFullTranscript`), each returning a structured `TranscriptTurn[]`. A shared `renderTranscriptAsMarkdown()` formats the turns into markdown. The webview submenu adds a `Copy transcript ▸` parent item that expands to three leaf items (each one a `postMessage` type the ViewProvider handles by calling `exportFullTranscript` and delivering to its destination). No new VS Code commands, no user config.

**Tech Stack:** TypeScript, Node.js `fs`/`path`, Vitest, VS Code extension API. Chat extractor replays snapshot + deltas (mirrors the manual-exercise script). Bob extractor extends the existing Python subprocess pattern from `_getBobRecentExchanges`.

## Global Constraints

- Handoff-clean stripping: user prose + assistant prose only. Strip Chat's `<userRequest>` wrapper; drop Claude's `tool_use` / `tool_result` / `thinking` blocks; drop Codex's `function_call` / `function_call_output` / `reasoning` / `session_meta` records; Bob is already clean from SQLite.
- Timestamps preserved when the source provides them.
- All extractors are **read-only** on the source `.jsonl` / SQLite / rollout files.
- macOS-only paths (Chat lives under `~/Library/Application Support/Code/User/...`); matches PR #10's platform assumption.
- Every task ends with tests passing (`npm test`), lint clean (`npm run lint` — 0 errors; the one pre-existing warning in `SessionManager.test.ts:451` is expected), and TS compiling (`npm run compile`).
- Every task ends with a git commit on branch `feat_2/copy-transcript-to-editor`.
- Package version bumps from `0.0.8` to `0.0.9` in the final task.
- Same test-seeding pattern as PR #10: construct `SessionManager`, then override `_projectsDir` / `_bobDbPath` / `_codexSessionsDir` / `_vscodeUserDir` via a typed cast. Do **not** add `vi.mock('os')`.

---

### Task 1: `TranscriptTurn` type + `renderTranscriptAsMarkdown` helper + `exportFullTranscript` scaffold

**Files:**
- Modify: `src/SessionManager.ts` — add module-local `TranscriptTurn` interface near `MessageExchange`, add public `exportFullTranscript` method, add private `_renderTranscriptAsMarkdown` helper.
- Modify: `src/test/SessionManager.test.ts` — new `describe('SessionManager._renderTranscriptAsMarkdown', ...)` block at the bottom.

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `interface TranscriptTurn { userText?: string; assistantText?: string; timestamp?: Date; }` (module-local, non-exported)
  - `async exportFullTranscript(sessionId: string): Promise<string | null>` — for now returns `null` for any session; per-source branches land in Tasks 2–5.
  - `private _renderTranscriptAsMarkdown(turns: TranscriptTurn[], meta: TranscriptMeta): string` — pure function used by every source branch.
  - `interface TranscriptMeta { title: string; source: 'Claude' | 'Bob' | 'Codex' | 'Chat'; sessionId: string; }` (module-local)

- [ ] **Step 1: Add the types and stub methods**

In `src/SessionManager.ts`, near the existing `MessageExchange` interface, add:

```ts
// Structured turn for full-transcript export. All fields optional so partial
// turns (e.g. a user message without a completed assistant response yet) are
// representable.
interface TranscriptTurn {
  userText?: string;
  assistantText?: string;
  timestamp?: Date;
}

interface TranscriptMeta {
  title: string;
  source: 'Claude' | 'Bob' | 'Codex' | 'Chat';
  sessionId: string;
}
```

Then, near the existing `exportSessionAsJson` method, add:

```ts
/**
 * Return the full transcript of a session as handoff-clean markdown, or
 * null if the session cannot be found. Dispatches by _sessionSources.
 * User + assistant prose only — tool_use / tool_result / scaffolding stripped.
 */
async exportFullTranscript(sessionId: string): Promise<string | null> {
  const session = this._sessions.find(s => s.sessionId === sessionId);
  if (!session) { return null; }
  // Per-source branches land in Tasks 2–5.
  return null;
}

private _renderTranscriptAsMarkdown(turns: TranscriptTurn[], meta: TranscriptMeta): string {
  const header = [
    `# ${meta.title}`,
    '',
    `*Copied from ${meta.source} · session \`${meta.sessionId}\` · ${turns.length} turn${turns.length === 1 ? '' : 's'}.*`,
    '',
    '---',
    '',
  ];
  const body: string[] = [];
  turns.forEach((turn, i) => {
    const when = turn.timestamp ? turn.timestamp.toISOString().replace('T', ' ').slice(0, 19) : '(no timestamp)';
    body.push(`## Turn ${i + 1}  ·  ${when}`, '');
    if (turn.userText) {
      body.push('**User:**', '', turn.userText, '');
    }
    if (turn.assistantText) {
      body.push(`**Assistant (${meta.source}):**`, '', turn.assistantText, '');
    }
    body.push('---', '');
  });
  return header.concat(body).join('\n');
}
```

- [ ] **Step 2: Write the failing test for `_renderTranscriptAsMarkdown`**

Append to `src/test/SessionManager.test.ts`:

```ts
// ── SessionManager._renderTranscriptAsMarkdown ───────────────────────────────
type PrivateManagerRenderer = {
  _renderTranscriptAsMarkdown(
    turns: Array<{ userText?: string; assistantText?: string; timestamp?: Date }>,
    meta: { title: string; source: 'Claude' | 'Bob' | 'Codex' | 'Chat'; sessionId: string },
  ): string;
};

describe('SessionManager._renderTranscriptAsMarkdown', () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(makeContext());
  });

  it('renders a two-turn transcript with header, turn sections, and separators', () => {
    const md = (sm as unknown as PrivateManagerRenderer)._renderTranscriptAsMarkdown(
      [
        { userText: 'Hello', assistantText: 'Hi there', timestamp: new Date('2026-07-20T10:00:00Z') },
        { userText: 'How are you?', assistantText: 'Good.', timestamp: new Date('2026-07-20T10:01:00Z') },
      ],
      { title: 'A conversation', source: 'Claude', sessionId: 'sess-abc' },
    );
    expect(md).toContain('# A conversation');
    expect(md).toContain('*Copied from Claude · session `sess-abc` · 2 turns.*');
    expect(md).toContain('## Turn 1  ·  2026-07-20 10:00:00');
    expect(md).toContain('**User:**\n\nHello');
    expect(md).toContain('**Assistant (Claude):**\n\nHi there');
    expect(md).toContain('## Turn 2  ·  2026-07-20 10:01:00');
  });

  it('omits the User/Assistant block for turns with no text on that side', () => {
    const md = (sm as unknown as PrivateManagerRenderer)._renderTranscriptAsMarkdown(
      [{ userText: 'Half-turn', timestamp: new Date('2026-07-20T10:00:00Z') }],
      { title: 't', source: 'Chat', sessionId: 's' },
    );
    expect(md).toContain('**User:**\n\nHalf-turn');
    expect(md).not.toContain('**Assistant');
  });

  it('handles empty turns with an empty transcript body', () => {
    const md = (sm as unknown as PrivateManagerRenderer)._renderTranscriptAsMarkdown(
      [],
      { title: 'empty', source: 'Bob', sessionId: 's' },
    );
    expect(md).toContain('· 0 turns.*');
    expect(md).not.toContain('## Turn 1');
  });

  it('uses "(no timestamp)" when timestamp is absent', () => {
    const md = (sm as unknown as PrivateManagerRenderer)._renderTranscriptAsMarkdown(
      [{ userText: 'u', assistantText: 'a' }],
      { title: 't', source: 'Codex', sessionId: 's' },
    );
    expect(md).toContain('## Turn 1  ·  (no timestamp)');
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: **110 tests passing** (106 pre-existing + 4 new).

- [ ] **Step 4: Verify exportFullTranscript stub returns null**

Add one more test in the same describe block (or as a separate block):

```ts
describe('SessionManager.exportFullTranscript', () => {
  it('returns null for a session that is not in _sessions', async () => {
    const sm = new SessionManager(makeContext());
    const result = await sm.exportFullTranscript('nonexistent');
    expect(result).toBeNull();
  });
});
```

Run: `npm test`
Expected: **111 tests passing**.

- [ ] **Step 5: Full check + commit**

```bash
npm run compile && npm test && npm run lint
git add src/SessionManager.ts src/test/SessionManager.test.ts
git commit -m "feat: TranscriptTurn type + markdown renderer + exportFullTranscript stub"
```

---

### Task 2: Codex full-transcript extractor

**Files:**
- Modify: `src/SessionManager.ts` — add `_getCodexFullTranscript`; extend `exportFullTranscript` dispatcher with a `'codex'` branch.
- Modify: `src/test/SessionManager.test.ts` — new describe block.

**Interfaces:**
- Consumes: `TranscriptTurn`, `_renderTranscriptAsMarkdown` from Task 1.
- Produces: `_getCodexFullTranscript(filePath: string): Promise<TranscriptTurn[]>` — walks all lines (not tail-only like the preview extractor), keeps only role-bearing `response_item` records, drops everything else.

- [ ] **Step 1: Write the failing test**

Append to `src/test/SessionManager.test.ts`:

```ts
// ── SessionManager.exportFullTranscript (Codex) ──────────────────────────────
describe('SessionManager.exportFullTranscript (Codex)', () => {
  let tmpDir: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-full-'));
    sm = new SessionManager(makeContext());
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('extracts all user/assistant response_items and drops function_call + session_meta', async () => {
    const rollout = path.join(tmpDir, 'rollout.jsonl');
    const lines = [
      { timestamp: '2026-07-20T10:00:00Z', type: 'session_meta', payload: { id: 'cx-full', cwd: '/x' } },
      { timestamp: '2026-07-20T10:00:01Z', type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'First question' }] } },
      { timestamp: '2026-07-20T10:00:02Z', type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'First answer' }] } },
      { timestamp: '2026-07-20T10:00:03Z', type: 'function_call', payload: { name: 'read_file', arguments: '{"p":"x"}' } },
      { timestamp: '2026-07-20T10:00:04Z', type: 'function_call_output', payload: { output: 'file contents' } },
      { timestamp: '2026-07-20T10:00:05Z', type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'Second question' }] } },
      { timestamp: '2026-07-20T10:00:06Z', type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'Second answer' }] } },
    ];
    await fs.promises.writeFile(rollout, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    (sm as unknown as { _sessions: import('../SessionManager').ClaudeSession[] })._sessions = [{
      sessionId: 'cx-full', projectPath: '/x', projectName: 'x',
      title: 'Codex conversation', updatedAt: new Date('2026-07-20T10:00:06Z'), status: 'idle', source: 'codex',
    }];
    (sm as unknown as { _sessionFilePaths: Map<string, string> })._sessionFilePaths.set('cx-full', rollout);
    (sm as unknown as { _sessionSources: Map<string, 'claude' | 'bob' | 'codex' | 'chat'> })
      ._sessionSources.set('cx-full', 'codex');

    const md = await sm.exportFullTranscript('cx-full');
    expect(md).not.toBeNull();
    expect(md).toContain('# Codex conversation');
    expect(md).toContain('*Copied from Codex · session `cx-full` · 2 turns.*');
    expect(md).toContain('First question');
    expect(md).toContain('First answer');
    expect(md).toContain('Second question');
    expect(md).toContain('Second answer');
    // function_call / session_meta records must be dropped.
    expect(md).not.toContain('read_file');
    expect(md).not.toContain('file contents');
  });

  it('drops response_item records with non-text roles or empty content', async () => {
    const rollout = path.join(tmpDir, 'rollout2.jsonl');
    await fs.promises.writeFile(rollout, [
      { type: 'session_meta', payload: { id: 'cx-2', cwd: '/x' } },
      { type: 'response_item', payload: { role: 'system', content: [{ type: 'input_text', text: 'system prompt' }] } },
      { type: 'response_item', payload: { role: 'user', content: [] } },
      { type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'orphan reply' }] } },
    ].map(l => JSON.stringify(l)).join('\n') + '\n');

    (sm as unknown as { _sessions: import('../SessionManager').ClaudeSession[] })._sessions = [{
      sessionId: 'cx-2', projectPath: '/x', projectName: 'x',
      title: 't', updatedAt: new Date(), status: 'idle', source: 'codex',
    }];
    (sm as unknown as { _sessionFilePaths: Map<string, string> })._sessionFilePaths.set('cx-2', rollout);
    (sm as unknown as { _sessionSources: Map<string, 'claude' | 'bob' | 'codex' | 'chat'> })
      ._sessionSources.set('cx-2', 'codex');

    const md = await sm.exportFullTranscript('cx-2');
    expect(md).not.toBeNull();
    // System role dropped; empty user content dropped; assistant orphan kept as its own turn.
    expect(md).not.toContain('system prompt');
    expect(md).toContain('orphan reply');
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- src/test/SessionManager.test.ts -t "exportFullTranscript \\(Codex\\)"`
Expected: FAIL — `exportFullTranscript` still returns `null`.

- [ ] **Step 3: Implement the extractor**

In `src/SessionManager.ts`, near the existing `_getCodexRecentExchanges`, add:

```ts
// Walk every line of a Codex rollout and pair user/assistant response_item
// records into TranscriptTurns. Different from _getCodexRecentExchanges
// which tail-slices; this returns the full history.
private async _getCodexFullTranscript(filePath: string): Promise<TranscriptTurn[]> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch { return []; }

  const turns: TranscriptTurn[] = [];
  let pending: TranscriptTurn | null = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }
    try {
      const rec = JSON.parse(trimmed) as {
        timestamp?: string;
        type?: string;
        payload?: { role?: string; content?: Array<{ type?: string; text?: string }> };
      };
      if (rec.type !== 'response_item') { continue; }
      const role = rec.payload?.role;
      if (role !== 'user' && role !== 'assistant') { continue; }
      const text = (rec.payload?.content ?? [])
        .filter(b => typeof b.text === 'string' && b.text.trim().length > 0)
        .map(b => b.text!.trim())
        .join('\n')
        .trim();
      if (!text) { continue; }
      const ts = rec.timestamp ? new Date(rec.timestamp) : undefined;
      if (role === 'user') {
        if (pending) { turns.push(pending); }
        pending = { userText: text, timestamp: ts };
      } else {
        if (!pending) { pending = { timestamp: ts }; }
        pending.assistantText = pending.assistantText
          ? `${pending.assistantText}\n\n${text}`
          : text;
        if (!pending.timestamp) { pending.timestamp = ts; }
      }
    } catch { /* skip malformed line */ }
  }
  if (pending) { turns.push(pending); }
  return turns;
}
```

- [ ] **Step 4: Wire the dispatcher branch**

In `src/SessionManager.ts`, extend `exportFullTranscript`:

```ts
async exportFullTranscript(sessionId: string): Promise<string | null> {
  const session = this._sessions.find(s => s.sessionId === sessionId);
  if (!session) { return null; }

  if (session.source === 'codex') {
    const filePath = this._sessionFilePaths.get(sessionId);
    if (!filePath) { return null; }
    const turns = await this._getCodexFullTranscript(filePath);
    return this._renderTranscriptAsMarkdown(turns, {
      title: session.title || 'Codex session',
      source: 'Codex',
      sessionId,
    });
  }

  return null;
}
```

- [ ] **Step 5: Run tests + full check**

```bash
npm run compile && npm test && npm run lint
```
Expected: all pass; **113 tests** (111 + 2 new).

- [ ] **Step 6: Commit**

```bash
git add src/SessionManager.ts src/test/SessionManager.test.ts
git commit -m "feat: full-transcript extractor for Codex sessions"
```

---

### Task 3: Claude full-transcript extractor

**Files:**
- Modify: `src/SessionManager.ts` — add `_getClaudeFullTranscript`; extend dispatcher with a `'claude'` branch.
- Modify: `src/test/SessionManager.test.ts` — new describe block.

**Interfaces:**
- Consumes: `TranscriptTurn`, `_renderTranscriptAsMarkdown` from Task 1.
- Produces: `_getClaudeFullTranscript(filePath: string): Promise<TranscriptTurn[]>` — reads line-per-event JSONL, extracts `user` events' text content and `assistant` events' text-typed content parts; drops `tool_use`, `tool_result`, `thinking`.

- [ ] **Step 1: Understand Claude's JSONL shape**

Claude Code writes JSONL where each line is an event. The relevant events for handoff-clean extraction:
- `{ "type": "user", "message": { "role": "user", "content": "<string>" | [{"type":"text","text":"..."}] } }` — user turn.
- `{ "type": "assistant", "message": { "role": "assistant", "content": [{"type":"text","text":"..."}, {"type":"tool_use", ...}, {"type":"thinking", ...}] } }` — assistant turn (may have multiple content parts).
- Other event types (`tool_result`, `summary`, `system`, meta) — dropped.

Content may be a bare string OR an array of parts. Both shapes must be handled.

- [ ] **Step 2: Write the failing test**

Append to `src/test/SessionManager.test.ts`:

```ts
// ── SessionManager.exportFullTranscript (Claude) ─────────────────────────────
describe('SessionManager.exportFullTranscript (Claude)', () => {
  let tmpDir: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-full-'));
    sm = new SessionManager(makeContext());
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('extracts user + assistant text; drops tool_use, tool_result, thinking', async () => {
    const sessionFile = path.join(tmpDir, 'session.jsonl');
    const events = [
      { type: 'user', timestamp: '2026-07-20T10:00:00Z', message: { role: 'user', content: 'First user message' } },
      { type: 'assistant', timestamp: '2026-07-20T10:00:01Z', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'Let me think' },
        { type: 'text', text: 'First assistant reply' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } },
      ]}},
      { type: 'user', timestamp: '2026-07-20T10:00:02Z', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'file contents' },
      ]}},
      { type: 'assistant', timestamp: '2026-07-20T10:00:03Z', message: { role: 'assistant', content: [
        { type: 'text', text: 'Second assistant reply' },
      ]}},
      { type: 'summary', summary: 'Session summary' },
    ];
    await fs.promises.writeFile(sessionFile, events.map(e => JSON.stringify(e)).join('\n') + '\n');

    (sm as unknown as { _sessions: import('../SessionManager').ClaudeSession[] })._sessions = [{
      sessionId: 'cl-full', projectPath: '/x', projectName: 'x',
      title: 'A Claude chat', updatedAt: new Date('2026-07-20T10:00:03Z'), status: 'idle', source: 'claude',
    }];
    (sm as unknown as { _sessionFilePaths: Map<string, string> })._sessionFilePaths.set('cl-full', sessionFile);
    (sm as unknown as { _sessionSources: Map<string, 'claude' | 'bob' | 'codex' | 'chat'> })
      ._sessionSources.set('cl-full', 'claude');

    const md = await sm.exportFullTranscript('cl-full');
    expect(md).not.toBeNull();
    expect(md).toContain('# A Claude chat');
    // Two turns: user 1 + asst 1, then user-with-only-tool-result (dropped) → asst 2 as its own turn.
    expect(md).toContain('First user message');
    expect(md).toContain('First assistant reply');
    expect(md).toContain('Second assistant reply');
    // Stripped:
    expect(md).not.toContain('Let me think');
    expect(md).not.toContain('file contents');
    expect(md).not.toContain('Session summary');
  });

  it('handles string-form user content and array-form user content identically', async () => {
    const sessionFile = path.join(tmpDir, 'session2.jsonl');
    const events = [
      { type: 'user', message: { role: 'user', content: 'plain string form' } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'array form' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ack' }] } },
    ];
    await fs.promises.writeFile(sessionFile, events.map(e => JSON.stringify(e)).join('\n') + '\n');

    (sm as unknown as { _sessions: import('../SessionManager').ClaudeSession[] })._sessions = [{
      sessionId: 'cl-2', projectPath: '/x', projectName: 'x',
      title: 't', updatedAt: new Date(), status: 'idle', source: 'claude',
    }];
    (sm as unknown as { _sessionFilePaths: Map<string, string> })._sessionFilePaths.set('cl-2', sessionFile);
    (sm as unknown as { _sessionSources: Map<string, 'claude' | 'bob' | 'codex' | 'chat'> })
      ._sessionSources.set('cl-2', 'claude');

    const md = await sm.exportFullTranscript('cl-2');
    expect(md).toContain('plain string form');
    expect(md).toContain('array form');
    expect(md).toContain('ack');
  });
});
```

- [ ] **Step 3: Run test to verify failure**

Run: `npm test -- src/test/SessionManager.test.ts -t "exportFullTranscript \\(Claude\\)"`
Expected: FAIL — Claude branch not yet in dispatcher.

- [ ] **Step 4: Implement the extractor**

In `src/SessionManager.ts`, near the existing Claude scan code, add:

```ts
private async _getClaudeFullTranscript(filePath: string): Promise<TranscriptTurn[]> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch { return []; }

  const turns: TranscriptTurn[] = [];
  let pending: TranscriptTurn | null = null;

  const extractText = (content: unknown): string => {
    if (typeof content === 'string') { return content.trim(); }
    if (!Array.isArray(content)) { return ''; }
    const parts = content
      .filter((p): p is { type: string; text?: string } =>
        typeof p === 'object' && p !== null && (p as { type?: unknown }).type === 'text',
      )
      .map(p => (typeof p.text === 'string' ? p.text : ''))
      .filter(t => t.trim().length > 0)
      .map(t => t.trim());
    return parts.join('\n\n');
  };

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }
    try {
      const rec = JSON.parse(trimmed) as {
        type?: string;
        timestamp?: string;
        message?: { role?: string; content?: unknown };
      };
      if (rec.type !== 'user' && rec.type !== 'assistant') { continue; }
      const text = extractText(rec.message?.content);
      if (!text) { continue; }
      const ts = rec.timestamp ? new Date(rec.timestamp) : undefined;
      if (rec.type === 'user') {
        if (pending) { turns.push(pending); }
        pending = { userText: text, timestamp: ts };
      } else {
        if (!pending) { pending = { timestamp: ts }; }
        pending.assistantText = pending.assistantText
          ? `${pending.assistantText}\n\n${text}`
          : text;
        if (!pending.timestamp) { pending.timestamp = ts; }
      }
    } catch { /* skip malformed line */ }
  }
  if (pending) { turns.push(pending); }
  return turns;
}
```

- [ ] **Step 5: Wire the dispatcher branch**

Extend `exportFullTranscript`:

```ts
if (session.source === 'claude') {
  const filePath = this._sessionFilePaths.get(sessionId);
  if (!filePath) { return null; }
  const turns = await this._getClaudeFullTranscript(filePath);
  return this._renderTranscriptAsMarkdown(turns, {
    title: session.title || 'Claude session',
    source: 'Claude',
    sessionId,
  });
}
```

- [ ] **Step 6: Run tests + full check**

```bash
npm run compile && npm test && npm run lint
```
Expected: **115 tests**.

- [ ] **Step 7: Commit**

```bash
git add src/SessionManager.ts src/test/SessionManager.test.ts
git commit -m "feat: full-transcript extractor for Claude sessions"
```

---

### Task 4: Bob full-transcript extractor

**Files:**
- Modify: `src/SessionManager.ts` — add `_getBobFullTranscript`; extend dispatcher with a `'bob'` branch.
- Modify: `src/test/SessionManager.test.ts` — new describe block.

**Interfaces:**
- Consumes: `TranscriptTurn`, `_renderTranscriptAsMarkdown` from Task 1; the Python subprocess pattern from the existing `_getBobRecentExchanges`.
- Produces: `_getBobFullTranscript(taskId: string): Promise<TranscriptTurn[]>` — reads **all** messages for the task (no LIMIT), returns turns in chronological order.

- [ ] **Step 1: Locate the existing Bob preview extractor to copy the pattern**

The existing `_getBobRecentExchanges(taskId)` runs a Python subprocess with `sqlite3` to read the last N messages. Full-transcript uses the same subprocess pattern with the LIMIT dropped and no `ORDER BY … DESC` reversal at the end. Read `src/SessionManager.ts` for the existing method's exact shape before writing the new one — this is the source of truth for shell quoting, error handling, and result parsing.

- [ ] **Step 2: Write the failing test**

Append to `src/test/SessionManager.test.ts`, reusing `createBobDb` and `insertBobMessage` helpers:

```ts
// ── SessionManager.exportFullTranscript (Bob) ────────────────────────────────
describe('SessionManager.exportFullTranscript (Bob)', () => {
  let tmpDir: string;
  let dbPath: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bob-full-'));
    dbPath = path.join(tmpDir, 'bob.db');
    createBobDb(dbPath);
    sm = new SessionManager(makeContext());
    (sm as unknown as PrivateManagerBob)._bobDbPath = dbPath;
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('extracts every message for a task in chronological order (not tail-sliced)', async () => {
    const id = 'bob-full-1';
    // Seven messages — well past the 6-cap of the preview extractor.
    for (let i = 1; i <= 7; i++) {
      insertBobMessage(dbPath, {
        id: `m${i}`, taskId: id,
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: `Msg ${i}`,
        ts: 1_000 * i,
      });
    }

    (sm as unknown as { _sessions: import('../SessionManager').ClaudeSession[] })._sessions = [{
      sessionId: id, projectPath: '/proj', projectName: 'proj',
      title: 'Bob conversation', updatedAt: new Date(7_000), status: 'idle', source: 'bob',
    }];
    (sm as unknown as { _sessionFilePaths: Map<string, string> })._sessionFilePaths.set(id, id);
    (sm as unknown as { _sessionSources: Map<string, 'claude' | 'bob' | 'codex' | 'chat'> })
      ._sessionSources.set(id, 'bob');

    const md = await sm.exportFullTranscript(id);
    expect(md).not.toBeNull();
    expect(md).toContain('# Bob conversation');
    // Every message must appear — not truncated to the last 6.
    for (let i = 1; i <= 7; i++) {
      expect(md).toContain(`Msg ${i}`);
    }
    // Chronological: Msg 1 appears before Msg 7 in the markdown.
    expect(md!.indexOf('Msg 1')).toBeLessThan(md!.indexOf('Msg 7'));
  });
});
```

- [ ] **Step 3: Run test to verify failure**

Run: `npm test -- src/test/SessionManager.test.ts -t "exportFullTranscript \\(Bob\\)"`
Expected: FAIL — Bob branch not in dispatcher; also the existing preview extractor caps at 6, would fail even if wired.

- [ ] **Step 4: Implement the extractor**

Copy the Python subprocess pattern from `_getBobRecentExchanges`, dropping the LIMIT. In `src/SessionManager.ts`, near the existing Bob code:

```ts
// Return every message for a Bob task, chronologically. Extends the
// _getBobRecentExchanges pattern (Python subprocess + sqlite3) but removes
// the LIMIT and reversal so the result is the full history in order.
private async _getBobFullTranscript(taskId: string): Promise<TranscriptTurn[]> {
  const script = `
import sqlite3, json, sys
db, tid = sys.argv[1], sys.argv[2]
conn = sqlite3.connect(db)
try:
    rows = conn.execute(
        "SELECT role, content, ts FROM messages WHERE task_id = ? ORDER BY ts ASC",
        (tid,),
    ).fetchall()
    print(json.dumps([{"role": r[0], "content": r[1], "ts": r[2]} for r in rows]))
finally:
    conn.close()
`;
  let out: string;
  try {
    out = await _execPython3(['-c', script, this._bobDbPath, taskId]);
  } catch {
    return [];
  }
  let rows: Array<{ role: string; content: string; ts: number }>;
  try {
    rows = JSON.parse(out);
  } catch { return []; }

  const turns: TranscriptTurn[] = [];
  let pending: TranscriptTurn | null = null;
  for (const row of rows) {
    const text = (row.content ?? '').trim();
    if (!text) { continue; }
    const ts = typeof row.ts === 'number' ? new Date(row.ts) : undefined;
    if (row.role === 'user') {
      if (pending) { turns.push(pending); }
      pending = { userText: text, timestamp: ts };
    } else if (row.role === 'assistant') {
      if (!pending) { pending = { timestamp: ts }; }
      pending.assistantText = pending.assistantText
        ? `${pending.assistantText}\n\n${text}`
        : text;
      if (!pending.timestamp) { pending.timestamp = ts; }
    }
  }
  if (pending) { turns.push(pending); }
  return turns;
}
```

- [ ] **Step 5: Wire the dispatcher branch**

Extend `exportFullTranscript`:

```ts
if (session.source === 'bob') {
  const turns = await this._getBobFullTranscript(sessionId);
  return this._renderTranscriptAsMarkdown(turns, {
    title: session.title || 'Bob session',
    source: 'Bob',
    sessionId,
  });
}
```

- [ ] **Step 6: Run tests + full check**

```bash
npm run compile && npm test && npm run lint
```
Expected: **116 tests**.

- [ ] **Step 7: Commit**

```bash
git add src/SessionManager.ts src/test/SessionManager.test.ts
git commit -m "feat: full-transcript extractor for Bob sessions"
```

---

### Task 5: Chat full-transcript extractor (delta replay)

**Files:**
- Modify: `src/SessionManager.ts` — add `_getChatFullTranscript` + helper `_replayChatDeltas`; extend dispatcher with a `'chat'` branch.
- Modify: `src/test/SessionManager.test.ts` — new describe block.

**Interfaces:**
- Consumes: `TranscriptTurn`, `_renderTranscriptAsMarkdown` from Task 1.
- Produces:
  - `_getChatFullTranscript(filePath: string): Promise<TranscriptTurn[]>` — replays snapshot + deltas, unwraps `<userRequest>` where present.
  - `_replayChatDeltas(lines: string[]): unknown` — pure helper that returns the reconstructed `v` state (isolated for unit testing).

- [ ] **Step 1: Reference the manual-exercise Python script**

The delta-replay logic was validated in the manual exercise before this spec (extracted the "Cap-evolve phase 1 intake" session). The TS port mirrors the Python `apply_delta` function:
- Snapshot line (`kind: 0`) initializes state = record.v.
- `kind: 1` delta with path `k` and value `v` sets the field at that path.
- `kind: 2` delta with array path appends the value to that array.

After replay, `state.requests[]` is iterated. Each request's user text is `result.metadata.renderedUserMessage[].text` filtered to type 1 and joined; strip `<userRequest>...</userRequest>` wrapper if present. Each request's assistant text is concatenated string `value` fields from `response[]`.

- [ ] **Step 2: Write the failing test**

Append to `src/test/SessionManager.test.ts`:

```ts
// ── SessionManager.exportFullTranscript (Chat) ───────────────────────────────
describe('SessionManager.exportFullTranscript (Chat)', () => {
  let tmpDir: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-full-'));
    sm = new SessionManager(makeContext());
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('replays deltas, unwraps <userRequest>, concatenates response values', async () => {
    const chatFile = path.join(tmpDir, 'chat.jsonl');
    const wrapped = '<context>\nSystem stuff\n</context>\n<userRequest>\nActual user prose\n</userRequest>';
    const lines = [
      // Snapshot with empty requests
      { kind: 0, v: { sessionId: 'ch-full', customTitle: 'A Chat conversation', requests: [] } },
      // Push one request onto requests[]
      { kind: 2, k: ['requests'], v: [{ requestId: 'r1', timestamp: 1_753_000_000_000, response: [] }] },
      // Fill in response array via kind:1 update
      { kind: 1, k: ['requests', 0, 'response'], v: [{ value: 'Hello ' }, { value: 'from Copilot.' }] },
      // Fill in the rendered user message
      { kind: 1, k: ['requests', 0, 'result'], v: { metadata: { renderedUserMessage: [{ type: 1, text: wrapped }] } } },
    ];
    await fs.promises.writeFile(chatFile, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    (sm as unknown as { _sessions: import('../SessionManager').ClaudeSession[] })._sessions = [{
      sessionId: 'ch-full', projectPath: '/x', projectName: 'x',
      title: 'A Chat conversation', updatedAt: new Date(1_753_000_000_000), status: 'idle', source: 'chat',
    }];
    (sm as unknown as { _sessionFilePaths: Map<string, string> })._sessionFilePaths.set('ch-full', chatFile);
    (sm as unknown as { _sessionSources: Map<string, 'claude' | 'bob' | 'codex' | 'chat'> })
      ._sessionSources.set('ch-full', 'chat');

    const md = await sm.exportFullTranscript('ch-full');
    expect(md).not.toBeNull();
    expect(md).toContain('# A Chat conversation');
    // The <userRequest> unwrap keeps only the inner content, not the outer <context> block.
    expect(md).toContain('Actual user prose');
    expect(md).not.toContain('<context>');
    expect(md).not.toContain('System stuff');
    // Assistant response is the concatenation of the two value strings.
    expect(md).toContain('Hello from Copilot.');
  });

  it('returns [] when the file cannot be read', async () => {
    (sm as unknown as { _sessions: import('../SessionManager').ClaudeSession[] })._sessions = [{
      sessionId: 'ch-missing', projectPath: '/x', projectName: 'x',
      title: 't', updatedAt: new Date(), status: 'idle', source: 'chat',
    }];
    (sm as unknown as { _sessionFilePaths: Map<string, string> })._sessionFilePaths.set('ch-missing', '/nonexistent/foo.jsonl');
    (sm as unknown as { _sessionSources: Map<string, 'claude' | 'bob' | 'codex' | 'chat'> })
      ._sessionSources.set('ch-missing', 'chat');
    const md = await sm.exportFullTranscript('ch-missing');
    // Zero-turn transcript, not null: session was found, just empty.
    expect(md).not.toBeNull();
    expect(md).toContain('· 0 turns.*');
  });
});
```

- [ ] **Step 3: Run test to verify failure**

Run: `npm test -- src/test/SessionManager.test.ts -t "exportFullTranscript \\(Chat\\)"`
Expected: FAIL — Chat branch not in dispatcher.

- [ ] **Step 4: Implement the extractor**

In `src/SessionManager.ts`, near the existing Chat code:

```ts
// Reconstruct the `v` state of a VS Code Chat session by replaying its
// snapshot (kind:0) + deltas (kind:1 assign, kind:2 array push).
private _replayChatDeltas(lines: string[]): {
  requests?: Array<{
    timestamp?: number;
    message?: { text?: string };
    response?: Array<{ value?: unknown }>;
    result?: { metadata?: { renderedUserMessage?: Array<{ type?: number; text?: string }> } };
  }>;
} {
  const applyDelta = (
    state: Record<string, unknown> | unknown[],
    keyPath: Array<string | number>,
    value: unknown,
    isPush: boolean,
  ): void => {
    if (!keyPath.length) { return; }
    let parent: Record<string, unknown> | unknown[] = state;
    for (let i = 0; i < keyPath.length - 1; i++) {
      const k = keyPath[i];
      if (Array.isArray(parent) && typeof k === 'number') {
        while (parent.length <= k) { parent.push({}); }
        parent = parent[k] as Record<string, unknown> | unknown[];
      } else if (!Array.isArray(parent) && typeof k === 'string') {
        if (!(k in parent)) {
          parent[k] = typeof keyPath[i + 1] === 'number' ? [] : {};
        }
        parent = parent[k] as Record<string, unknown> | unknown[];
      }
    }
    const last = keyPath[keyPath.length - 1];
    if (isPush) {
      const arr = Array.isArray(parent)
        ? (typeof last === 'number' ? parent[last] : undefined)
        : (parent[last as string] ??= []);
      if (Array.isArray(arr) && Array.isArray(value)) { arr.push(...value); }
      else if (Array.isArray(arr)) { arr.push(value); }
    } else if (Array.isArray(parent) && typeof last === 'number') {
      while (parent.length <= last) { parent.push(undefined); }
      parent[last] = value;
    } else if (!Array.isArray(parent) && typeof last === 'string') {
      parent[last] = value;
    }
  };

  let state: Record<string, unknown> | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }
    try {
      const rec = JSON.parse(trimmed) as { kind?: number; k?: Array<string | number>; v?: unknown };
      if (rec.kind === 0) {
        state = (rec.v as Record<string, unknown>) ?? {};
      } else if (state && (rec.kind === 1 || rec.kind === 2)) {
        applyDelta(state, rec.k ?? [], rec.v, rec.kind === 2);
      }
    } catch { /* skip malformed */ }
  }
  return (state ?? {}) as ReturnType<typeof this._replayChatDeltas>;
}

private async _getChatFullTranscript(filePath: string): Promise<TranscriptTurn[]> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch { return []; }

  const state = this._replayChatDeltas(raw.split('\n'));
  const requests = state.requests ?? [];

  const USER_REQUEST_RE = /<userRequest>\s*([\s\S]*?)\s*<\/userRequest>/;

  const turns: TranscriptTurn[] = [];
  for (const req of requests) {
    if (!req) { continue; }
    const rendered = req.result?.metadata?.renderedUserMessage ?? [];
    const combined = rendered
      .filter(p => p && p.type === 1 && typeof p.text === 'string')
      .map(p => p.text!)
      .join('\n');
    const unwrapMatch = combined.match(USER_REQUEST_RE);
    const userText = (unwrapMatch ? unwrapMatch[1] : (req.message?.text ?? combined)).trim();

    const assistantText = (req.response ?? [])
      .filter(el => el && typeof el.value === 'string')
      .map(el => el.value as string)
      .join('')
      .trim();

    const timestamp = typeof req.timestamp === 'number' ? new Date(req.timestamp) : undefined;

    if (userText || assistantText) {
      turns.push({
        userText: userText || undefined,
        assistantText: assistantText || undefined,
        timestamp,
      });
    }
  }
  return turns;
}
```

- [ ] **Step 5: Wire the dispatcher branch**

Extend `exportFullTranscript`:

```ts
if (session.source === 'chat') {
  const filePath = this._sessionFilePaths.get(sessionId);
  if (!filePath) { return null; }
  const turns = await this._getChatFullTranscript(filePath);
  return this._renderTranscriptAsMarkdown(turns, {
    title: session.title || 'Chat session',
    source: 'Chat',
    sessionId,
  });
}
```

- [ ] **Step 6: Run tests + full check (stability sweep)**

```bash
npm run compile && npm test && npm run lint
```
Run `npm test` five times to catch any race regressions. Expected: **118 tests**, all runs green.

- [ ] **Step 7: Commit**

```bash
git add src/SessionManager.ts src/test/SessionManager.test.ts
git commit -m "feat: full-transcript extractor for VS Code Chat sessions"
```

---

### Task 6: ViewProvider — three postMessage handlers + delivery mechanisms

**Files:**
- Modify: `src/SessionSitterViewProvider.ts` — three new cases in the `webview.onDidReceiveMessage` switch.
- Modify: `src/test/SessionSitterViewProvider.test.ts` — new describe block for the three handlers.

**Interfaces:**
- Consumes: `exportFullTranscript(sessionId)` from Tasks 1–5.
- Produces: three new webview-postMessage types the DOM menu (Task 7) will emit:
  - `copyTranscriptToEditor` → opens an untitled markdown editor with the transcript.
  - `copyTranscriptToClipboard` → writes to `vscode.env.clipboard` and shows a status-bar message.
  - `copyTranscriptToFile` → writes to `os.tmpdir()/transcript-<sessionId>.md` and shows an info message with a **Reveal in Finder** button.

- [ ] **Step 1: Locate the existing postMessage switch**

Read the existing `webview.onDidReceiveMessage` handler in `src/SessionSitterViewProvider.ts`. Find the `case 'uploadToCorpus':` block (added in a prior PR) — the new three cases go alongside it. Note: existing handlers use `void (async () => { ... })()` inside `case` blocks to run awaited code. Follow the same pattern.

- [ ] **Step 2: Write the failing tests**

Append to `src/test/SessionSitterViewProvider.test.ts`. Look for the existing `describe('SessionSitterViewProvider — upload to the corpus', ...)` block for the shape of mocks (mock `vscode.env.clipboard`, mock `vscode.window.showTextDocument`, mock `vscode.window.showInformationMessage`, spy on `sessionManager.exportFullTranscript`).

```ts
describe('SessionSitterViewProvider — copy transcript handlers', () => {
  let vp: SessionSitterViewProvider;
  let ctx: FakeContext;
  let mgr: FakeSessionManager;

  beforeEach(() => {
    ctx = makeContext();
    mgr = new FakeSessionManager();
    vp = new SessionSitterViewProvider(ctx as unknown as vscode.ExtensionContext, mgr as unknown as SessionManager);
  });

  it('copyTranscriptToEditor opens an untitled markdown document with the transcript', async () => {
    const openDoc = vi.mocked(vscode.workspace.openTextDocument);
    const showDoc = vi.mocked(vscode.window.showTextDocument);
    mgr.exportFullTranscriptImpl = () => Promise.resolve('# transcript\n\nbody');

    await postMessage(vp, ctx, { type: 'copyTranscriptToEditor', sessionId: 'sess-1' });

    expect(openDoc).toHaveBeenCalledWith({ language: 'markdown', content: '# transcript\n\nbody' });
    expect(showDoc).toHaveBeenCalled();
  });

  it('copyTranscriptToClipboard writes to env.clipboard and shows a status message', async () => {
    const writeText = vi.mocked(vscode.env.clipboard.writeText);
    const setStatus = vi.mocked(vscode.window.setStatusBarMessage);
    mgr.exportFullTranscriptImpl = () => Promise.resolve('some transcript');

    await postMessage(vp, ctx, { type: 'copyTranscriptToClipboard', sessionId: 'sess-1' });

    expect(writeText).toHaveBeenCalledWith('some transcript');
    expect(setStatus).toHaveBeenCalled();
  });

  it('copyTranscriptToFile writes to os.tmpdir() and shows an info message with a Reveal action', async () => {
    const showInfo = vi.mocked(vscode.window.showInformationMessage);
    showInfo.mockResolvedValue(undefined);
    mgr.exportFullTranscriptImpl = () => Promise.resolve('# on disk');

    await postMessage(vp, ctx, { type: 'copyTranscriptToFile', sessionId: 'sess-1' });

    // Reveal button offered
    const call = showInfo.mock.calls[0];
    expect(call[0]).toMatch(/Transcript saved/);
    expect(call).toContain('Reveal in Finder');

    // File actually exists at the printed path
    const tmpPath = (call[0] as string).match(/\/[^\s]+\.md/)?.[0];
    expect(tmpPath).toBeTruthy();
    const content = await fs.promises.readFile(tmpPath!, 'utf8');
    expect(content).toBe('# on disk');
    await fs.promises.unlink(tmpPath!);
  });

  it('shows a warning toast when the session is gone (exportFullTranscript returns null)', async () => {
    const showWarn = vi.mocked(vscode.window.showWarningMessage);
    mgr.exportFullTranscriptImpl = () => Promise.resolve(null);
    await postMessage(vp, ctx, { type: 'copyTranscriptToEditor', sessionId: 'gone' });
    expect(showWarn).toHaveBeenCalledWith(expect.stringContaining('no longer exists'));
  });
});
```

The `postMessage(vp, ctx, msg)` helper simulates a webview message by calling the registered `onDidReceiveMessage` callback. If it doesn't exist in the test file, add it near `makeContext`:

```ts
async function postMessage(vp: SessionSitterViewProvider, ctx: FakeContext, msg: unknown): Promise<void> {
  const webview = ctx.__lastResolvedWebview;
  if (!webview) { throw new Error('resolveWebviewView must be called first'); }
  await webview.onDidReceiveMessage.mock.calls[0][0](msg);
}
```

Extend the `vi.mock('vscode', ...)` factory at the top of the test file to include:

```ts
env: {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
},
workspace: {
  ...existing...,
  openTextDocument: vi.fn().mockResolvedValue({ uri: 'doc://untitled' }),
},
window: {
  ...existing...,
  showTextDocument: vi.fn(),
  setStatusBarMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
},
```

(Existing test file may already have some of these — merge, don't overwrite.)

- [ ] **Step 3: Run test to verify failure**

Run: `npm test -- src/test/SessionSitterViewProvider.test.ts -t "copy transcript"`
Expected: FAIL — handlers don't exist yet.

- [ ] **Step 4: Implement the three handlers**

In `src/SessionSitterViewProvider.ts`, inside the `onDidReceiveMessage` switch, alongside `case 'uploadToCorpus':`:

```ts
case 'copyTranscriptToEditor': {
  const sid = message.sessionId as string | undefined;
  if (!sid) { break; }
  void (async () => {
    const md = await this._sessionManager.exportFullTranscript(sid);
    if (md === null) {
      void vscode.window.showWarningMessage(`Session ${sid} no longer exists.`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
    await vscode.window.showTextDocument(doc);
  })();
  break;
}
case 'copyTranscriptToClipboard': {
  const sid = message.sessionId as string | undefined;
  if (!sid) { break; }
  void (async () => {
    const md = await this._sessionManager.exportFullTranscript(sid);
    if (md === null) {
      void vscode.window.showWarningMessage(`Session ${sid} no longer exists.`);
      return;
    }
    await vscode.env.clipboard.writeText(md);
    const bytes = Buffer.byteLength(md, 'utf8');
    vscode.window.setStatusBarMessage(
      `Transcript copied — ${(bytes / 1024).toFixed(1)} KB`,
      4000,
    );
  })();
  break;
}
case 'copyTranscriptToFile': {
  const sid = message.sessionId as string | undefined;
  if (!sid) { break; }
  void (async () => {
    const md = await this._sessionManager.exportFullTranscript(sid);
    if (md === null) {
      void vscode.window.showWarningMessage(`Session ${sid} no longer exists.`);
      return;
    }
    const tmpPath = path.join(os.tmpdir(), `transcript-${sid}.md`);
    await fs.promises.writeFile(tmpPath, md, 'utf8');
    const pick = await vscode.window.showInformationMessage(
      `Transcript saved: ${tmpPath}`,
      'Reveal in Finder',
    );
    if (pick === 'Reveal in Finder') {
      void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(tmpPath));
    }
  })();
  break;
}
```

Ensure `import * as os from 'os'; import * as path from 'path'; import * as fs from 'fs';` are already in the file (they should be — check the existing imports).

- [ ] **Step 5: Run tests + full check**

```bash
npm run compile && npm test && npm run lint
```
Expected: **122 tests** (118 + 4 new).

- [ ] **Step 6: Commit**

```bash
git add src/SessionSitterViewProvider.ts src/test/SessionSitterViewProvider.test.ts
git commit -m "feat: ViewProvider handlers for copyTranscriptToEditor/Clipboard/File"
```

---

### Task 7: Webview DOM submenu utility + `Copy transcript ▸` wiring + CSS

**Files:**
- Modify: `src/webview/main.js` — add `openSubmenu(parentBtn, items)` utility; extend the `items` array in `openContextMenu` with the parent item; update the item-rendering loop to handle items with a `submenu` field.
- Modify: `src/webview/styles.css` — add `.session-context-menu--sub` class and a `.session-context-menu-item--parent` class (renders the `▸` chevron and reserves a hover trigger).

**Interfaces:**
- Consumes: `session.sessionId` from the row that was right-clicked; `vscodeApi.postMessage` for dispatching to the ViewProvider handlers from Task 6.
- Produces: user-visible submenu behavior described in the spec (hover-open with 150 ms delay, keyboard arrow nav, escape to close).

- [ ] **Step 1: Read the current `openContextMenu` implementation**

Study `src/webview/main.js` from the `openContextMenu` function definition through the `items.forEach` loop that renders each row. The submenu extension has to preserve the existing rendering path for items that do **not** have a `submenu` field.

- [ ] **Step 2: Extend the items-rendering loop**

Change the existing loop:

```js
items.forEach(function (itemDef) {
  const btn = document.createElement('button');
  btn.className = 'session-context-menu-item';
  btn.setAttribute('role', 'menuitem');
  btn.type = 'button';
  btn.textContent = itemDef.label;
  btn.addEventListener('click', function () {
    itemDef.action();
    closeContextMenu();
  });
  menu.appendChild(btn);
});
```

To:

```js
items.forEach(function (itemDef) {
  const btn = document.createElement('button');
  btn.className = 'session-context-menu-item';
  btn.setAttribute('role', 'menuitem');
  btn.type = 'button';
  btn.textContent = itemDef.label;
  if (itemDef.submenu) {
    btn.classList.add('session-context-menu-item--parent');
    let subEl = null;
    let openTimer = null;
    let closeTimer = null;
    const openSub = function () {
      clearTimeout(closeTimer);
      if (subEl) { return; }
      subEl = renderSubmenu(btn, itemDef.submenu);
    };
    const closeSub = function () {
      if (!subEl) { return; }
      subEl.remove();
      subEl = null;
    };
    btn.addEventListener('mouseenter', function () {
      clearTimeout(closeTimer);
      openTimer = setTimeout(openSub, 150);
    });
    btn.addEventListener('mouseleave', function (event) {
      clearTimeout(openTimer);
      // Give the pointer time to reach the submenu before we tear it down.
      closeTimer = setTimeout(function () {
        if (subEl && !subEl.contains(event.relatedTarget)) { closeSub(); }
      }, 200);
    });
    btn.addEventListener('click', openSub);
    btn.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowRight' || event.key === 'Enter') {
        event.preventDefault();
        openSub();
        const first = subEl && subEl.querySelector('.session-context-menu-item');
        if (first) { first.focus(); }
      }
    });
  } else {
    btn.addEventListener('click', function () {
      itemDef.action();
      closeContextMenu();
    });
  }
  menu.appendChild(btn);
});
```

- [ ] **Step 3: Add the `renderSubmenu` helper**

Just above `openContextMenu`, add:

```js
/**
 * Render a submenu adjacent to a parent menu-item button. Returns the
 * submenu element (already inserted into the DOM), or null if items is empty.
 */
function renderSubmenu(parentBtn, items) {
  const sub = document.createElement('div');
  sub.className = 'session-context-menu session-context-menu--sub';
  sub.setAttribute('role', 'menu');

  items.forEach(function (subItem) {
    const btn = document.createElement('button');
    btn.className = 'session-context-menu-item';
    btn.setAttribute('role', 'menuitem');
    btn.type = 'button';
    btn.textContent = subItem.label;
    btn.addEventListener('click', function () {
      subItem.action();
      closeContextMenu();
    });
    btn.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowLeft' || event.key === 'Escape') {
        event.preventDefault();
        sub.remove();
        parentBtn.focus();
      }
    });
    sub.appendChild(btn);
  });

  // Position to the right of parent; flip to the left if it would overflow.
  document.body.appendChild(sub);
  const parentRect = parentBtn.getBoundingClientRect();
  const subRect = sub.getBoundingClientRect();
  let left = parentRect.right;
  if (left + subRect.width > window.innerWidth - 4) {
    left = Math.max(4, parentRect.left - subRect.width);
  }
  sub.style.left = left + 'px';
  sub.style.top = Math.max(4, Math.min(parentRect.top, window.innerHeight - subRect.height - 4)) + 'px';

  return sub;
}
```

- [ ] **Step 4: Add the `Copy transcript ▸` parent to the items array**

In `openContextMenu`, extend the `items` array (insert before `Upload to the corpus` — the copy actions belong grouped with the other Copy items):

```js
const items = [
  { label: 'Show details', action: function () { /* existing */ } },
  { label: 'Copy title', action: function () { /* existing */ } },
  { label: 'Copy session ID', action: function () { /* existing */ } },
  { label: 'Copy transcript', submenu: [
      { label: 'To editor',    action: function () { vscodeApi.postMessage({ type: 'copyTranscriptToEditor',    sessionId: session.sessionId }); }},
      { label: 'To clipboard', action: function () { vscodeApi.postMessage({ type: 'copyTranscriptToClipboard', sessionId: session.sessionId }); }},
      { label: 'To file',      action: function () { vscodeApi.postMessage({ type: 'copyTranscriptToFile',     sessionId: session.sessionId }); }},
  ]},
  { label: 'Upload to the corpus', action: function () { /* existing */ } },
];
```

The `▸` chevron is added via CSS on `.session-context-menu-item--parent::after`, not in the label text.

- [ ] **Step 5: Update `closeContextMenu` to also close any open submenu**

Find `closeContextMenu` and extend:

```js
function closeContextMenu() {
  if (contextMenuEl) {
    // Clean up any open submenus first.
    document.querySelectorAll('.session-context-menu--sub').forEach(function (s) { s.remove(); });
    contextMenuEl.remove();
    contextMenuEl = null;
  }
}
```

- [ ] **Step 6: Add the CSS**

In `src/webview/styles.css`, after the existing `.session-context-menu` rules:

```css
.session-context-menu--sub {
  /* Same visual style as the base menu — the shared class inherits everything. */
  position: fixed;
  z-index: 1001;
}

.session-context-menu-item--parent {
  padding-right: 22px;
  position: relative;
}

.session-context-menu-item--parent::after {
  content: '▸';
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 10px;
  opacity: 0.6;
}
```

- [ ] **Step 7: Compile + full check**

```bash
npm run compile && npm test && npm run lint
```
Expected: 122 tests still passing (no new tests — the DOM submenu is manually verified in Task 8).

- [ ] **Step 8: Commit**

```bash
git add src/webview/main.js src/webview/styles.css
git commit -m "feat: DOM submenu utility + Copy transcript submenu in the Session Sitter right-click menu"
```

---

### Task 8: Version bump, package `.vsix`, install, manual verification

**Files:**
- Modify: `package.json` — version `0.0.8` → `0.0.9`.
- Produce: `session-sitter-0.0.9.vsix` (git-ignored artifact).

**Interfaces:**
- Consumes: all prior tasks.
- Produces: an installable `.vsix` and a documented manual verification pass.

- [ ] **Step 1: Bump version**

In `package.json`:

```json
  "version": "0.0.8",
```
becomes:

```json
  "version": "0.0.9",
```

- [ ] **Step 2: Full check**

```bash
npm run compile && npm test && npm run lint
```
Expected: 122 tests pass; 0 lint errors (1 pre-existing warning OK); tsc clean. Run `npm test` five consecutive times to confirm stability.

- [ ] **Step 3: Package**

```bash
rm -f session-sitter-*.vsix
npx --yes @vscode/vsce package
```
Expected: `Packaged: /…/session-sitter-0.0.9.vsix`.

- [ ] **Step 4: Install**

```bash
code --install-extension "$(pwd)/session-sitter-0.0.9.vsix" --force
```

- [ ] **Step 5: Reload VS Code and verify manually**

Cmd+Shift+P → **Developer: Reload Window**. In the Session Sitter view:

- Right-click any Claude row → the menu shows a `Copy transcript ▸` row with the chevron indicator.
- Hover the parent row for ~150 ms → the submenu opens to the right (or left, if the parent is near the viewport edge).
- Right-arrow on the parent → submenu opens and focus moves into it.
- Left-arrow inside the submenu → submenu closes, focus returns to the parent.
- Escape → both menus close.
- Click **To editor** → a new untitled Markdown editor tab appears with the transcript. The markdown starts with `# <title>` and `*Copied from Claude · …*`.
- Click **To clipboard** → status bar shows *"Transcript copied — X.Y KB"* for ~4 seconds. Paste anywhere to confirm.
- Click **To file** → info toast shows a path in `/tmp/transcript-*.md`; the **Reveal in Finder** button opens Finder to that file.
- Repeat every step for a Bob row, a Codex row (if any), and a Chat row.

- [ ] **Step 6: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 0.0.9 for Copy transcript support"
```

- [ ] **Step 7: Push + open PR**

```bash
git push -u bcarmeli feat_2/copy-transcript-to-editor
```

Then open the PR against `eranra:main` (this is a fork-based PR — same flow as PR #10). Compose the body from the spec's overview plus the manual-verification checklist above. Reference PR #10 in the body — if #10 has not merged yet, note that reviewers should look at it first since this branch is stacked on top:

```bash
gh pr create --repo eranra/session-sitter --base main \
  --head bcarmeli:feat_2/copy-transcript-to-editor \
  --title "feat: Copy transcript context-menu on Session Sitter view" \
  --body "$(cat <<'EOF'
## Summary

Right-click any row in the Session Sitter view → **Copy transcript ▸** → **To editor** / **To clipboard** / **To file**. Extracts the session's full conversation as handoff-clean markdown from any of the four sources (Claude · Bob · Codex · Chat).

**Stacked on:** #10 (Codex + VS Code Chat session support). Review PR #10 first if it has not merged yet.

## What's in the box

- `SessionManager.exportFullTranscript(sessionId)` — one entry-point, dispatches to per-source extractors.
- Per-source extractors: `_getClaudeFullTranscript`, `_getBobFullTranscript`, `_getCodexFullTranscript`, `_getChatFullTranscript` — read-only, handoff-clean (tool_use / tool_result / thinking / function_call / scaffolding dropped).
- `_renderTranscriptAsMarkdown` — shared markdown formatter.
- Three postMessage handlers in `SessionSitterViewProvider` (editor / clipboard / file).
- DOM submenu utility in `webview/main.js` — reusable pattern for the follow-up **Send to ▸** feature.

## Non-goals (deferred to follow-up PRs)

- **Send to <target-session> ▸** submenu that auto-injects into another running session (would use `InspectorBobSender` for Bob targets, clipboard for others).
- **Summarize with human review** step.

## Manual verification

The plan's Task 8 checklist covers the manual pass. Same content copied here:

- [ ] Right-click a session row → menu shows `Copy transcript ▸` with a `▸` chevron.
- [ ] Hover the parent for ~150 ms → submenu opens.
- [ ] Right-arrow on parent, left-arrow inside submenu, Escape — all work.
- [ ] **To editor** opens an untitled markdown tab with the correct content.
- [ ] **To clipboard** writes the transcript and shows a status message with the byte count.
- [ ] **To file** writes to `/tmp/transcript-*.md` and offers a **Reveal in Finder** button.
- [ ] All four source types (Claude, Bob, Codex, Chat) produce non-empty transcripts.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
