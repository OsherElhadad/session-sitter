#!/usr/bin/env node
/**
 * The `Notification` hook — record how long a human was waited on.
 *
 * `idle_prompt` fires roughly 60 s after Claude finishes a turn if nobody has typed;
 * `permission_prompt` roughly 6 s after a permission dialog appears. Together they are the only
 * observation of the waiting state itself, which is the number an "unattended survival" claim lives
 * or dies on: a run that waited four hours on a prompt did not run unattended.
 *
 * **This hook cannot answer anything.** `Notification` accepts no decision fields — output is
 * discarded, exit codes do nothing. Answering a permission prompt is `PermissionRequest`'s job and
 * answering a question is not programmatically possible at all. So this records, and nothing else.
 */

import { appendJsonl } from '../audit/trail';
import { activityPath } from './paths';
import { HookInput, runHook } from './io';

export interface WaitRecord {
  ts: string;
  sessionId: string;
  /** idle_prompt | permission_prompt | agent_needs_input | … */
  waiting: string;
  message: string | null;
}

export async function handle(input: HookInput): Promise<Record<string, never>> {
  appendJsonl(activityPath(), {
    ts: new Date().toISOString(),
    sessionId: input.session_id ?? 'unknown',
    waiting: typeof input.notification_type === 'string' ? input.notification_type : 'unknown',
    // The notification text, not the tool input — nothing sensitive is expected here, and the
    // trail's own summariser is for tool inputs.
    message: typeof input.message === 'string' ? input.message.slice(0, 200) : null,
  } satisfies WaitRecord);
  return {};
}

if (require.main === module) {
  void runHook(handle);
}
