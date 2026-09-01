#!/usr/bin/env node
/**
 * The `PostToolUse` and `PostToolUseFailure` hooks — the wedge detector's input.
 *
 * Nothing in the ecosystem distinguishes an agent that is *working* from one that is *wedged*. The
 * signature of wedged is cheap to record and impossible to reconstruct later: the same call, over
 * and over, with nothing changing. So each tool result appends one line — which tool, a hash of the
 * input, whether it failed, when.
 *
 * One module serves both events; they differ only in the outcome they report, which is read from
 * `hook_event_name`. These fire on **every** tool call, so this is the hottest path in the plugin:
 * no policy is loaded, no practices file is read, nothing is parsed beyond the event itself.
 *
 * The input itself is deliberately not stored, only its fingerprint. A repeated identical call is
 * detectable from equal fingerprints, and a log of every argument to every tool is a liability that
 * buys nothing this needs.
 */

import { ActivityRecord, appendJsonl, fingerprint } from '../audit/trail';
import { activityPath } from './paths';
import { HookInput, runHook } from './io';

export async function handle(input: HookInput): Promise<Record<string, never>> {
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
  const toolInput = (input.tool_input ?? null) as Record<string, unknown> | null;
  appendJsonl(activityPath(), {
    ts: new Date().toISOString(),
    sessionId: input.session_id ?? 'unknown',
    tool: toolName,
    fingerprint: fingerprint(toolName, toolInput),
    ok: input.hook_event_name !== 'PostToolUseFailure',
  } satisfies ActivityRecord);
  // Neither event can block, and this hook has nothing to tell Claude — so no decision fields.
  return {};
}

if (require.main === module) {
  void runHook(handle);
}
