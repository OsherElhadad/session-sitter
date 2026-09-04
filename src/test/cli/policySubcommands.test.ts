import { describe, expect, it } from 'vitest';
import { run } from '../../cli/policy';
import type { Io } from '../../cli/render';

// `session-sitter policy` exposed only `check` and `explain`, so the two commands that *write* the
// versioned artifact and that measure a clause's worth — `compile` and `ablate` — were reachable
// only by knowing an internal path (`node .../lib/policy/cli.js compile`). That path's own usage text
// prints "session-sitter policy", so the one place a terminal user is told how to invoke it named an
// entry point that rejected the subcommand.
//
// What that cost the terminal path concretely: no `compile` means no published artifact, so every
// decision record is stamped `rev: null`, `policy explain --rev` can never resolve a citation, and
// the prompt-cache-stability constraint (knowledge as a versioned artifact) is unreachable without
// an IDE. So this is a routing test, and it asserts the forwarding actually happens rather than
// grepping the help text — a subcommand can be documented and still be rejected.

function captureIo(): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout, stderr,
    out: (t: string) => { stdout.push(t); },
    err: (t: string) => { stderr.push(t); },
    isTty: false,
    columns: 80,
    env: {},
    now: () => new Date("2026-09-04T17:00:00Z"),
  };
}

describe('session-sitter policy compile', () => {
  it('forwards to the compile implementation instead of rejecting the subcommand', async () => {
    const io = captureIo();
    let seen: string[] | null = null;
    const code = await run(['compile', '--dry-run', '--corpus', '/nonexistent'], io, {
      compile: async (argv: string[]) => { seen = [...argv]; return 7; },
    });
    // The exit code is the implementation's, passed through unchanged — not remapped by the wrapper.
    expect(code).toBe(7);
    // Forwarded UNPARSED, the same contract `explain` already has: the one implementation owns the
    // flags, so the wrapper cannot drift into a second, disagreeing parser.
    expect(seen).toEqual(['--dry-run', '--corpus', '/nonexistent']);
  });
});

describe('session-sitter policy ablate', () => {
  it('forwards to the ablate implementation instead of rejecting the subcommand', async () => {
    const io = captureIo();
    let seen: string[] | null = null;
    const code = await run(['ablate', '--decisions', '200'], io, {
      ablate: async (argv: string[]) => { seen = [...argv]; return 40; },
    });
    expect(code).toBe(40);
    expect(seen).toEqual(['--decisions', '200']);
  });
});

describe('an unknown policy subcommand', () => {
  it('still fails, and names every subcommand that exists', async () => {
    const io = captureIo();
    await expect(run(['lint'], io, {})).rejects.toThrow(/lint/);
    // The old message named exactly two, which is how `compile` stayed invisible. Whatever the
    // wording, every subcommand the dispatcher accepts has to appear in it.
    await expect(run(['lint'], io, {})).rejects.toThrow(/check/);
    await expect(run(['lint'], io, {})).rejects.toThrow(/explain/);
    await expect(run(['lint'], io, {})).rejects.toThrow(/compile/);
    await expect(run(['lint'], io, {})).rejects.toThrow(/ablate/);
  });
});

describe('the policy help text', () => {
  it('lists compile and ablate, so the terminal path is discoverable at all', async () => {
    const io = captureIo();
    expect(await run(['--help'], io, {})).toBe(0);
    const help = io.stdout.join('\n');
    expect(help).toMatch(/policy compile/);
    expect(help).toMatch(/policy ablate/);
  });
});
