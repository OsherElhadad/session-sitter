// GENERATED FILE — DO NOT EDIT.
// Compiled from src/supervisor/timeutil.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Small time helpers. A single `Clock` type lets tests inject controllable time
 * (essential for the Orange timeout lifecycle).
 *
 * Ported from the Python supervisor (`timeutil.py`. All timestamps are ISO 8601 in UTC.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.nowUtc = nowUtc;
exports.toIso = toIso;
exports.fromIso = fromIso;
exports.deadlineFrom = deadlineFrom;
exports.isPast = isPast;
exports.minutesUntil = minutesUntil;
function nowUtc() {
    return new Date();
}
function toIso(d) {
    return d.toISOString();
}
/**
 * Parse an ISO 8601 timestamp. A value with no timezone is read as UTC, matching
 * Python's `datetime.fromisoformat` + `replace(tzinfo=utc)` behavior.
 */
function fromIso(s) {
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s.trim());
    const d = new Date(hasZone ? s : `${s.trim()}Z`);
    if (Number.isNaN(d.getTime())) {
        throw new RangeError(`invalid ISO timestamp: ${s}`);
    }
    return d;
}
function deadlineFrom(now, minutes) {
    return toIso(new Date(now.getTime() + minutes * 60000));
}
function isPast(deadlineIso, now) {
    return now.getTime() >= fromIso(deadlineIso).getTime();
}
/** Whole minutes remaining until `deadlineIso`, floored at 0. */
function minutesUntil(deadlineIso, now) {
    const ms = fromIso(deadlineIso).getTime() - now.getTime();
    return Math.max(0, Math.floor(ms / 60000));
}
