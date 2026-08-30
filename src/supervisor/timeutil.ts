/**
 * Small time helpers. A single `Clock` type lets tests inject controllable time
 * (essential for the Orange timeout lifecycle).
 *
 * Ported from `reckon_supervisor/timeutil.py`. All timestamps are ISO 8601 in UTC.
 */

export type Clock = () => Date;

export function nowUtc(): Date {
  return new Date();
}

export function toIso(d: Date): string {
  return d.toISOString();
}

/**
 * Parse an ISO 8601 timestamp. A value with no timezone is read as UTC, matching
 * Python's `datetime.fromisoformat` + `replace(tzinfo=utc)` behavior.
 */
export function fromIso(s: string): Date {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s.trim());
  const d = new Date(hasZone ? s : `${s.trim()}Z`);
  if (Number.isNaN(d.getTime())) { throw new RangeError(`invalid ISO timestamp: ${s}`); }
  return d;
}

export function deadlineFrom(now: Date, minutes: number): string {
  return toIso(new Date(now.getTime() + minutes * 60_000));
}

export function isPast(deadlineIso: string, now: Date): boolean {
  return now.getTime() >= fromIso(deadlineIso).getTime();
}

/** Whole minutes remaining until `deadlineIso`, floored at 0. */
export function minutesUntil(deadlineIso: string, now: Date): number {
  const ms = fromIso(deadlineIso).getTime() - now.getTime();
  return Math.max(0, Math.floor(ms / 60_000));
}
