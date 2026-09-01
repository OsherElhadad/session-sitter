#!/usr/bin/env node
/**
 * The `SessionStart` hook — register this session so it exists to the rest of the product.
 *
 * A bare `claude` in a terminal is invisible to a VS Code panel and, being local, invisible to a
 * peer machine. Writing one small file per session is what makes it appear in the worklist, and it
 * is what lets the audit trail say whose decision a record belongs to: the trail stores a session
 * id, and without this file that id names nothing.
 *
 * `SessionStart` runs on every session *including resume*, so it is written to be cheap and
 * idempotent — one small JSON file, overwritten.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HookInput, runHook } from './io';
import { sessionPath } from './paths';

export interface SessionRecord {
  sessionId: string;
  cwd: string;
  pid: number;
  /** The session's display name, when Claude Code has one. */
  name: string | null;
  model: string | null;
  /** startup | resume | clear | compact | fork */
  source: string | null;
  startedAt: string;
  /** So a reader can tell a live session from one whose machine rebooted. */
  host: string;
}

/** The model id, whether it arrived as a string or as a `{id, display_name}` object. */
export function modelName(model: unknown): string | null {
  if (typeof model === 'string') { return model || null; }
  if (model && typeof model === 'object') {
    const m = model as Record<string, unknown>;
    for (const key of ['id', 'display_name']) {
      if (typeof m[key] === 'string' && m[key]) { return m[key] as string; }
    }
  }
  return null;
}

export async function handle(input: HookInput): Promise<Record<string, never>> {
  const sessionId = input.session_id ?? 'unknown';
  const record: SessionRecord = {
    sessionId,
    cwd: input.cwd ?? '',
    // The hook process's own parent is the `claude` process, which is what a worklist wants to
    // know about — `process.pid` here is this short-lived hook.
    pid: typeof process.ppid === 'number' ? process.ppid : process.pid,
    name: typeof input.session_title === 'string' ? input.session_title : null,
    // `model` is documented as optional and arrives as a bare id in some versions and as
    // `{id, display_name}` in others, so both are accepted rather than one being assumed.
    model: modelName(input.model),
    source: typeof input.source === 'string' ? input.source : null,
    startedAt: new Date().toISOString(),
    host: os.hostname(),
  };
  const file = sessionPath(sessionId);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  // No decision fields: this event only accepts context, and this hook has none to add.
  return {};
}

if (require.main === module) {
  void runHook(handle);
}
