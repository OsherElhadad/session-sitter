import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { MODE_RANK, handle, permissionShape, widenings } from '../../hooks/configChange';
import { DecisionRecord, readJsonl } from '../../audit/trail';
import { decisionsPath } from '../../hooks/paths';

let dir: string;
let settingsFile: string;
const saved = { ...process.env };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-config-'));
  process.env.SESSION_SITTER_DATA_DIR = dir;
  settingsFile = path.join(dir, 'settings.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  process.env = { ...saved };
});

const write = (settings: unknown): void =>
  fs.writeFileSync(settingsFile, JSON.stringify(settings), 'utf8');

const event = (source = 'project_settings', filePath?: string) => ({
  session_id: 'sess-1',
  cwd: '/tmp/repo',
  hook_event_name: 'ConfigChange',
  source,
  file_path: filePath ?? settingsFile,
});

const records = (): DecisionRecord[] => readJsonl<DecisionRecord>(decisionsPath());
const last = (): DecisionRecord => {
  const all = records();
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1];
};

/** Get past the "first observation" baseline with a known starting shape. */
const baseline = async (settings: unknown): Promise<void> => {
  write(settings);
  expect(await handle(event())).toEqual({});
};

const shape = (allow: string[] = [], deny: string[] = [], defaultMode: string | null = null) =>
  ({ allow, deny, defaultMode });

// --------------------------------------------------------------------------- the diff

describe('permissionShape', () => {
  it('lifts the three fields that decide what the agent may do', () => {
    expect(permissionShape({
      permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(curl:*)'], defaultMode: 'acceptEdits' },
      other: 'ignored',
    })).toEqual(shape(['Bash(ls:*)'], ['Bash(curl:*)'], 'acceptEdits'));
  });

  it('reads a file with no permissions block as an empty shape, not an error', () => {
    expect(permissionShape({})).toEqual(shape());
    expect(permissionShape(null)).toEqual(shape());
    expect(permissionShape('nonsense')).toEqual(shape());
  });

  it('drops non-string rule entries rather than trusting them', () => {
    expect(permissionShape({ permissions: { allow: ['Bash(ls:*)', 7, null] } }).allow)
      .toEqual(['Bash(ls:*)']);
  });
});

describe('widenings', () => {
  it('reports an added allow rule', () => {
    expect(widenings(shape([]), shape(['Bash(curl:*)'])))
      .toEqual(['permissions.allow gained "Bash(curl:*)"']);
  });

  it('reports a removed deny rule', () => {
    expect(widenings(shape([], ['Bash(curl:*)']), shape([], [])))
      .toEqual(['permissions.deny lost "Bash(curl:*)"']);
  });

  it('reports a defaultMode that moved up the permissiveness order', () => {
    expect(widenings(shape([], [], 'default'), shape([], [], 'bypassPermissions'))[0])
      .toContain('permissions.defaultMode widened from "default" to "bypassPermissions"');
  });

  it('treats an absent defaultMode as default, in both directions', () => {
    expect(widenings(shape(), shape([], [], 'dontAsk'))).toHaveLength(1);
    expect(widenings(shape([], [], 'dontAsk'), shape())).toEqual([]);
  });

  it('treats a mode it has never heard of as the widest thing it could be', () => {
    expect(MODE_RANK.somethingNew).toBeUndefined();
    expect(widenings(shape([], [], 'bypassPermissions'), shape([], [], 'somethingNew')))
      .toHaveLength(1);
  });

  it('ranks manual the same as default, because the docs call it an alias', () => {
    expect(widenings(shape([], [], 'default'), shape([], [], 'manual'))).toEqual([]);
    expect(widenings(shape([], [], 'manual'), shape([], [], 'default'))).toEqual([]);
  });

  it('reports nothing for a narrowing', () => {
    expect(widenings(
      shape(['Bash(curl:*)'], [], 'auto'),
      shape([], ['Bash(curl:*)'], 'plan'),
    )).toEqual([]);
  });

  it('reports nothing for a change that leaves permissions alone', () => {
    expect(widenings(shape(['Bash(ls:*)'], ['Bash(rm:*)']), shape(['Bash(ls:*)'], ['Bash(rm:*)'])))
      .toEqual([]);
  });

  it('reports every widening at once, so the record names all of them', () => {
    expect(widenings(
      shape([], ['Bash(curl:*)'], 'default'),
      shape(['Bash(rm:*)'], [], 'bypassPermissions'),
    )).toHaveLength(3);
  });
});

// --------------------------------------------------------------------------- the hook

describe('handle — blocking a widening', () => {
  it('blocks an added allow rule and names it in the reason and the record', async () => {
    await baseline({ permissions: { allow: [], deny: ['Bash(curl:*)'] } });
    write({ permissions: { allow: ['Bash(curl:*)'], deny: ['Bash(curl:*)'] } });

    const output = await handle(event());
    expect(output.decision).toBe('block');
    expect(output.reason).toContain('Bash(curl:*)');
    expect(last()).toMatchObject({
      tool: 'ConfigChange',
      decision: 'deny',
      light: 'red',
      clause: 'built-in §config-guard',
      actor: 'deterministic',
    });
    expect(last().note).toContain('permissions.allow gained "Bash(curl:*)"');
  });

  it('blocks a removed deny rule', async () => {
    await baseline({ permissions: { deny: ['Bash(rm:*)'] } });
    write({ permissions: { deny: [] } });
    expect((await handle(event())).decision).toBe('block');
    expect(last().note).toContain('permissions.deny lost "Bash(rm:*)"');
  });

  it('blocks a defaultMode escalation', async () => {
    await baseline({ permissions: { defaultMode: 'default' } });
    write({ permissions: { defaultMode: 'bypassPermissions' } });
    expect((await handle(event())).decision).toBe('block');
    expect(last().note).toContain('defaultMode widened');
  });

  it('blocks the same widening again, because a blocked change is still on disk', async () => {
    await baseline({ permissions: { allow: [] } });
    write({ permissions: { allow: ['Bash(curl:*)'] } });
    expect((await handle(event())).decision).toBe('block');
    // The snapshot was deliberately not advanced, so the file is still measured against the last
    // shape that was actually accepted.
    expect((await handle(event())).decision).toBe('block');
  });
});

describe('handle — letting a change through', () => {
  it('allows a narrowing and records it', async () => {
    await baseline({ permissions: { allow: ['Bash(curl:*)'], defaultMode: 'auto' } });
    write({ permissions: { allow: [], deny: ['Bash(curl:*)'], defaultMode: 'plan' } });
    expect(await handle(event())).toEqual({});
    expect(last()).toMatchObject({ decision: 'allow', light: 'green' });
    expect(last().note).toContain('without widening');
  });

  it('allows the first change to a file, and says why, because there is nothing to compare', async () => {
    write({ permissions: { allow: ['Bash(anything:*)'] } });
    expect(await handle(event())).toEqual({});
    expect(last().note).toContain('first observation');
  });

  it('advances the baseline on a change it allowed, so the next diff is against the new shape',
    async () => {
      await baseline({ permissions: { allow: ['Bash(ls:*)'] } });
      write({ permissions: { allow: [] } });                       // narrowing, accepted
      expect(await handle(event())).toEqual({});
      write({ permissions: { allow: ['Bash(ls:*)'] } });            // now a widening again
      expect((await handle(event())).decision).toBe('block');
    });

  it('allows a change to a file it cannot read, rather than blocking on a guess', async () => {
    await baseline({ permissions: {} });
    fs.rmSync(settingsFile);
    expect(await handle(event())).toEqual({});
    expect(last().note).toContain('could not be read');
  });

  it('records a change to a source that carries no permissions at all', async () => {
    expect(await handle(event('skills', '/tmp/repo/.claude/skills/x/SKILL.md'))).toEqual({});
    expect(last()).toMatchObject({ decision: 'allow' });
    expect(last().note).toContain('no permissions block');
  });

  it('records an event with no file_path instead of throwing', async () => {
    expect(await handle({ ...event(), file_path: undefined })).toEqual({});
    expect(last().note).toContain('no permissions block');
  });
});

describe('handle — the documented limits', () => {
  // "any blocking decision is ignored. This ensures enterprise-managed settings always take effect."
  it('never blocks managed policy settings, however wide they are', async () => {
    write({ permissions: { allow: ['Bash'], defaultMode: 'bypassPermissions' } });
    const output = await handle(event('policy_settings'));
    expect(output).toEqual({});
    expect(last()).toMatchObject({ decision: 'allow' });
    expect(last().note).toContain('unblockable');
  });

  it('blocks a settings file it read but could not parse', async () => {
    await baseline({ permissions: {} });
    fs.writeFileSync(settingsFile, '{ "permissions": { "allow": [ }}}', 'utf8');
    const output = await handle(event());
    expect(output.decision).toBe('block');
    expect(last().note).toContain('not parseable JSON');
  });
});

describe('handle — each settings source', () => {
  it('adjudicates user, project and local settings independently', async () => {
    for (const source of ['user_settings', 'project_settings', 'local_settings']) {
      const file = path.join(dir, `${source}.json`);
      fs.writeFileSync(file, JSON.stringify({ permissions: { allow: [] } }), 'utf8');
      expect(await handle(event(source, file))).toEqual({});
      fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash'] } }), 'utf8');
      expect((await handle(event(source, file))).decision, source).toBe('block');
    }
  });
});
