import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Decision } from '../../cli/audit';
import {
  PRACTICES_CANDIDATES, findPracticesFile, loadPolicyModule, replay, run,
  type ParsedPolicy, type PolicyModule,
} from '../../cli/policy';
import { fakeIo } from './fakeIo';

const NOW = new Date('2026-09-01T09:00:00.000Z');

let repo: string;

beforeEach(async () => {
  repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ss-policy-'));
});

afterEach(async () => {
  await fs.promises.rm(repo, { recursive: true, force: true });
});

function decision(over: Partial<Decision> = {}): Decision {
  return {
    from: 'audit',
    id: 'x',
    at: new Date('2026-08-31T21:00:00Z'),
    sessionId: 's-1',
    sessionName: 's-1',
    host: 'h',
    agent: 'claude',
    tool: 'Bash',
    light: 'green',
    outcome: 'allow',
    actor: 'rule',
    clauseId: '',
    clauseText: '',
    rewritten: false,
    reason: '',
    ask: '',
    input: { command: 'git push --force' },
    latencyMs: null,
    costUsd: null,
    ...over,
  };
}

/** A stand-in for `src/policy/`, which is built separately. */
function stubModule(over: Partial<PolicyModule> = {}): PolicyModule {
  return {
    parsePractices: (_source, filePath): ParsedPolicy => ({
      path: filePath,
      clauses: [
        { id: 'practices§1', text: 'read-only tools never need a prompt', light: 'green', line: 3 },
        { id: 'practices§4', text: 'never force-push to a shared branch', light: 'red', line: 9 },
      ],
      issues: [],
    }),
    ...over,
  };
}

describe('findPracticesFile', () => {
  it('tries the conventional locations in order', async () => {
    await fs.promises.mkdir(path.join(repo, 'docs'), { recursive: true });
    await fs.promises.writeFile(path.join(repo, 'docs', 'PRACTICES.md'), '# rules', 'utf8');
    expect(findPracticesFile(repo)).toBe(path.join(repo, 'docs', 'PRACTICES.md'));

    await fs.promises.writeFile(path.join(repo, 'PRACTICES.md'), '# rules', 'utf8');
    expect(findPracticesFile(repo)).toBe(path.join(repo, 'PRACTICES.md'));
  });

  it('finds nothing rather than guessing when no candidate exists', () => {
    expect(findPracticesFile(repo)).toBeUndefined();
    expect(PRACTICES_CANDIDATES.length).toBeGreaterThan(0);
  });
});

describe('loadPolicyModule', () => {
  it('reports why it could not load, rather than throwing past the caller', () => {
    const result = loadPolicyModule('../definitely-not-a-module');
    expect(typeof result).toBe('string');
    expect(result).toMatch(/practices parser is not installed/);
  });

  it('rejects a module that does not export the parser this command needs', () => {
    // `os` loads fine and exports no parser — the shape check is what catches a wrong module.
    expect(loadPolicyModule('os')).toMatch(/does not export parsePractices/);
  });
});

describe('replay', () => {
  const policy: ParsedPolicy = { path: 'PRACTICES.md', clauses: [], issues: [] };

  it('reports only the decisions whose outcome would change', () => {
    const result = replay(policy, [
      decision({ id: 'same', outcome: 'allow' }),
      decision({ id: 'changed', outcome: 'allow' }),
    ], (_p, call) => (call.sessionId === 's-1' && _p === policy
      ? { outcome: 'allow', clauseId: 'practices§1' }
      : { outcome: 'deny', clauseId: '' }));
    expect(result.considered).toBe(2);
    expect(result.changes).toEqual([]);
  });

  it('names what would change, and under which clause', () => {
    const result = replay(policy, [decision({ outcome: 'allow' })],
      () => ({ outcome: 'deny', clauseId: 'practices§4' }));
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ was: 'allow', now: 'deny', clauseId: 'practices§4' });
  });

  it('counts a decision with no recorded input as skipped, never as unchanged', () => {
    // A replay that quietly ignores half the trail reports a reassuring number about the wrong half.
    const result = replay(policy, [
      decision({ id: 'no-input', input: undefined }),
      decision({ id: 'no-tool', tool: '' }),
      decision({ id: 'usable' }),
    ], () => ({ outcome: 'deny', clauseId: '' }));
    expect(result.skipped).toBe(2);
    expect(result.considered).toBe(1);
    expect(result.changes).toHaveLength(1);
  });
});

describe('run', () => {
  async function practices(body = '# rules\n'): Promise<string> {
    const file = path.join(repo, 'PRACTICES.md');
    await fs.promises.writeFile(file, body, 'utf8');
    return file;
  }

  it('lists the clauses it found, with their citable ids', async () => {
    const file = await practices();
    const io = fakeIo({ now: NOW });
    expect(await run(['check', file], io, { load: () => stubModule(), cwd: repo })).toBe(0);
    expect(io.text()).toContain('practices§1');
    expect(io.text()).toContain('never force-push to a shared branch');
    expect(io.text()).toContain('2 clauses · 0 unparseable');
  });

  it('exits 1 and names the line when something will not parse', async () => {
    const file = await practices();
    const io = fakeIo({ now: NOW });
    const code = await run(['check', file], io, {
      cwd: repo,
      load: () => stubModule({
        parsePractices: (_s, p) => ({
          path: p,
          clauses: [],
          issues: [{ line: 12, message: 'no traffic light on this rule', text: '- do not do that' }],
        }),
      }),
    });
    expect(code).toBe(1);
    expect(io.text()).toContain('Could not parse');
    expect(io.text()).toContain(':12');
    expect(io.text()).toContain('no traffic light on this rule');
  });

  it('finds the practices file itself when none is named', async () => {
    await practices();
    const io = fakeIo({ now: NOW });
    expect(await run(['check'], io, { load: () => stubModule(), cwd: repo })).toBe(0);
  });

  it('says what it looked for when there is no practices file', async () => {
    const io = fakeIo({ now: NOW });
    await expect(run(['check'], io, { load: () => stubModule(), cwd: repo }))
      .rejects.toThrow(/no practices file found/);
  });

  it('exits 1, not 2, when the parser is not installed — bad tool, not bad arguments', async () => {
    const file = await practices();
    const io = fakeIo({ now: NOW });
    await expect(run(['check', file], io, { cwd: repo, load: () => 'not installed' }))
      .rejects.toMatchObject({ exitCode: 1 });
  });

  it('--replay reports which recorded decisions would change', async () => {
    const file = await practices();
    const io = fakeIo({ now: NOW });
    const code = await run(['check', file, '--replay', '2', '--state-dir', repo], io, {
      cwd: repo,
      load: () => stubModule({ evaluate: () => ({ outcome: 'deny', clauseId: 'practices§4' }) }),
      read: async () => [decision({ id: 'a' }), decision({ id: 'b' })],
    });
    expect(code).toBe(0);
    expect(io.text()).toContain('2 decisions re-decided · 2 would change');
    expect(io.text()).toContain('allow → deny');
  });

  it('--replay says so when the parser cannot decide, rather than reporting no changes', async () => {
    const file = await practices();
    const io = fakeIo({ now: NOW });
    await expect(run(['check', file, '--replay', '1'], io, {
      cwd: repo, load: () => stubModule(), read: async () => [decision()],
    })).rejects.toThrow(/exports no evaluate/);
  });

  it('rejects a --replay that is not a positive whole number', async () => {
    const file = await practices();
    const io = fakeIo({ now: NOW });
    for (const bad of ['0', '-3', '2.5']) {
      await expect(run(['check', file, '--replay', bad], io, {
        cwd: repo, load: () => stubModule({ evaluate: () => ({ outcome: 'allow', clauseId: '' }) }),
      })).rejects.toThrow(/positive whole number/);
    }
  });

  it('--json carries the clauses, the issues and the replay', async () => {
    const file = await practices();
    const io = fakeIo({ now: NOW });
    await run(['check', file, '--json'], io, { load: () => stubModule(), cwd: repo });
    const json = JSON.parse(io.text());
    expect(json.version).toBe(1);
    expect(json.ok).toBe(true);
    expect(json.clauses).toHaveLength(2);
    expect(json.issues).toEqual([]);
    // null, not an empty result: --replay was never asked for.
    expect(json.replay).toBeNull();
  });

  it('--json marks a file that did not parse as not ok', async () => {
    const file = await practices();
    const io = fakeIo({ now: NOW });
    const code = await run(['check', file, '--json'], io, {
      cwd: repo,
      load: () => stubModule({
        parsePractices: (_s, p) => ({ path: p, clauses: [], issues: [{ line: 0, message: 'empty file' }] }),
      }),
    });
    expect(code).toBe(1);
    expect(JSON.parse(io.text()).ok).toBe(false);
  });

  it('prints help, and exits 2 when no subcommand is given', async () => {
    const io = fakeIo({ now: NOW });
    expect(await run(['--help'], io, {})).toBe(0);
    expect(io.text()).toContain('session-sitter policy check');
    const bare = fakeIo({ now: NOW });
    expect(await run([], bare, {})).toBe(2);
  });

  it('rejects an unknown subcommand and a second path', async () => {
    const io = fakeIo({ now: NOW });
    await expect(run(['lint'], io, {})).rejects.toThrow(/unknown policy subcommand/);
    await expect(run(['check', 'a.md', 'b.md'], io, { load: () => stubModule(), cwd: repo }))
      .rejects.toThrow(/takes one path/);
  });

  it('reports an unreadable practices file as exit 1, not as a parse result', async () => {
    const io = fakeIo({ now: NOW });
    await expect(run(['check', path.join(repo, 'gone.md')], io, { load: () => stubModule(), cwd: repo }))
      .rejects.toMatchObject({ exitCode: 1 });
  });
});
