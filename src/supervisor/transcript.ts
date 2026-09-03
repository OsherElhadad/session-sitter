/**
 * Consume the full session transcript exported by the extension.
 *
 * Ported from the Python supervisor (`transcript.py`. `SessionExporter` is the single reader of
 * the agents' stores; it writes a JSON *export contract* to `STATE_DIR/history/<sessionId>.json`
 * and this module loads and validates that contract into a `NormalizedSession`.
 *
 * Export contract (camelCase, TS-native). Keys are accepted case-tolerantly so a file written
 * by the original Python-era tooling (snake_case) still loads.
 */

import * as fs from 'fs';
import * as path from 'path';

/** The one definition. `SessionExporter` imports it from here — this module has no `vscode`
 *  dependency, so it is the half of the pair both sides can reach. Two copies drift. */
export const EXPORT_SCHEMA_VERSION = '1.0';

/** Raised when a transcript export is missing or malformed. Fails loud, never silent. */
export class TranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptError';
  }
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  permission: string | null;
}

export interface ToolResult {
  callId: string;
  name: string;
  permission: string | null;
  isError: boolean;
  content: string;
}

export interface Turn {
  index: number;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  timestamp: string | null;
  toolCalls: ToolCall[];
  toolResult: ToolResult | null;
}

export interface PendingAction {
  kind: string; // tool_call | question | unknown
  description: string;
  name: string | null;
  arguments: Record<string, unknown> | null;
  permission: string | null;
  turnIndex: number | null;
  /** The live approval requestId when this pending action is a blocked tool-approval prompt
   *  (read from the agent's memory by the extension). Lets the supervisor resolve it. */
  requestId: string | null;
}

export interface NormalizedSession {
  sessionId: string;
  source: string;
  turns: Turn[];
  waitingReason: string;
  user: string | null;
  projectPath: string;
  projectName: string;
  status: string;
  approvalConfig: unknown;
  title: string;
  pendingAction: PendingAction | null;
}

/** The first genuine user turn — the user's original ask. */
export function originalRequest(s: NormalizedSession): string {
  for (const turn of s.turns) {
    if (turn.role === 'user' && turn.text.trim()) { return turn.text; }
  }
  return '';
}

export function lastUserMessage(s: NormalizedSession): string {
  for (let i = s.turns.length - 1; i >= 0; i--) {
    const turn = s.turns[i];
    if (turn.role === 'user' && turn.text.trim()) { return turn.text; }
  }
  return '';
}

function pick(d: Record<string, unknown>, keys: string[], fallback: unknown = undefined): unknown {
  for (const k of keys) {
    if (k in d && d[k] !== null && d[k] !== undefined) { return d[k]; }
  }
  return fallback;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;

function parseToolCall(d: Record<string, unknown>): ToolCall {
  const raw = pick(d, ['arguments', 'args'], {});
  const args = asRecord(raw) ?? { _raw: raw };
  return {
    id: String(pick(d, ['id'], '')),
    name: String(pick(d, ['name'], '')),
    arguments: args,
    permission: (pick(d, ['permission'], null) as string | null),
  };
}

function parseToolResult(d: Record<string, unknown>): ToolResult {
  return {
    callId: String(pick(d, ['callId', 'call_id', 'id'], '')),
    name: String(pick(d, ['name'], '')),
    permission: (pick(d, ['permission'], null) as string | null),
    isError: Boolean(pick(d, ['isError', 'is_error'], false)),
    content: String(pick(d, ['content'], '')),
  };
}

function parseTurn(d: unknown, fallbackIndex: number): Turn {
  const o = asRecord(d);
  if (!o) { throw new TranscriptError(`turn #${fallbackIndex} is not an object`); }
  const role = pick(o, ['role']);
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') {
    throw new TranscriptError(`turn #${fallbackIndex} has invalid role: ${JSON.stringify(role)}`);
  }
  const callsRaw = pick(o, ['toolCalls', 'tool_calls'], []) as unknown;
  const resultRaw = asRecord(pick(o, ['toolResult', 'tool_result']));
  const idx = pick(o, ['index'], fallbackIndex);
  return {
    index: typeof idx === 'number' ? idx : Number(idx),
    role,
    text: String(pick(o, ['text'], '')),
    timestamp: (pick(o, ['timestamp'], null) as string | null),
    toolCalls: Array.isArray(callsRaw)
      ? callsRaw.map(asRecord).filter((c): c is Record<string, unknown> => c !== null).map(parseToolCall)
      : [],
    toolResult: resultRaw ? parseToolResult(resultRaw) : null,
  };
}

function parsePending(d: unknown): PendingAction | null {
  const o = asRecord(d);
  if (!o) { return null; }
  const args = asRecord(pick(o, ['arguments', 'args']));
  const turnIndex = pick(o, ['turnIndex', 'turn_index'], null);
  return {
    kind: String(pick(o, ['kind'], 'unknown')),
    description: String(pick(o, ['description'], '')),
    name: (pick(o, ['name'], null) as string | null),
    arguments: args,
    permission: (pick(o, ['permission'], null) as string | null),
    turnIndex: typeof turnIndex === 'number' ? turnIndex : null,
    requestId: (pick(o, ['requestId', 'request_id'], null) as string | null),
  };
}

export function sessionFromDict(data: unknown): NormalizedSession {
  const d = asRecord(data);
  if (!d) { throw new TranscriptError('transcript export must be a JSON object'); }

  const sessionId = pick(d, ['sessionId', 'session_id']);
  if (!sessionId) { throw new TranscriptError('transcript export missing sessionId'); }

  // The version pin is load-bearing or it is decoration. An export that declares a version we
  // do not know is refused rather than half-read: the fields we recognise may mean something
  // else in that version. Absent stays tolerated — the Python-era exports this loader still
  // documents support for predate the field, and every export we write carries it.
  const declared = pick(d, ['schemaVersion', 'schema_version'], null);
  if (declared != null && String(declared) !== EXPORT_SCHEMA_VERSION) {
    throw new TranscriptError(
      `unsupported transcript export schemaVersion '${String(declared)}' `
      + `(expected '${EXPORT_SCHEMA_VERSION}')`,
    );
  }

  const turnsRaw = pick(d, ['turns'], null);
  if (!Array.isArray(turnsRaw)) { throw new TranscriptError("transcript export missing 'turns' list"); }

  return {
    sessionId: String(sessionId),
    source: String(pick(d, ['source'], 'bob')),
    turns: turnsRaw.map((t, i) => parseTurn(t, i)),
    waitingReason: String(pick(d, ['waitingReason', 'waiting_reason'], '')),
    user: (pick(d, ['user'], null) as string | null),
    projectPath: String(pick(d, ['projectPath', 'project_path'], '')),
    projectName: String(pick(d, ['projectName', 'project_name'], '')),
    status: String(pick(d, ['status'], '')),
    approvalConfig: pick(d, ['approvalConfig', 'approval_config'], null),
    title: String(pick(d, ['title'], '')),
    pendingAction: parsePending(pick(d, ['pendingAction', 'pending_action'])),
  };
}

/** Abstract source of a normalized session transcript (extensible per harness). */
export interface TranscriptSource {
  load(sessionId: string): Promise<NormalizedSession>;
}

/**
 * Loads the export produced by `SessionExporter` at `history/<sessionId>.json`.
 * An explicit `overridePath` lets the CLI point at any export file for offline runs.
 */
export class FileTranscriptSource implements TranscriptSource {
  constructor(
    private readonly historyDir: string,
    private readonly overridePath?: string,
  ) {}

  pathFor(sessionId: string): string {
    return this.overridePath ?? path.join(this.historyDir, `${sessionId}.json`);
  }

  async load(sessionId: string): Promise<NormalizedSession> {
    const p = this.pathFor(sessionId);
    let raw: string;
    try {
      raw = await fs.promises.readFile(p, 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        throw new TranscriptError(
          `no transcript export at ${p}. Produce it with SessionExporter `
          + '(or pass --transcript <path>).',
        );
      }
      throw new TranscriptError(`failed to read transcript export ${p}: ${String(err)}`);
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new TranscriptError(`failed to read transcript export ${p}: ${String(err)}`);
    }
    const session = sessionFromDict(data);
    // The export filename is authoritative for the id we were asked about.
    if (session.sessionId !== sessionId && this.overridePath === undefined) {
      throw new TranscriptError(
        `transcript export sessionId ${JSON.stringify(session.sessionId)} != requested ${JSON.stringify(sessionId)}`,
      );
    }
    return session;
  }
}
