/**
 * Knowledge routing and BDI parsing: the registry tables, the documented fallbacks, tier
 * precedence, and reading the three tier files from a local checkout.
 *
 * Ports `supervisor/tests/test_knowledge.py` and `test_tiers.py`'s routing half.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  EMPTY_REGISTRY,
  KnowledgeError,
  entryPrecedence,
  fetchBdiFiles,
  isEmptyRegistry,
  loadKnowledge,
  parseBottomLine,
  parseMarkdownTables,
  parseRegistry,
  ranked,
  resolveTriple,
  tierPath,
} from '../../supervisor/knowledge';
import { PROJECT, TEAM, USER, bottomLine, localFetch, makeKnowledgeRepo, makeTmpDir } from './fixtures';

let tmp: string;
beforeEach(() => { tmp = makeTmpDir('knowledge-test-'); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const REGISTRY = `# Knowledge registry

## Teams

| Team slug | File |
|---|---|
| \`platform\` | [\`data/knowledge/teams/platform/bottom-line.md\`](data/knowledge/teams/platform/bottom-line.md) |
| \`data-eng\` | [\`data/knowledge/teams/data-eng/bottom-line.md\`](data/knowledge/teams/data-eng/bottom-line.md) |

## Projects

| Project slug | File | Team | Users on this project |
|---|---|---|---|
| \`demo-project\` | [\`f\`](f) | \`platform\` | alice, bob |
| \`warehouse\` | [\`f\`](f) | \`data-eng\` | bob |

## Users

| User slug | File | Team | Projects |
|---|---|---|---|
| \`alice\` | [\`f\`](f) | \`platform\` | demo-project |
| \`bob\` | [\`f\`](f) | \`platform\` | demo-project, warehouse |
| \`carol\` | [\`f\`](f) | \`data-eng\` |  |
`;

describe('parseMarkdownTables', () => {
  it('splits runs of table lines and drops separator rows', () => {
    const tables = parseMarkdownTables('| a | b |\n|---|---|\n| 1 | 2 |\n\ntext\n\n| c |\n|---|\n| 3 |');
    expect(tables).toEqual([[['a', 'b'], ['1', '2']], [['c'], ['3']]]);
  });

  it('returns nothing for text with no tables', () => {
    expect(parseMarkdownTables('just prose\n')).toEqual([]);
  });
});

describe('parseRegistry', () => {
  it('reads teams, projects and users, unwrapping links and backticks', () => {
    const r = parseRegistry(REGISTRY);
    expect([...r.teams].sort()).toEqual(['data-eng', 'platform']);
    expect(r.projects['demo-project']).toEqual({ team: 'platform', users: ['alice', 'bob'] });
    expect(r.users.bob).toEqual({ team: 'platform', projects: ['demo-project', 'warehouse'] });
    expect(r.users.carol.projects).toEqual([]);
  });

  it('yields an empty registry for a file with no tables', () => {
    expect(isEmptyRegistry(parseRegistry('# nothing here'))).toBe(true);
    expect(isEmptyRegistry(parseRegistry(REGISTRY))).toBe(false);
  });
});

describe('resolveTriple with a registry', () => {
  const r = parseRegistry(REGISTRY);

  it('passes a fully-specified, known triple through', () => {
    expect(resolveTriple(r, 'alice', 'demo-project', 'platform'))
      .toEqual(['alice', 'demo-project', 'platform']);
  });

  it('infers the project when the user is on exactly one', () => {
    expect(resolveTriple(r, 'alice', null, null)).toEqual(['alice', 'demo-project', 'platform']);
  });

  it('refuses to guess when the user is on several projects', () => {
    expect(() => resolveTriple(r, 'bob', null, null))
      .toThrow(/is on multiple projects/);
  });

  it('errors when the user has no project at all', () => {
    expect(() => resolveTriple(r, 'carol', null, null)).toThrow(/has no projects/);
  });

  it('infers the team from the user row', () => {
    expect(resolveTriple(r, 'bob', 'warehouse', null)[2]).toBe('platform');
  });

  it('never substitutes a default for an unknown slug', () => {
    expect(() => resolveTriple(r, 'nobody', 'demo-project', 'platform'))
      .toThrow(/unknown user slug/);
    expect(() => resolveTriple(r, 'alice', 'nope', 'platform')).toThrow(/unknown project slug/);
    expect(() => resolveTriple(r, 'alice', 'demo-project', 'nope')).toThrow(/unknown team slug/);
  });

  it('requires a user', () => {
    expect(() => resolveTriple(r, null, 'demo-project', 'platform'))
      .toThrow(/user is required/);
    expect(() => resolveTriple(EMPTY_REGISTRY, '', null, null)).toThrow(KnowledgeError);
  });
});

describe('resolveTriple without a registry', () => {
  it('takes the triple as given', () => {
    expect(resolveTriple(EMPTY_REGISTRY, 'anyone', 'anything', 'anywhere'))
      .toEqual(['anyone', 'anything', 'anywhere']);
  });

  it('resolves a missing project or team to empty rather than failing', () => {
    // Nothing to infer from and nothing to validate against: substituting no slug is honest,
    // and the corresponding tier is simply reported missing.
    expect(resolveTriple(EMPTY_REGISTRY, 'alice', null, null)).toEqual(['alice', '', '']);
  });
});

describe('parseBottomLine', () => {
  it('reads each BDI entry with its metadata and body', () => {
    const entries = parseBottomLine(bottomLine('team', 'team-b1', 'orange'), 'team', 'f.md');
    expect(entries.map(e => e.kind)).toEqual(['belief', 'intention']);
    const belief = entries[0];
    expect(belief.title).toBe('Pushes to main go through a reviewed PR');
    expect(belief.id).toBe('team-b1');
    expect(belief.level).toBe('orange');
    expect(belief.confidence).toBe('high');
    expect(belief.tags).toEqual(['git', 'review']);
    expect(belief.sourceFile).toBe('f.md');
    expect(belief.text).toContain('bypass review');
    // The metadata table header must not leak into the entry body.
    expect(belief.text).not.toContain('| Field |');
  });

  it('ignores content outside entries and tolerates an empty file', () => {
    expect(parseBottomLine('# Title\n\nsome prose\n', 'user')).toEqual([]);
    expect(parseBottomLine('', 'user')).toEqual([]);
  });

  it('stops an entry at a section boundary', () => {
    const entries = parseBottomLine(
      '### Belief: A\n\nbody a\n\n## Another section\n\nnot part of A\n', 'team');
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('body a');
  });

  it('is case-insensitive about the entry kind', () => {
    expect(parseBottomLine('### belief: lowercase heading\n\nx\n', 'team')[0].kind).toBe('belief');
  });
});

describe('tier precedence', () => {
  it('orders user above project above team', () => {
    const entries = [
      ...parseBottomLine(bottomLine('team', 't'), 'team'),
      ...parseBottomLine(bottomLine('user', 'u'), 'user'),
      ...parseBottomLine(bottomLine('project', 'p'), 'project'),
    ];
    expect(entries.map(entryPrecedence)).toContain(2);
    const order = ranked({
      user: USER, project: PROJECT, team: TEAM, entries, loadedFiles: [], missingFiles: [],
    }).map(e => e.tier);
    expect(order[0]).toBe('user');
    expect(order[order.length - 1]).toBe('team');
  });

  it('maps each tier to its in-repo path', () => {
    const slugs = { user: 'alice', project: 'demo', team: 'platform' };
    expect(tierPath('team', slugs)).toBe('data/knowledge/teams/platform/bottom-line.md');
    expect(tierPath('project', slugs)).toBe('data/knowledge/projects/demo/bottom-line.md');
    expect(tierPath('user', slugs)).toBe('data/knowledge/users/alice/bottom-line.md');
  });
});

describe('fetchBdiFiles from a local checkout', () => {
  it('reads all three tier files with their in-repo paths', async () => {
    const root = makeKnowledgeRepo(path.join(tmp, 'repo'));
    const files = await fetchBdiFiles(USER, PROJECT, TEAM, { localRepo: root });

    for (const tier of ['team', 'project', 'user'] as const) {
      expect(files[tier].exists).toBe(true);
      expect(files[tier].content).toContain('Bottom line');
      expect(files[tier].path_in_repo).toContain(`data/knowledge/${tier}s/`);
    }
  });

  it('reports a missing tier file as absent, not an error', async () => {
    const root = makeKnowledgeRepo(path.join(tmp, 'repo'));
    const files = await fetchBdiFiles(USER, 'no-such-project', TEAM, { localRepo: root });
    expect(files.project.exists).toBe(false);
    expect(files.project.content).toBeNull();
    expect(files.user.exists).toBe(true);
  });

  it('reports an unconfigured tier without touching the filesystem', async () => {
    const root = makeKnowledgeRepo(path.join(tmp, 'repo'));
    const files = await fetchBdiFiles(USER, '', '', { localRepo: root });
    expect(files.project.exists).toBe(false);
    expect(files.project.path_in_repo).toContain('not configured');
  });

  it('fails loud on a missing local checkout', async () => {
    await expect(fetchBdiFiles(USER, PROJECT, TEAM, { localRepo: path.join(tmp, 'nope') }))
      .rejects.toThrow(/local knowledge repo dir not found/);
  });

  it('fails loud when no source is configured at all', async () => {
    await expect(fetchBdiFiles(USER, PROJECT, TEAM, {}))
      .rejects.toThrow(/no knowledge source configured/);
  });
});

describe('loadKnowledge', () => {
  it('loads every tier and records which files were found', async () => {
    const root = makeKnowledgeRepo(path.join(tmp, 'repo'));
    const bundle = await loadKnowledge({
      user: USER, project: PROJECT, team: TEAM, localRepo: root,
    });

    expect([bundle.user, bundle.project, bundle.team]).toEqual([USER, PROJECT, TEAM]);
    expect(bundle.loadedFiles).toHaveLength(3);
    expect(bundle.missingFiles).toHaveLength(0);
    expect(bundle.entries).toHaveLength(6); // two entries per tier
    expect(new Set(bundle.entries.map(e => e.tier))).toEqual(new Set(['team', 'project', 'user']));
  });

  it('skips a missing tier and still loads the rest', async () => {
    const root = makeKnowledgeRepo(path.join(tmp, 'repo'));
    fs.rmSync(path.join(root, 'data/knowledge/projects'), { recursive: true });
    const bundle = await loadKnowledge({
      user: USER, project: PROJECT, team: TEAM, localRepo: root,
    });

    expect(bundle.loadedFiles).toHaveLength(2);
    expect(bundle.missingFiles).toHaveLength(1);
    expect(bundle.entries.some(e => e.tier === 'project')).toBe(false);
  });

  it('validates the triple against a configured registry', async () => {
    const registryPath = path.join(tmp, 'REGISTRY.md');
    fs.writeFileSync(registryPath, REGISTRY, 'utf8');
    const root = makeKnowledgeRepo(path.join(tmp, 'repo'));

    // The project is inferred from the registry because alice is on exactly one.
    const bundle = await loadKnowledge({ user: 'alice', registryPath, localRepo: root });
    expect(bundle.project).toBe('demo-project');
    expect(bundle.team).toBe('platform');

    await expect(loadKnowledge({ user: 'nobody', registryPath, localRepo: root }))
      .rejects.toThrow(/unknown user slug/);
  });

  it('fails loud when the configured registry is missing', async () => {
    await expect(loadKnowledge({
      user: USER, project: PROJECT, team: TEAM, registryPath: path.join(tmp, 'nope.md'),
    })).rejects.toThrow(/knowledge registry not found/);
  });

  it('accepts an injected fetch, so no git or filesystem work is needed', async () => {
    const root = makeKnowledgeRepo(path.join(tmp, 'repo'));
    const bundle = await loadKnowledge({
      user: USER, project: PROJECT, team: TEAM, fetch: localFetch(root),
    });
    expect(bundle.entries).toHaveLength(6);
  });
});
