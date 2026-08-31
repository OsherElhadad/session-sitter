/**
 * Who a supervision decision belongs to: the session's human name and the machine it runs on.
 *
 * A record's `session_id` is a UUID (Claude) or a task id (Bob) — unreadable, and identical in
 * shape on every machine. With one Telegram chat receiving decisions from several machines, and a
 * panel listing decisions from several sessions, that id cannot answer the only question the user
 * actually has: *which session was this?* So every record carries a name and a host, and both the
 * card and the feed render them through the helpers here — one format, one place to change it.
 *
 * Pure except for `localHostName`, the single reader of `os.hostname()`.
 */

import * as os from 'os';

/** Drop the DNS domain from a host name: "box.lan" → "box". Trims whitespace. */
export function shortHost(name: string | null | undefined): string {
  return (name ?? '').trim().split('.')[0];
}

/** The short name of the machine this extension — and so this supervisor — runs on. */
export function localHostName(): string {
  try { return shortHost(os.hostname()); } catch { return ''; }
}

/**
 * The host out of a peer spec ("user@host", as `ClaudeSession.peer` carries it). An empty or
 * malformed spec yields '' so the caller can fall back to the local host.
 */
export function hostFromPeer(peer: string | null | undefined): string {
  if (!peer) { return ''; }
  const at = peer.lastIndexOf('@');
  return shortHost(at >= 0 ? peer.slice(at + 1) : peer);
}

/**
 * The name to record for a session: its title, else its project name. Null when it has neither,
 * so the display falls back to the id rather than showing an empty label.
 */
export function sessionNameFrom(
  session: { title?: string | null; projectName?: string | null },
): string | null {
  const title = (session.title ?? '').trim();
  if (title) { return title; }
  const project = (session.projectName ?? '').trim();
  return project || null;
}

/** What a session is called, given its recorded name and its id. Never empty (unless both are). */
export function sessionDisplayName(
  sessionName: string | null | undefined, sessionId: string,
): string {
  const name = (sessionName ?? '').trim();
  return name || (sessionId ?? '');
}

/**
 * One line naming the session a decision belongs to:
 *
 *     session: fix the login flow @ devbox (a1b2c3d4-…)
 *
 * The id is appended only when the name is something other than the id itself, so a record
 * written before names existed still reads exactly `session: <id>`.
 */
export function sessionRefLine(
  fields: { session_name?: string | null; host?: string | null; session_id: string },
): string {
  const id = fields.session_id ?? '';
  const name = sessionDisplayName(fields.session_name, id);
  const host = shortHost(fields.host);
  let line = `session: ${name}`;
  if (host) { line += ` @ ${host}`; }
  if (id && name !== id) { line += ` (${id})`; }
  return line;
}
