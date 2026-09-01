#!/usr/bin/env node
// GENERATED FILE — DO NOT EDIT.
// Compiled from src/hooks/notification.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.handle = handle;
const trail_1 = require("../audit/trail");
const paths_1 = require("./paths");
const io_1 = require("./io");
async function handle(input) {
    (0, trail_1.appendJsonl)((0, paths_1.activityPath)(), {
        ts: new Date().toISOString(),
        sessionId: input.session_id ?? 'unknown',
        waiting: typeof input.notification_type === 'string' ? input.notification_type : 'unknown',
        // The notification text, not the tool input — nothing sensitive is expected here, and the
        // trail's own summariser is for tool inputs.
        message: typeof input.message === 'string' ? input.message.slice(0, 200) : null,
    });
    return {};
}
if (require.main === module) {
    void (0, io_1.runHook)(handle);
}
