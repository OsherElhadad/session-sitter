/**
 * The directory lane — issue #83. Every invariant here answers a question the shell lane answered
 * the other way round, which is why it gets its own file rather than more cases in `propose.test.ts`.
 *
 * The three that are easiest to get wrong, and all three are structural:
 *
 *  - **A segment boundary is not a word boundary.** `infra/prod` must not match
 *    `infra/production-notes/`. The shell lane's `(?=[\s"\\])` says nothing about `/`, so the
 *    boundary is asserted against a compiled matcher over a real `haystackFor` string, never against
 *    the pattern text.
 *  - **Widening runs the other way.** A shorter prefix is a *wider* path rule, so the floor refuses
 *    shallow directories instead of shallow ones being the safe fallback. Asserted by calling `gate`,
 *    not by reading a constant.
 *  - **The written string is not the resolved file.** A symlinked path refuses the whole cluster, and
 *    the test builds a real symlink on disk rather than asserting on a string.
 *
 * Every fixture is invented. No real path, no real project name.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DecisionRecord } from '../../audit/trail';
import { haystackFor } from '../../hooks/session';
import type { PluginSettings } from '../../hooks/settings';
import { compileMatcher } from '../../policy/practices';
import { propose } from '../../policy/pipeline';
import { parseLearnedClause } from '../../supervisor/learnedClauses';
import { PATH_TOOLS, normalisedPath } from '../../policy/generalise';
import {
  PATH_FLOOR_SEGMENTS,
  canonicalPathSegment,
  clusterWindow,
  supportOf,
  tierFor,
} from '../../policy/mine';
import {
  commonPathLiteral,
  gate,
  pathMatcher,
  pathNeverWidenAxis,
  renderClause,
  symlinkEscape,
} from '../../policy/propose';

// --------------------------------------------------------------------------- fixtures

let seq = 0;

/** One `Write` record. `file_path` is passed exactly as written, absolute or relative. */
const write = (filePath: string, over: Partial<DecisionRecord> = {}): DecisionRecord => {
  seq += 1;
  return {
    ts: '2026-08-25T09:00:00.000Z',
    sessionId: `w-${seq}`,
    cwd: '/w/api',
    tool: 'Write',
    inputSummary: filePath,
    light: 'green',
    decision: 'allow',
    clause: null,
    actor: 'model',
    latencyMs: 2100,
    rewritten: false,
    rev: 'a91f3c2',
    call: { tool_name: 'Write', input: { file_path: filePath, content: 'x' } },
    ...over,
  };
};

/** Six allows over three sessions and three days under `infra/prod`, plus one fail-closed deny. */
const PROD_WINDOW: DecisionRecord[] = [
  write('/w/api/infra/prod/db.tf', {
    sessionId: 'p-A', ts: '2026-08-25T09:12:03.000Z', decision: 'deny', light: null,
    actor: 'timeout', latencyMs: 8014,
  }),
  write('/w/api/infra/prod/db.tf', { sessionId: 'p-A', ts: '2026-08-25T09:14:40.000Z' }),
  write('/w/api/infra/prod/net.tf', { sessionId: 'p-B', ts: '2026-08-27T14:02:55.000Z' }),
  write('/w/api/infra/prod/net.tf', { sessionId: 'p-B', ts: '2026-08-27T14:31:08.000Z' }),
  write('/w/api/infra/prod/iam/role.tf', { sessionId: 'p-C', ts: '2026-09-01T10:20:11.000Z' }),
  write('/w/api/infra/prod/iam/role.tf', { sessionId: 'p-C', ts: '2026-09-01T10:41:02.000Z' }),
];

/** The same record, with `/w/api` swapped for a real directory on disk. */
const rebase = (r: DecisionRecord, root: string): DecisionRecord => ({
  ...r,
  cwd: root,
  inputSummary: r.inputSummary.replace('/w/api', root),
  call: {
    tool_name: r.tool,
    input: {
      file_path: String(r.call!.input!.file_path).replace('/w/api', root),
      content: 'x',
    },
  },
});

function candidateFrom(
  records: DecisionRecord[], over: Partial<Parameters<typeof gate>[4]> = {},
): ReturnType<typeof gate> {
  const clusters = clusterWindow(records);
  const cluster = clusters.find(c => c.support.length > 0) ?? clusters[0];
  const support = supportOf(cluster);
  const { tier, declinedTeam } = tierFor(support, false);
  return gate(cluster, support, tier, declinedTeam, {
    projectSlug: null, userSlug: 'devon', windowRotated: false, ...over,
  });
}

// --------------------------------------------------------------------------- the tool set

describe('the tool set is enumerated from the code, not from the issue', () => {
  it('covers exactly the four mutating path-carrying tools, keyed by their own path argument', () => {
    expect([...PATH_TOOLS.entries()].sort()).toEqual([
      ['Edit', 'file_path'],
      ['MultiEdit', 'file_path'],
      ['NotebookEdit', 'notebook_path'],
      ['Write', 'file_path'],
    ]);
  });

  it('excludes the read tools, because rung 1 already grants them for free', () => {
    for (const tool of ['Read', 'Glob', 'Grep', 'NotebookRead']) {
      expect(PATH_TOOLS.has(tool)).toBe(false);
    }
  });

  it('reads `notebook_path` for NotebookEdit and `file_path` for the rest', () => {
    expect(normalisedPath('NotebookEdit', { notebook_path: 'nb/a.ipynb' }, '/w/api'))
      .toBe('/w/api/nb/a.ipynb');
    // The wrong key on the right tool yields nothing rather than falling back to another key: a
    // matcher over a key the tool never sends matches nothing and reads as a clean run.
    expect(normalisedPath('NotebookEdit', { file_path: 'nb/a.ipynb' }, '/w/api')).toBeNull();
    expect(normalisedPath('Write', { notebook_path: 'nb/a.ipynb' }, '/w/api')).toBeNull();
  });

  it('yields nothing for a tool that is not in the set', () => {
    expect(normalisedPath('Bash', { command: 'ls' }, '/w/api')).toBeNull();
    expect(normalisedPath('write_to_file', { path: 'src/a.ts' }, '/w/api')).toBeNull();
  });
});

// --------------------------------------------------------------------------- normalisation

describe('normalisation is one seam, and both encodings reach the same string', () => {
  it('resolves a relative `file_path` against the recorded cwd', () => {
    expect(normalisedPath('Write', { file_path: 'infra/prod/db.tf' }, '/w/api'))
      .toBe('/w/api/infra/prod/db.tf');
  });

  it('leaves an absolute `file_path` alone, collapsing `.` and `..` and doubled separators', () => {
    expect(normalisedPath('Write', { file_path: '/w/api/infra/prod/db.tf' }, '/w/api'))
      .toBe('/w/api/infra/prod/db.tf');
    expect(normalisedPath('Write', { file_path: '/w/api//infra/./prod/db.tf' }, '/w/api'))
      .toBe('/w/api/infra/prod/db.tf');
    expect(normalisedPath('Write', { file_path: '/w/api/infra/staging/../prod/db.tf' }, '/w/api'))
      .toBe('/w/api/infra/prod/db.tf');
  });

  it('refuses a relative path with no cwd rather than resolving against `process.cwd()`', () => {
    expect(normalisedPath('Write', { file_path: 'infra/prod/db.tf' }, null)).toBeNull();
    expect(normalisedPath('Write', { file_path: 'infra/prod/db.tf' }, '')).toBeNull();
  });

  it('refuses a path carrying a character that cannot survive the JSON haystack', () => {
    expect(normalisedPath('Write', { file_path: '/w/api/in"fra/x.tf' }, '/w/api')).toBeNull();
    expect(normalisedPath('Write', { file_path: '/w/api/in\\fra/x.tf' }, '/w/api')).toBeNull();
    expect(normalisedPath('Write', { file_path: '/w/api/in\nfra/x.tf' }, '/w/api')).toBeNull();
  });

  it('a relative and an absolute record for the same file cluster together', () => {
    const records = [
      write('/w/api/infra/prod/db.tf', { sessionId: 'r-1' }),
      write('infra/prod/db.tf', { sessionId: 'r-2' }),
    ];
    const clusters = clusterWindow(records);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].segment).toBe('infra/prod');
    expect(clusters[0].support).toHaveLength(2);
    // And both landed on the same *normalised* segment, so E4's input carries one variant, not two.
    expect(clusters[0].segments).toEqual(['/w/api/infra/prod/db.tf']);
  });
});

// --------------------------------------------------------------------------- the shape

describe('the shape is the directory at the floor, so a cluster is what a clause would cover', () => {
  it('shapes a file two or more directories down as its first two relative segments', () => {
    expect(canonicalPathSegment('/w/api/infra/prod/iam/role.tf', '/w/api')).toBe('infra/prod');
    expect(canonicalPathSegment('/w/api/infra/prod/db.tf', '/w/api')).toBe('infra/prod');
  });

  it('shapes a shallower file as the shallow directory, so the floor refusal is visible', () => {
    expect(canonicalPathSegment('/w/api/src/a.ts', '/w/api')).toBe('src');
  });

  it('has no shape for a file at the cwd root, outside the cwd, or with no cwd', () => {
    expect(canonicalPathSegment('/w/api/README.md', '/w/api')).toBe('');
    expect(canonicalPathSegment('/etc/hosts', '/w/api')).toBe('');
    expect(canonicalPathSegment('/w/apifoo/src/a.ts', '/w/api')).toBe('');   // not a segment boundary
    expect(canonicalPathSegment('/w/api/infra/prod/db.tf', null)).toBe('');
  });
});

// --------------------------------------------------------------------------- the literal and the floor

describe('the literal is the longest common *segment* prefix of the directories', () => {
  it('takes `infra/prod` from files at two different depths under it', () => {
    expect(commonPathLiteral([
      '/w/api/infra/prod/db.tf', '/w/api/infra/prod/net.tf', '/w/api/infra/prod/iam/role.tf',
    ], '/w/api')).toBe('/w/api/infra/prod');
  });

  it('goes deeper when every supporting file shares more, because deeper is narrower', () => {
    expect(commonPathLiteral(
      ['/w/api/infra/prod/iam/role.tf', '/w/api/infra/prod/iam/policy.tf'], '/w/api',
    )).toBe('/w/api/infra/prod/iam');
  });

  it('drops the basename: a file is not a directory prefix', () => {
    expect(commonPathLiteral(['/w/api/infra/prod/db.tf'], '/w/api')).toBe('/w/api/infra/prod');
  });

  it('stops at a segment boundary, never mid-segment', () => {
    // A character-wise longest common prefix of these two is `/w/api/infra/prod`, which is a
    // directory neither file is in. Getting this wrong is how a clause silently governs a sibling.
    expect(commonPathLiteral(
      ['/w/api/infra/production/a.tf', '/w/api/infra/prod/b.tf'], '/w/api',
    )).toBeNull();
  });

  it('refuses at or above the floor: the cwd root, and a single component like `src`', () => {
    expect(PATH_FLOOR_SEGMENTS).toBe(2);
    expect(commonPathLiteral(['/w/api/src/a.ts', '/w/api/src/b.ts'], '/w/api')).toBeNull();
    expect(commonPathLiteral(['/w/api/src/a.ts', '/w/api/docs/b.md'], '/w/api')).toBeNull();
    expect(commonPathLiteral(['/w/api/a.ts'], '/w/api')).toBeNull();
    expect(commonPathLiteral(['/w/api'], '/w/api')).toBeNull();
    expect(commonPathLiteral(['/'], '/')).toBeNull();
  });

  it('refuses a directory with whitespace, because `escapeForMatcher` would loosen it to `\\s+`', () => {
    // One escaper for the whole system is a stated invariant (`practices.ts`), and its whitespace
    // loosening is right for a command and wrong for a path: `a b` and `a  b` are two directories.
    // Refusing here makes the loosening a no-op instead of adding a second escaper.
    expect(commonPathLiteral(['/w/api/my infra/prod/db.tf'], '/w/api')).toBeNull();
    expect(commonPathLiteral(['/w/api/infra/prod/db.tf'], '/w/api')).toBe('/w/api/infra/prod');
  });

  it('refuses a path outside the cwd instead of proposing a `..`-relative literal like `/etc`', () => {
    // Not the floor doing the work: `../../etc` is three segments, so a floor check alone would count
    // it as deep enough and `path.join` would hand back `/etc`. Two paths in different trees ARE
    // caught by the floor — their first segments differ, so the common prefix is empty — which is why
    // the single-path case is the one that pins the guard.
    expect(commonPathLiteral(['/etc/passwd'], '/w/api')).toBeNull();
    expect(commonPathLiteral(
      ['/w/api/infra/prod/db.tf', '/w/other/infra/prod/db.tf'], '/w/api',
    )).toBeNull();
  });

  it('refuses a relative path, which has no meaning without the cwd it came from', () => {
    expect(commonPathLiteral(['infra/prod/db.tf'], '/w/api')).toBeNull();
    expect(commonPathLiteral(['/w/api/infra/prod/db.tf'], null)).toBeNull();
    expect(commonPathLiteral(['/w/api/infra/prod/db.tf'], 'api')).toBeNull();
  });
});

// --------------------------------------------------------------------------- the matcher

describe('the matcher requires a segment boundary and has no left slack', () => {
  const compiled = compileMatcher(pathMatcher('/w/api/infra/prod', 'file_path'))!;
  const hay = (filePath: string): string =>
    haystackFor('Write', { file_path: filePath, content: 'x' });

  it('matches a file under the directory, at any depth', () => {
    expect(compiled.re.test(hay('/w/api/infra/prod/db.tf'))).toBe(true);
    expect(compiled.re.test(hay('/w/api/infra/prod/iam/role.tf'))).toBe(true);
  });

  it('does NOT match a sibling whose name merely starts the same way', () => {
    expect(compiled.re.test(hay('/w/api/infra/production-notes/README.md'))).toBe(false);
    expect(compiled.re.test(hay('/w/api/infra/production/db.tf'))).toBe(false);
    expect(compiled.re.test(hay('/w/api/infra/prod.bak/db.tf'))).toBe(false);
    // And the directory itself is not a file under it.
    expect(compiled.re.test(hay('/w/api/infra/prod'))).toBe(false);
  });

  it('does NOT match the directory appearing anywhere but the start of the value', () => {
    // The left-slack failure: a bare substring matcher licenses a vendored copy in another tree.
    expect(compiled.re.test(hay('/w/api/vendor/w/api/infra/prod/db.tf'))).toBe(false);
    expect(compileMatcher('/w/api/infra/prod')!.re.test(hay('/w/api/vendor/w/api/infra/prod/db.tf')))
      .toBe(true);
  });

  it('does not read the payload as a path', () => {
    // `content` is scanned by `haystackFor` for a red clause, and a green path clause must never be
    // satisfied by a file that merely *mentions* the directory.
    expect(compiled.re.test(haystackFor('Write', {
      file_path: '/w/api/docs/notes.md', content: 'we deploy from /w/api/infra/prod/db.tf',
    }))).toBe(false);
  });

  it('is keyed on the tool\'s own path argument, so a NotebookEdit matcher is a different pattern', () => {
    const nb = compileMatcher(pathMatcher('/w/api/nb/prod', 'notebook_path'))!;
    expect(nb.re.test(haystackFor('NotebookEdit', { notebook_path: '/w/api/nb/prod/a.ipynb' })))
      .toBe(true);
    expect(nb.re.test(haystackFor('Write', { file_path: '/w/api/nb/prod/a.ipynb' }))).toBe(false);
  });
});

// --------------------------------------------------------------------------- never-widen

describe('the path never-widen axes, and only the reachable ones', () => {
  it('drops a directory under the corpus, which a machine may never grant itself', () => {
    expect(pathNeverWidenAxis(['data/knowledge/users/devon'])).toBe('corpus-path');
    expect(pathNeverWidenAxis(['x/data/knowledge'])).toBe('corpus-path');
  });

  it('drops a dot-directory at the cwd root, which is tooling rather than code', () => {
    expect(pathNeverWidenAxis(['.git/hooks'])).toBe('dot-root');
    expect(pathNeverWidenAxis(['.claude/rules'])).toBe('dot-root');
    // A dot directory further down is ordinary: it is inside a tree the evidence is about.
    expect(pathNeverWidenAxis(['src/.generated'])).toBeNull();
  });

  it('passes an ordinary in-repo directory', () => {
    expect(pathNeverWidenAxis(['infra/prod'])).toBeNull();
  });
});

// --------------------------------------------------------------------------- symlinks

describe('a symlinked path refuses the cluster — the matcher is textual, so it cannot resolve one', () => {
  it('reports no escape for a path that sits where it says it sits', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-sym-')));
    fs.mkdirSync(path.join(root, 'infra/prod'), { recursive: true });
    expect(symlinkEscape(path.join(root, 'infra/prod/db.tf'), root)).toBeNull();
  });

  it('reports an escape when a directory in the middle is a symlink out of the tree', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-sym-')));
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-out-')));
    fs.mkdirSync(path.join(root, 'infra'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'infra/prod'));
    const written = path.join(root, 'infra/prod/db.tf');
    expect(symlinkEscape(written, root)).toBe(written);
  });

  it('tolerates a symlinked ancestor of the cwd itself, which macOS `/tmp` always is', () => {
    // The check compares *relative positions*, not absolute strings, precisely so that a cwd handed
    // to us through `/tmp` does not refuse every candidate on the machine.
    const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-sym-')));
    const link = `${real}-link`;
    fs.symlinkSync(real, link);
    fs.mkdirSync(path.join(real, 'infra/prod'), { recursive: true });
    expect(symlinkEscape(path.join(link, 'infra/prod/db.tf'), link)).toBeNull();
  });

  it('refuses the whole cluster, so no clause is written for a symlinked tree', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-sym-')));
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-out-')));
    fs.mkdirSync(path.join(root, 'infra'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'infra/prod'));
    const result = candidateFrom(PROD_WINDOW.map(r => rebase(r, root)));
    expect(result.candidate).toBeNull();
    expect(result.refusal?.why).toBe('path-symlinked');
  });
  it('refuses when one supporting file escapes through a symlink BELOW a clean directory literal', () => {
    // The case the literal-level check cannot see. `infra/prod` itself is a real directory and
    // resolves where it says, so a check on the emitted literal alone passes — while two of the
    // supporting writes went through `infra/prod/iam`, which points out of the tree. A green clause
    // for `infra/prod/` licenses exactly those writes.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-sym-')));
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-out-')));
    fs.mkdirSync(path.join(root, 'infra/prod'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'infra/prod/iam'));
    // The literal this evidence produces is clean — assert that, so the test cannot pass for the
    // wrong reason if the literal check is ever the only one left.
    expect(symlinkEscape(path.join(root, 'infra/prod'), root)).toBeNull();

    const records = PROD_WINDOW.map(r => rebase(r, root));
    const result = candidateFrom(records);
    expect(result.candidate).toBeNull();
    expect(result.refusal?.why).toBe('path-symlinked');
    expect(result.refusal?.detail).toBe(path.join(root, 'infra/prod/iam/role.tf'));
  });
});

// --------------------------------------------------------------------------- the gate, end to end

describe('the gate, over the directory lane', () => {
  it('admits the worked example at user tier as a green', () => {
    const { candidate, refusal } = candidateFrom(PROD_WINDOW);
    expect(refusal).toBeNull();
    expect(candidate).not.toBeNull();
    expect(candidate!.tier).toBe('user');
    expect(candidate!.level).toBe('green');
    expect(candidate!.literal).toBe('/w/api/infra/prod');
    expect(candidate!.support.occurrences).toBe(5);
    expect(candidate!.id).not.toMatch(/\d{8}/);              // dateless
  });

  it('refuses a cluster at the floor, and names the floor', () => {
    const shallow = Array.from({ length: 6 }, (_, i) => write('/w/api/src/a.ts', {
      sessionId: `s-${i}`, ts: `2026-08-2${i}T09:00:00.000Z`,
    }));
    const result = candidateFrom(shallow);
    expect(result.candidate).toBeNull();
    expect(result.refusal?.why).toBe('path-below-floor');
  });

  it('refuses a never-widen axis over the corpus itself', () => {
    const corpus = Array.from({ length: 6 }, (_, i) =>
      write('/w/api/data/knowledge/users/devon/learned/x.md', {
        sessionId: `c-${i}`, ts: `2026-08-2${i}T09:00:00.000Z`,
      }));
    const result = candidateFrom(corpus);
    expect(result.refusal?.why).toBe('never-widen');
    expect(result.refusal?.detail).toBe('corpus-path');
  });

  it('still refuses a tool that carries no path at all', () => {
    const unknown = Array.from({ length: 6 }, (_, i) => write('x', {
      tool: 'WebFetch', sessionId: `u-${i}`, ts: `2026-08-2${i}T09:00:00.000Z`,
      call: { tool_name: 'WebFetch', input: { url: 'https://example.invalid' } },
    }));
    expect(candidateFrom(unknown).refusal?.why).toBe('no-matcher-shape');
  });

  it('emits a matcher the runtime haystack actually satisfies, and a body that says it is textual', () => {
    const { candidate } = candidateFrom(PROD_WINDOW);
    const compiled = compileMatcher(candidate!.match[0])!;
    expect(compiled.re.test(haystackFor('Write', {
      file_path: '/w/api/infra/prod/db.tf', content: 'x',
    }))).toBe(true);
    expect(compiled.re.test(haystackFor('Write', {
      file_path: '/w/api/infra/production-notes/x.md', content: 'x',
    }))).toBe(false);

    const body = renderClause(candidate!, '2026-09-04');
    expect(body).toContain('status: proposed');
    expect(body).toMatch(/textual guard/i);
    expect(body).toMatch(/assertWritable/);
  });
});

// --------------------------------------------------------------------------- the run, end to end

describe('a directory candidate goes through the same machinery as everything else', () => {
  const rig = (records: DecisionRecord[]) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-run-'));
    const corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-corpus-'));
    fs.writeFileSync(path.join(dir, 'decisions.jsonl'),
      `${records.map(r => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    return {
      corpus,
      env: { SESSION_SITTER_DATA_DIR: dir } as NodeJS.ProcessEnv,
      settings: { user: 'devon', project: null, team: null } as unknown as PluginSettings,
    };
  };
  const go = (r: ReturnType<typeof rig>) => propose({
    settings: r.settings, corpusRoot: r.corpus, corpus: [], rev: 'a91f3c2', env: r.env,
    now: new Date('2026-09-04T18:41:07.221Z'),
  });

  it('writes `learned/<id>.md` at `status: proposed`, with a dateless id', () => {
    const r = rig(PROD_WINDOW);
    const { line } = go(r);
    expect(line.proposals.clauses).toHaveLength(1);
    const file = path.join(r.corpus, 'data/knowledge/users/devon/learned',
      `${line.proposals.clauses[0].id}.md`);
    expect(fs.existsSync(file)).toBe(true);
    expect(line.proposals.clauses[0].id).not.toMatch(/\d{8}/);

    const parsed = parseLearnedClause(fs.readFileSync(file, 'utf8'), 'user', file);
    expect(parsed.clause?.status).toBe('proposed');
    expect(parsed.findings.filter(f => f.severity === 'error')).toEqual([]);
  });

  it('is suppressed by the status guard once a human has declined it', () => {
    const r = rig(PROD_WINDOW);
    const { line: first } = go(r);
    const file = path.join(r.corpus, 'data/knowledge/users/devon/learned',
      `${first.proposals.clauses[0].id}.md`);
    const declined = fs.readFileSync(file, 'utf8').replace('status: proposed', 'status: declined');
    fs.writeFileSync(file, declined, 'utf8');

    const { line: second } = go(rigSharedCorpus(r));
    expect(second.suppressed.statusGuard).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe(declined);
  });

  it('counts a floor refusal as prose-only, and a symlink refusal as neither', () => {
    // `proseOnly` means "a human could still write this rule". A directory at the floor qualifies; a
    // tree that is not the tree it looks like does not, and must not be reported as advice.
    const shallow = Array.from({ length: 6 }, (_, i) => write('/w/api/src/a.ts', {
      sessionId: `q-${i}`, ts: `2026-08-2${i}T09:00:00.000Z`,
    }));
    const floor = go(rig(shallow)).line;
    expect(floor.suppressed.proseOnly).toBeGreaterThanOrEqual(1);
    expect(floor.refusals.map(r => r.why)).toContain('path-below-floor');

    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-sym-')));
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-out-')));
    fs.mkdirSync(path.join(root, 'infra'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'infra/prod'));
    const sym = go(rig(PROD_WINDOW.map(r => rebase(r, root)))).line;
    expect(sym.refusals.map(r => r.why)).toContain('path-symlinked');
    expect(sym.suppressed.proseOnly).toBe(0);
    expect(sym.proposals.clauses).toEqual([]);
  });

  /** The same corpus, a fresh trail offset — a second `learn` over the same records. */
  function rigSharedCorpus(r: ReturnType<typeof rig>): ReturnType<typeof rig> {
    const fresh = rig(PROD_WINDOW);
    return { ...fresh, corpus: r.corpus };
  }
});
