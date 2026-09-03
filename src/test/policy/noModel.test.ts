/**
 * §12.27 and §12.25 — the two invariants that are about what the miner **cannot** do.
 *
 *  - **Zero model calls.** A full `learn` run with `child_process`, `http`, `https`, `net` and global
 *    `fetch` all replaced by something that throws. If any code path in the pipeline reaches a model,
 *    a network, or a subprocess, this fails here rather than on somebody's laptop with an API bill.
 *    `line.model.calls === 0` alone would be a field asserting about itself; the mocks are what make
 *    the claim falsifiable.
 *  - **`memory/` is never opened.** Claude Code's auto memory writes notes into
 *    `~/.claude/projects/<repo>/memory/` during the very sessions this pipeline mines. Reading them
 *    would make our support counts a function of another system's unversioned output, and they are
 *    private notes in a directory the developer never offered us. The default input does not touch
 *    them, and this test is what keeps that true: `fs` is wrapped rather than replaced, so every real
 *    read still happens and every path is recorded.
 *
 * These live in their own file because `vi.mock` is hoisted per module graph: a file that mocks `fs`
 * cannot also contain tests that want the plain one.
 *
 * Every fixture is invented. No real path, no real project name.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DecisionRecord } from '../../audit/trail';

/** Every path handed to a synchronous read, in call order. Populated by the `fs` wrapper below. */
const opened: string[] = [];

vi.mock('child_process', () => {
  const boom = (): never => { throw new Error('the miner spawned a process'); };
  return {
    spawn: boom, spawnSync: boom, exec: boom, execSync: boom, execFile: boom, execFileSync: boom,
    fork: boom,
  };
});
vi.mock('http', () => ({ request: () => { throw new Error('the miner made an http request'); } }));
vi.mock('https', () => ({ request: () => { throw new Error('the miner made an https request'); } }));
vi.mock('net', () => ({ connect: () => { throw new Error('the miner opened a socket'); } }));

vi.mock('fs', async importOriginal => {
  const real = await importOriginal<typeof import('fs')>();
  const watch = <K extends 'readFileSync' | 'readdirSync' | 'openSync' | 'statSync'>(name: K) => {
    const original = real[name] as (...args: unknown[]) => unknown;
    return (...args: unknown[]) => {
      opened.push(String(args[0]));
      return original(...args);
    };
  };
  // Delegating rather than faking: the run below does real work on a real scratch directory, so the
  // assertion is about a real run's real syscalls and not about a fixture's shape.
  return {
    ...real,
    default: real,
    readFileSync: watch('readFileSync'),
    readdirSync: watch('readdirSync'),
    openSync: watch('openSync'),
    statSync: watch('statSync'),
  };
});

describe('§12.27 and §12.25 — what the miner cannot do', () => {
  it('completes a full run with no model, no network and no subprocess', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const { parsePractices } = await import('../../policy/practices');
    const { propose } = await import('../../policy/pipeline');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-nomodel-'));
    const corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-nomodel-corpus-'));
    const record = (
      command: string, over: Partial<DecisionRecord> = {},
    ): DecisionRecord => ({
      ts: '2026-08-25T09:00:00.000Z',
      sessionId: 's-A',
      cwd: '/w/api',
      tool: 'Bash',
      inputSummary: command,
      light: 'green',
      decision: 'allow',
      clause: null,
      actor: 'model',
      latencyMs: 2000,
      rewritten: false,
      rev: 'a91f3c2',
      call: { tool_name: 'Bash', input: { command } },
      ...over,
    });
    const window = [
      record('pnpm test --filter core', {
        ts: '2026-08-25T09:12:03.000Z', decision: 'deny', light: null, actor: 'timeout',
        latencyMs: 8014,
      }),
      record('pnpm test --filter core', { ts: '2026-08-25T09:14:40.000Z' }),
      record('pnpm test --filter cli', { sessionId: 's-B', ts: '2026-08-27T14:02:55.000Z' }),
      record('pnpm test --filter cli', { sessionId: 's-B', ts: '2026-08-27T14:31:08.000Z' }),
      record('pnpm test', { sessionId: 's-C', ts: '2026-09-01T10:20:11.000Z' }),
      record('pnpm test --watch', { sessionId: 's-C', ts: '2026-09-01T10:41:02.000Z' }),
    ];
    fs.writeFileSync(path.join(dir, 'decisions.jsonl'),
      window.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    vi.stubGlobal('fetch', () => { throw new Error('the miner called fetch'); });
    opened.length = 0;

    const { line, written } = propose({
      settings: { user: 'devon', project: null, team: null } as never,
      corpusRoot: corpus,
      corpus: parsePractices(
        '### Intention: Never force-push a shared branch\n\n| Field | Value |\n|---|---|\n'
        + '| id | git-force |\n| level | red |\n\nMatch: /git\\s+push\\b.*--force\\b/\n\n'
        + 'Rewriting history other people build on destroys their work, and there is no undo.\n',
        'team', 'bottom-line.md'),
      rev: 'a91f3c2',
      env: { SESSION_SITTER_DATA_DIR: dir } as NodeJS.ProcessEnv,
      now: new Date('2026-09-03T18:41:07.221Z'),
    });

    // It did real work — a proposal, not an early bail that trivially calls nothing.
    expect(line.error).toBeNull();
    expect(line.exitReason).toBe('ok');
    expect(written).toHaveLength(1);
    expect(line.model.calls).toBe(0);

    // §12.25 — and it never went near another learning system's notes.
    expect(opened.filter(p => /(^|[\\/])memory([\\/]|$)/.test(p))).toEqual([]);
    expect(opened.filter(p => p.includes('.claude/projects'))).toEqual([]);
    // Nor anywhere outside the two directories it was given.
    const strays = opened.filter(p =>
      p.startsWith('/') && !p.startsWith(dir) && !p.startsWith(corpus)
      && !p.startsWith('/private' + dir) && !p.startsWith('/private' + corpus));
    expect(strays).toEqual([]);
  });
});
