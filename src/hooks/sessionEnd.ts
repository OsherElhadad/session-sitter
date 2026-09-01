#!/usr/bin/env node
/**
 * The `SessionEnd` hook — close the session's audit record out.
 *
 * The registration file written at `SessionStart` says a session exists; without this, it says so
 * forever, and a worklist cannot tell a running session from one that ended two days ago. So the
 * same file is stamped with an end time, the reason, and the decision count — which is what makes
 * the overnight digest a bounded question ("this run", not "everything on disk").
 *
 * `SessionEnd` shares a **1.5 second** budget across all hooks, and a plugin's own `timeout` cannot
 * raise it. So this reads one small file, counts lines already on disk, and writes one file. It
 * never loads policy and never spawns anything.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DecisionRecord, readJsonl } from '../audit/trail';
import { decisionsPath, sessionPath } from './paths';
import { HookInput, runHook } from './io';

export async function handle(input: HookInput): Promise<Record<string, never>> {
  const sessionId = input.session_id ?? 'unknown';
  const file = sessionPath(sessionId);

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    // No registration — a session that started before the plugin was enabled, or a cleared data
    // dir. Close it out anyway rather than dropping the record.
  }

  const mine = readJsonl<DecisionRecord>(decisionsPath()).filter(r => r.sessionId === sessionId);
  const closed = {
    ...existing,
    sessionId,
    endedAt: new Date().toISOString(),
    endReason: typeof input.reason === 'string' ? input.reason : null,
    decisions: mine.length,
    denied: mine.filter(r => r.decision === 'deny').length,
    corrected: mine.filter(r => r.rewritten).length,
  };
  try {
    // The directory may not exist: a session that started before the plugin was enabled never had
    // a registration written, and closing it out is still worth doing.
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, `${JSON.stringify(closed, null, 2)}\n`, 'utf8');
  } catch {
    // Nothing useful to do inside a 1.5 s budget with no way to report it. The decisions
    // themselves are already durable in the trail.
  }
  return {};
}

if (require.main === module) {
  void runHook(handle);
}
