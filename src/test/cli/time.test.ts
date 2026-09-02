import { describe, it, expect } from 'vitest';
import { CliError } from '../../cli/args';
import { clockTime, humanAge, lastEveningSix, parseSince, shortStamp, startOfDay } from '../../cli/time';

// Fixed, and in local time on purpose: every day word and bare date in here resolves to the day the
// person meant, which is a local-time question.
const NOW = new Date(2026, 8, 1, 14, 35, 20); // 1 Sep 2026, 14:35:20 local

describe('parseSince', () => {
  it('reads the relative forms people actually type', () => {
    expect(parseSince('2h', NOW)).toEqual(new Date(2026, 8, 1, 12, 35, 20));
    expect(parseSince('45m', NOW)).toEqual(new Date(2026, 8, 1, 13, 50, 20));
    expect(parseSince('90s', NOW)).toEqual(new Date(2026, 8, 1, 14, 33, 50));
    expect(parseSince('3d', NOW)).toEqual(new Date(2026, 7, 29, 14, 35, 20));
    expect(parseSince('1w', NOW)).toEqual(new Date(2026, 7, 25, 14, 35, 20));
  });

  it('accepts the long unit names and ignores case and spacing', () => {
    expect(parseSince('2 hours', NOW)).toEqual(parseSince('2h', NOW));
    expect(parseSince('2H', NOW)).toEqual(parseSince('2h', NOW));
    expect(parseSince('30 MINUTES', NOW)).toEqual(parseSince('30m', NOW));
  });

  it('reads the day words as midnight, local', () => {
    expect(parseSince('today', NOW)).toEqual(new Date(2026, 8, 1, 0, 0, 0));
    expect(parseSince('yesterday', NOW)).toEqual(new Date(2026, 7, 31, 0, 0, 0));
    expect(parseSince('now', NOW)).toEqual(NOW);
  });

  it('reads a bare date as the start of that LOCAL day', () => {
    // `new Date('2026-08-30')` is 00:00 UTC, which is the previous day west of Greenwich — the
    // whole reason this is parsed by hand.
    expect(parseSince('2026-08-30', NOW)).toEqual(new Date(2026, 7, 30, 0, 0, 0));
  });

  it('accepts a full ISO timestamp', () => {
    expect(parseSince('2026-08-30T18:00:00Z', NOW).toISOString())
      .toBe('2026-08-30T18:00:00.000Z');
  });

  it('throws rather than silently meaning "the beginning of time"', () => {
    expect(() => parseSince('last tuesday', NOW)).toThrow(CliError);
    expect(() => parseSince('last tuesday', NOW)).toThrow(/could not read --since/);
    expect(() => parseSince('   ', NOW)).toThrow(/--since needs a value/);
  });
});

describe('lastEveningSix', () => {
  it('is 18:00 the previous local day — a fixed point, not a sliding 24 hours', () => {
    expect(lastEveningSix(NOW)).toEqual(new Date(2026, 7, 31, 18, 0, 0));
    // Asked again later the same day, it answers the same window.
    expect(lastEveningSix(new Date(2026, 8, 1, 23, 59, 0))).toEqual(new Date(2026, 7, 31, 18, 0, 0));
  });
});

describe('humanAge', () => {
  it('uses exactly one unit', () => {
    expect(humanAge(new Date(NOW.getTime() - 4_000), NOW)).toBe('4s');
    expect(humanAge(new Date(NOW.getTime() - 12 * 60_000), NOW)).toBe('12m');
    expect(humanAge(new Date(NOW.getTime() - 3 * 3_600_000), NOW)).toBe('3h');
    expect(humanAge(new Date(NOW.getTime() - 2 * 86_400_000), NOW)).toBe('2d');
  });

  it('says "now" for the last second and for a clock that is ahead', () => {
    expect(humanAge(NOW, NOW)).toBe('now');
    // Two machines' clocks disagree; a negative age is not worth a confusing minus sign.
    expect(humanAge(new Date(NOW.getTime() + 60_000), NOW)).toBe('now');
  });
});

describe('stamps', () => {
  it('formats the clock and the short stamp in local time', () => {
    expect(clockTime(NOW)).toBe('14:35:20');
    expect(shortStamp(NOW)).toBe('09-01 14:35');
  });
});

describe('startOfDay', () => {
  it('is midnight of the day the instant falls in', () => {
    expect(startOfDay(NOW)).toEqual(new Date(2026, 8, 1, 0, 0, 0, 0));
  });
});
