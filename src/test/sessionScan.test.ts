import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { defaultStorePaths, liveSessionPids, vscodeUserDir, type ProcessProbe } from '../sessionScan';

// The rest of `sessionScan` is exercised through SessionManager.test.ts, which drives the same
// functions the panel calls. Only the store-path defaults are new here, and they are the one
// thing both front ends must agree on — the CLI and the extension would otherwise read different
// directories and disagree about which sessions exist.
describe('defaultStorePaths', () => {
  it('points every source at the agent that owns it', () => {
    const paths = defaultStorePaths('/home/u');
    expect(paths.projectsDir).toBe(path.join('/home/u', '.claude', 'projects'));
    expect(paths.bobDbPath).toBe(path.join('/home/u', '.bob', 'db', 'bob.db'));
    expect(paths.codexSessionsDir).toBe(path.join('/home/u', '.codex', 'sessions'));
    expect(paths.codexIndexPath).toBe(path.join('/home/u', '.codex', 'session_index.jsonl'));
  });

  it('derives the Chat directory from the platform rule, not a second copy of it', () => {
    expect(defaultStorePaths('/home/u').vscodeUserDir).toBe(vscodeUserDir('/home/u'));
  });
});

describe('liveSessionPids', () => {
  // A dead PID is a dead session on every platform; nothing below should reach the start-time check.
  const dead: ProcessProbe = {
    signal: () => { throw new Error('ESRCH'); },
    procStat: () => { throw new Error('unreachable'); },
    psStart: () => { throw new Error('unreachable'); },
  };
  // Linux keeps the start time in jiffies in field 21 of /proc/<pid>/stat — far enough along the
  // line that the fixture is easier to build by index than to write out.
  const linuxStat = (jiffies: string) => {
    const fields = ['42', '(node)', 'S', ...Array(18).fill('0')];
    fields[21] = jiffies;
    return `${fields.join(' ')} 100 200`;
  };
  // `ps` prints local time, so a fixture for it is derived from the UTC instant Claude recorded
  // rather than written out — otherwise the test would only pass in one time zone.
  const psRenderingOf = (procStart: string) => `${new Date(`${procStart} UTC`).toString()}    `;
  const noProc = { signal: () => {}, procStat: () => { throw new Error('ENOENT'); } };

  it('keeps the Linux /proc start-time comparison', async () => {
    const probe = (jiffies: string): ProcessProbe => ({
      signal: () => {},
      procStat: () => linuxStat(jiffies),
      psStart: () => { throw new Error('ps must not be consulted on Linux'); },
    });
    const one = [{ pid: 42, procStart: 993_311 }];
    expect(await liveSessionPids(one, 'linux', probe('993311'))).toEqual(new Set([42]));
    expect(await liveSessionPids(one, 'linux', probe('884422'))).toEqual(new Set());
    expect(await liveSessionPids(one, 'linux', dead)).toEqual(new Set());
  });

  it('treats an unreadable /proc on Linux as dead rather than guessing', async () => {
    expect(await liveSessionPids([{ pid: 42, procStart: 993_311 }], 'linux', {
      ...noProc,
      psStart: () => { throw new Error('unreachable'); },
    })).toEqual(new Set());
  });

  it('accepts a macOS session whose ps start-time matches the recorded one', async () => {
    const procStart = 'Mon Aug 31 10:04:57 2026';
    // Claude records procStart in UTC while `ps` prints the local zone, so the two differ by the
    // machine's offset even for one and the same process.
    expect(await liveSessionPids([{ pid: 1263, procStart }], 'darwin', {
      ...noProc, psStart: async () => new Map([[1263, psRenderingOf(procStart)]]),
    })).toEqual(new Set([1263]));
    // And a host whose two clocks agree — the strings identical — must still come out alive.
    expect(await liveSessionPids([{ pid: 1263, procStart }], 'darwin', {
      ...noProc, psStart: async () => new Map([[1263, procStart]]),
    })).toEqual(new Set([1263]));
  });

  it('rejects a recycled macOS PID whose ps start-time disagrees', async () => {
    expect(await liveSessionPids([{ pid: 1263, procStart: 'Mon Aug 31 10:04:57 2026' }], 'darwin', {
      ...noProc,
      psStart: async () => new Map([[1263, psRenderingOf('Tue Sep  1 03:45:23 2026')]]),
    })).toEqual(new Set());
  });

  it('asks ps about every candidate at once, and only about the live ones', async () => {
    const asked: number[][] = [];
    const born = 'Mon Aug 31 10:04:57 2026';
    const alive = await liveSessionPids(
      [
        { pid: 11, procStart: born },
        { pid: 22, procStart: 'Tue Sep  1 03:45:23 2026' },  // recycled — ps disagrees
        { pid: 33, procStart: born },
        { pid: 44, procStart: born },                        // already gone
      ],
      'darwin',
      {
        signal: (pid) => { if (pid === 44) { throw new Error('ESRCH'); } },
        procStat: () => { throw new Error('ENOENT'); },
        psStart: async (pids) => {
          asked.push(pids);
          return new Map(pids.map(pid => [pid, psRenderingOf(born)]));
        },
      },
    );
    expect(asked).toEqual([[11, 22, 33]]);
    expect(alive).toEqual(new Set([11, 33]));
  });

  it('trusts the signal alone when ps cannot be used', async () => {
    const procStart = 'Mon Aug 31 10:04:57 2026';
    const candidates = [{ pid: 1263, procStart }];
    const noPs: ProcessProbe = {
      ...noProc,
      psStart: () => Promise.reject(new Error('spawn ps ENOENT')),
    };
    expect(await liveSessionPids(candidates, 'darwin', noPs)).toEqual(new Set([1263]));
    // Same fallback when `ps` does run but says nothing usable about the PID.
    expect(await liveSessionPids(candidates, 'darwin', {
      ...noPs, psStart: async () => new Map([[1263, 'no date here']]),
    })).toEqual(new Set([1263]));
    expect(await liveSessionPids(candidates, 'darwin', {
      ...noPs, psStart: async () => new Map(),
    })).toEqual(new Set([1263]));
    // The fallback is on the start-time cross-check only — a dead PID is still dead.
    expect(await liveSessionPids(candidates, 'darwin', dead)).toEqual(new Set());
  });

  it('trusts the signal alone when the session file has no recorded procStart', async () => {
    // No recorded start time is no recycled-PID evidence either way, so a running PID must not be
    // filtered out just because ps has something usable to compare it against.
    const candidates = [{ pid: 1263, procStart: undefined }];
    expect(await liveSessionPids(candidates, 'darwin', {
      ...noProc,
      psStart: async () => new Map([[1263, 'Mon Aug 31 10:04:57 2026    ']]),
    })).toEqual(new Set([1263]));
  });
});
