// GENERATED FILE — DO NOT EDIT.
// Compiled from src/cli/time.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Reading and writing the times a person actually types.
 *
 * `--since` has to accept both halves of how people describe "when": an absolute date they read
 * off a calendar (`2026-08-30`) and a relative span they hold in their head (`2h`, `yesterday`).
 * Supporting only the first makes the common case arithmetic homework; supporting only the second
 * makes yesterday's incident unqueryable.
 *
 * Everything relative is resolved against an injected `now`, so the tests are not racing the clock.
 * Bare dates and day words resolve in **local** time, because that is the day the person meant.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.startOfDay = startOfDay;
exports.parseSince = parseSince;
exports.lastEveningSix = lastEveningSix;
exports.humanAge = humanAge;
exports.clockTime = clockTime;
exports.shortStamp = shortStamp;
const args_1 = require("./args");
/** `<n><unit>` — seconds, minutes, hours, days, weeks. */
const RELATIVE_RE = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)$/i;
const UNIT_MS = {
    s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000,
};
/** Midnight at the start of the day `date` falls in, local time. */
function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
/**
 * Turn a `--since` value into an instant.
 *
 * Accepts, in the order they are tried: `now`; `today` / `yesterday` (midnight, local); a relative
 * span like `2h` or `45m` (that long ago); `YYYY-MM-DD` (midnight, local); anything else
 * `Date` itself parses, which covers a full ISO 8601 timestamp.
 *
 * Throws rather than guessing: a `--since` nobody can parse would otherwise silently become
 * "the beginning of time" and report far more than was asked for.
 */
function parseSince(value, now = new Date()) {
    const raw = value.trim();
    if (!raw) {
        throw new args_1.CliError('--since needs a value');
    }
    const lower = raw.toLowerCase();
    if (lower === 'now') {
        return new Date(now.getTime());
    }
    if (lower === 'today') {
        return startOfDay(now);
    }
    if (lower === 'yesterday') {
        return new Date(startOfDay(now).getTime() - UNIT_MS.d);
    }
    const relative = RELATIVE_RE.exec(lower);
    if (relative) {
        const amount = Number(relative[1]);
        const unit = relative[2][0]; // s | m | h | d | w — the first letter is unambiguous
        return new Date(now.getTime() - amount * UNIT_MS[unit]);
    }
    // A bare date means the whole of that local day, not 00:00 UTC — which `new Date('2026-08-30')`
    // would give us, and which is the previous day for anyone west of Greenwich.
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (dateOnly) {
        return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    }
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
        throw new args_1.CliError(`could not read --since "${value}" — try 2h, 30m, yesterday, 2026-08-30, `
            + 'or a full ISO timestamp');
    }
    return parsed;
}
/**
 * The default window for `digest`: 18:00 yesterday, local.
 *
 * "What did my agents do last night" starts when you stopped watching, and the end of the working
 * day is the closest fixed point to that. Deliberately not "24 hours ago", which slides through
 * the night and would answer a different question every time it is run.
 */
function lastEveningSix(now = new Date()) {
    const yesterday = new Date(startOfDay(now).getTime() - UNIT_MS.d);
    return new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 18, 0, 0, 0);
}
/**
 * How long ago, as a person would say it: `4s`, `12m`, `3h`, `2d`.
 *
 * One unit, never two: this goes in a column that has to stay narrow, and "how stale is this"
 * never needs a second significant figure. A time in the future reads `now` rather than a
 * negative, because a clock skew between two machines is not worth a confusing minus sign.
 */
function humanAge(from, now = new Date()) {
    const ms = now.getTime() - from.getTime();
    if (!Number.isFinite(ms) || ms < 1000) {
        return 'now';
    }
    if (ms < 60000) {
        return `${Math.floor(ms / 1000)}s`;
    }
    if (ms < 3600000) {
        return `${Math.floor(ms / 60000)}m`;
    }
    if (ms < 86400000) {
        return `${Math.floor(ms / 3600000)}h`;
    }
    return `${Math.floor(ms / 86400000)}d`;
}
/** `HH:MM:SS`, local — the only part of a timestamp that fits in a log column. */
function clockTime(at) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}
/** `MM-DD HH:MM`, local — for a log that spans more than one day. */
function shortStamp(at) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
