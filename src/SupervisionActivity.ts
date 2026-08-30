import * as fs from 'fs';
import * as path from 'path';

/** One row in the Activity feed — a supervision decision the user should be able to see. */
export interface ActivityItem {
  requestId: string;
  sessionId: string;
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
    const items: ActivityItem[] = [];
    for (const file of files) {
      try {
        const full = path.join(this._recordsDir, file);
        const [raw, stat] = await Promise.all([
          fs.promises.readFile(full, 'utf8'),
          fs.promises.stat(full),
        ]);
        const item = recordToItem(raw, stat.mtimeMs);
        if (item) { items.push(item); }
      } catch { /* skip unreadable/half-written */ }
    }
    items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    const trimmed = items.slice(0, this._limit);
    const fp = trimmed.map(i => `${i.requestId}:${i.state}:${i.at}`).join('|');
    if (force || fp !== this._fingerprint) {
      this._fingerprint = fp;
      this._onChange(trimmed);
    }
  }
}
