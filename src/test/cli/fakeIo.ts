import type { Io } from '../../cli/render';

/** A terminal that is not one: captures what a command would print, and decides nothing by accident. */
export interface FakeIo extends Io {
  stdout: string[];
  stderr: string[];
  /** Everything written to stdout, joined — what the user would see. */
  text(): string;
  errText(): string;
}

export interface FakeIoOptions {
  isTty?: boolean;
  columns?: number;
  env?: Record<string, string | undefined>;
  /** Frozen by default: a renderer that formats an age must not race the clock. */
  now?: Date;
}

export function fakeIo(opts: FakeIoOptions = {}): FakeIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const now = opts.now ?? new Date('2026-09-01T09:00:00.000Z');
  return {
    stdout,
    stderr,
    out: text => { stdout.push(text); },
    err: text => { stderr.push(text); },
    // Not a terminal unless a test says so, which is also the pipe case every CLI has to get right.
    isTty: opts.isTty ?? false,
    columns: opts.columns ?? 100,
    env: opts.env ?? {},
    now: () => now,
    text: () => stdout.join(''),
    errText: () => stderr.join(''),
  };
}
