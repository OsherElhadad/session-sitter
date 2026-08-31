import * as fs from 'fs';
import * as path from 'path';
import { sessionDisplayName, shortHost } from './supervisor/sessionIdentity';

/** One row in the Activity feed — a supervision decision the user should be able to see. */
export interface ActivityItem {
  requestId: string;
  sessionId: string;
  /** The session's human name — its title, else its project name, else the session id. */
  sessionName: string;
  /** Short name of the machine the session runs on ('' when the record predates the field). */
  host: string;
  light: string;        // green | yellow | orange | red | ''
  summary: string;
  userIntent: string;
  agentIntent: string;
  humanNotification: string;
  options: string[];    // human_options offered on the card
  state: string;        // lifecycle state (green_completed, orange_awaiting_user, ...)
  awaitLight: string | null;
  userResponse: string | null;
  error: string | null; // failure reason (state === 'failed'); powers the debuggable card
  at: string;           // ISO timestamp (last event / file mtime)
  /** 'rule' when a deterministic auto-respond rule decided this, else 'supervisor'. */
  decidedBy: string;
  /** For a rule decision: a one-line "what fired and what it did" label for the card. */
  ruleLabel: string;
}

/**
 * A one-line description of the deterministic rule that produced a decision: the pattern that
 * matched and what it did. Empty when the record was not decided by a rule.
 */
export function ruleLabelFor(rule: Record<string, unknown> | null | undefined): string {
  if (!rule || typeof rule !== 'object') { return ''; }
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const pattern = str(rule.pattern);
  if (!pattern) { return ''; }
  const kind = str(rule.kind);
  const args = str(rule.argument_pattern);
  const scope = kind === 'text' ? `/${pattern}/` : `'${pattern}'`;
  const narrowed = args ? ` + args /${args}/` : '';
  const did = kind === 'text' ? 'auto-reply' : (str(rule.decision) || 'auto-approve');
  return `${scope}${narrowed} → ${did}`;
}

/** Map a supervision record JSON (STATE_DIR/records/<id>.json) to a compact feed item. */
export function recordToItem(raw: string, mtimeMs: number): ActivityItem | null {
  let r: Record<string, unknown>;
  try { r = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  if (typeof r.request_id !== 'string') { return null; }
  const a = (r.assessment as Record<string, unknown> | null) ?? {};
  const events = Array.isArray(r.events) ? r.events as Array<{ at?: string; type?: string; error?: string }> : [];
  const lastAt = events.length ? events[events.length - 1].at : undefined;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const opts = Array.isArray(a.human_options) ? a.human_options.filter(o => typeof o === 'string') as string[] : [];
  // Failure reason: prefer the record's top-level `error`, fall back to the last `failed` event.
  const failedEvent = [...events].reverse().find(e => e.type === 'failed' && typeof e.error === 'string');
  const error = str(r.error) || (failedEvent?.error ?? '') || null;
  return {
    requestId: r.request_id,
    sessionId: str(r.session_id),
    // A card without these is unattributable: every session id looks the same, and one panel now
    // shows decisions taken on several machines. Falls back to the id, never to an empty label.
    sessionName: sessionDisplayName(str(r.session_name), str(r.session_id)),
    host: shortHost(str(r.host)),
    light: str(a.traffic_light),
    summary: str(a.summary),
    userIntent: str(a.user_intent),
    agentIntent: str(a.agent_intent),
    humanNotification: str(a.human_notification),
    options: opts,
    state: str(r.state),
    awaitLight: typeof r.await_light === 'string' ? r.await_light : null,
    userResponse: typeof r.user_response === 'string' ? r.user_response : null,
    error,
    at: lastAt || new Date(mtimeMs).toISOString(),
    decidedBy: str(r.decided_by) || 'supervisor',
    ruleLabel: ruleLabelFor(r.rule as Record<string, unknown> | null),
  };
}

/**
 * Watches the supervisor's `records/` dir and pushes a newest-first feed of decisions to the
 * webview. Polls (fs.watch is unreliable across platforms/WSL2); fires the callback only when
 * the set of records changes so the UI isn't spammed.
 */
export class SupervisionActivity {
  private readonly _recordsDir: string;
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _fingerprint = '';

  constructor(
    stateDir: string,
    private readonly _onChange: (items: ActivityItem[]) => void,
    private readonly _limit = 40,
  ) {
    this._recordsDir = path.join(stateDir, 'records');
  }

  start(intervalMs = 2000): void {
    void this._scan();
    this._timer = setInterval(() => { void this._scan(); }, intervalMs);
  }

  /** Read + push the current feed immediately (used on webview 'ready'/toggle). */
  pushNow(): void { void this._scan(true); }

  dispose(): void {
    if (this._timer !== undefined) { clearInterval(this._timer); this._timer = undefined; }
  }

  private async _scan(force = false): Promise<void> {
    let files: string[];
    try {
      files = (await fs.promises.readdir(this._recordsDir)).filter(f => f.endsWith('.json'));
    } catch {
      if (force) { this._onChange([]); }
      return; // dir not created yet
    }

    // Records accumulate for the life of the state dir, and every applied auto-respond rule adds
    // one — so this directory gets large. Stat everything (cheap), then parse only the newest
    // `_limit` files: the feed shows that many anyway, and the parse is what costs.
    const stats: Array<{ file: string; mtimeMs: number }> = [];
    for (const file of files) {
      try {
        const stat = await fs.promises.stat(path.join(this._recordsDir, file));
        stats.push({ file, mtimeMs: stat.mtimeMs });
      } catch { /* vanished between readdir and stat */ }
    }
    stats.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const items: ActivityItem[] = [];
    for (const { file, mtimeMs } of stats.slice(0, this._limit)) {
      try {
        const raw = await fs.promises.readFile(path.join(this._recordsDir, file), 'utf8');
        const item = recordToItem(raw, mtimeMs);
        if (item) { items.push(item); }
      } catch { /* skip unreadable/half-written */ }
    }
    // A record's own last-event timestamp is the display order; mtime only chose the candidates.
    items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    const trimmed = items.slice(0, this._limit);
    const fp = trimmed.map(i => `${i.requestId}:${i.state}:${i.at}`).join('|');
    if (force || fp !== this._fingerprint) {
      this._fingerprint = fp;
      this._onChange(trimmed);
    }
  }
}
