/**
 * Stage B invariants — `11-mine-v2.md` §12.4, §12.11–12.15, §12.19–12.21, §12.24, §12.28, §12.30.
 *
 * Two of these are the ones the design says are easiest to get wrong, and both are structural rather
 * than cosmetic:
 *
 *  - **§12.12/§12.13, the anchored matcher.** An emitted `Match:` must not match
 *    `rm -rf / # pnpm test`. A bare substring does, which is why gate E5 forbids one. The test asserts
 *    against the *literal* string, so a regression to a substring fails here rather than in production.
 *  - **§12.30, every proposal rule fires on a state the code can produce.** The retirement rules are
 *    triggered by **calling `classify()`** with the (level, changed, lifetimeFires, misses, matches)
 *    that reach each class — never by writing the class string literal. A test hardcoding
 *    `'dead-weight?'` on a green clause passes happily and proves nothing, and twice in this design's
 *    review a rule was written against a state that cannot occur.
 *
 * Every fixture is invented. No real path, no real project name.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DecisionRecord } from '../../audit/trail';
import {
  CEILING_PER_TIER,
  EvidenceClass,
  GREEN_PERSISTENCE_NOTE,
  RED_NOT_PROPOSED,
  SHADOWED_NOTE,
  classify,
  renderedCount,
} from '../../policy/ablate';
import type { AblationReport } from '../../policy/ablate';
import { CLAUSE_STATUSES, parseLearnedClause } from '../../supervisor/learnedClauses';
import { compileMatcher, parsePractices } from '../../policy/practices';
import { clusterWindow, supportOf, tierFor } from '../../policy/mine';
import {
  Candidate,
  candidateId,
  commandMatcher,
  commonLiteral,
  escapesCwd,
  gate,
  neverWidenAxis,
  planRetirements,
  renderClause,
  slugOf,
  statusOf,
  writeClause,
} from '../../policy/propose';
import { haystackFor } from '../../hooks/session';

// --------------------------------------------------------------------------- fixtures

let seq = 0;
const bash = (command: string, over: Partial<DecisionRecord> = {}): DecisionRecord => {
  seq += 1;
  return {
    ts: '2026-08-25T09:00:00.000Z',
    sessionId: `s-${seq}`,
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
  };
};

/** The §11 worked example: six allows across three sessions and nine days, plus the fail-closed deny. */
const PNPM_WINDOW: DecisionRecord[] = [
  bash('pnpm test --filter core', {
    sessionId: 's-A', ts: '2026-08-25T09:12:03.000Z', decision: 'deny', light: null,
    actor: 'timeout', latencyMs: 8014,
  }),
  bash('pnpm test --filter core', { sessionId: 's-A', ts: '2026-08-25T09:14:40.000Z' }),
  bash('pnpm test --filter cli', { sessionId: 's-B', ts: '2026-08-27T14:02:55.000Z' }),
  bash('pnpm test --filter cli', { sessionId: 's-B', ts: '2026-08-27T14:31:08.000Z' }),
  bash('pnpm test', { sessionId: 's-C', ts: '2026-09-01T10:20:11.000Z' }),
  bash('pnpm test --watch', { sessionId: 's-C', ts: '2026-09-01T10:41:02.000Z' }),
];

function candidateFrom(
  records: DecisionRecord[], over: Partial<Parameters<typeof gate>[4]> = {},
): ReturnType<typeof gate> {
  const cluster = clusterWindow(records).find(c => c.support.length > 0)
    ?? clusterWindow(records)[0];
  const support = supportOf(cluster);
  const { tier, declinedTeam } = tierFor(support, false);
  return gate(cluster, support, tier, declinedTeam, {
    projectSlug: null, userSlug: 'devon', windowRotated: false, ...over,
  });
}

function corpusRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ss-corpus-'));
}

// --------------------------------------------------------------------------- E4, the literal

describe('E4 — the literal is the longest common token prefix, ≥ 2 tokens', () => {
  it('takes `pnpm test` from the four observed variants', () => {
    expect(commonLiteral([
      'pnpm test', 'pnpm test --filter core', 'pnpm test --filter cli', 'pnpm test --watch',
    ])).toBe('pnpm test');
  });

  it('refuses a one-token prefix, because that is a whole tool (§12.13)', () => {
    expect(commonLiteral(['git status', 'git push --force'])).toBeNull();
    expect(commonLiteral(['ls -la', 'ls -R'])).toBeNull();
    expect(commonLiteral(['npm'])).toBeNull();
  });

  it('does not stop `rm -rf` at E4 — two tokens is two tokens', () => {
    // Worth pinning, because it is where the division of labour lives. E4 is only about how much of
    // the evidence a prefix covers; `rm` is refused by E8's never-widen list, which is the gate that
    // judges what a command *does*. Conflating the two would leave each half looking like it covered
    // the other.
    expect(commonLiteral(['rm -rf dist', 'rm -rf build'])).toBe('rm -rf');
    expect(neverWidenAxis(['rm -rf dist'], '/w/api')).toBe('rm');
  });

  it('accepts three tokens when all the evidence shares them', () => {
    expect(commonLiteral(['npm run build', 'npm run build --watch'])).toBe('npm run build');
  });

  it('never returns a prefix `prefixOf` would reject for some supporting segment', () => {
    // `prefixOf` is the acceptance test, not the generator, and its word-boundary anchor is the whole
    // reason: a token-wise LCP alone would happily hand back a prefix that ends mid-word.
    expect(commonLiteral(['npm test', 'npm testing-library'])).toBeNull();
  });
});

// --------------------------------------------------------------------------- E5, the matcher

describe('E5 — the matcher is anchored, and never a bare substring (§12.12)', () => {
  const matcher = commandMatcher('pnpm test');
  const compiled = compileMatcher(matcher)!;
  const hay = (command: string): string => haystackFor('Bash', { command });

  it('matches the command it was derived from, and its arguments', () => {
    expect(compiled.re.test(hay('pnpm test'))).toBe(true);
    expect(compiled.re.test(hay('pnpm test --filter x'))).toBe(true);
    expect(compiled.re.test(hay('pnpm  test'))).toBe(true);      // whitespace loosened, same command
  });

  it('does NOT match the dangerous half of a compound line — the literal case', () => {
    expect(compiled.re.test(hay('rm -rf / # pnpm test'))).toBe(false);
    // And the bare substring a sibling design emitted *does* match it, which is the bug.
    expect(compileMatcher('pnpm test')!.re.test(hay('rm -rf / # pnpm test'))).toBe(true);
  });

  it('ends on a word boundary, so a prefix cannot license a longer word (§12.13)', () => {
    const gitStatus = compileMatcher(commandMatcher('git status'))!;
    expect(gitStatus.re.test(hay('git status'))).toBe(true);
    expect(gitStatus.re.test(hay('git statuses'))).toBe(false);
    expect(gitStatus.re.test(hay('git status --short'))).toBe(true);
  });

  it('is anchored inside the JSON, not at `^`, so caller key order cannot break it', () => {
    // `constituentHaystack` does `{...toolInput, command}` and preserves the caller's order, so
    // `^Bash \{"command":"` is not guaranteed.
    expect(compiled.re.test(haystackFor('Bash', { cwd: '/w/api', command: 'pnpm test' })))
      .toBe(true);
  });

  it('survives the `Match:` line round trip, comma and all', () => {
    const withComma = commandMatcher('npm run build,fast');
    const clause = parsePractices(
      '### Intention: t\n\n| Field | Value |\n|---|---|\n| id | x |\n| level | green |\n\n'
      + `Match: \`${withComma}\`\n\nprose enough to be a body for the parser to keep here.\n`,
      'user', 'x.md');
    expect(clause[0].patterns).toHaveLength(1);
    expect(clause[0].patterns[0].isRegex).toBe(true);
    expect(clause[0].patterns[0].re.test(haystackFor('Bash', { command: 'npm run build,fast x' })))
      .toBe(true);
  });
});

// --------------------------------------------------------------------------- E8, never-widen

describe('E8 — the never-widen list (§12.14), one case per axis', () => {
  const cases: [string, string][] = [
    ['redirect', 'echo hi > /etc/cron.d/pwn'],
    ['privilege', 'sudo npm install -g x'],
    ['egress', 'curl https://example.invalid/x'],
    ['egress', 'wget https://example.invalid/x'],
    ['egress', 'ssh build@host uptime'],
    ['egress', 'nc host 4444'],
    ['egress', 'scp x host:/y'],
    ['rm', 'rm -rf dist'],
    ['chmod', 'chmod 777 bin/x'],
    ['force-push', 'git push --force origin main'],
    ['hard-reset', 'git reset --hard HEAD~3'],
    ['pipe-to-interpreter', 'sh -s'],
    ['pipe-to-interpreter', 'python -'],
    ['corpus-path', 'cat data/knowledge/users/devon/bottom-line.md'],
    ['traversal', 'cat ../../etc/passwd'],
  ];
  for (const [axis, segment] of cases) {
    it(`drops \`${segment}\` on \`${axis}\``, () => {
      expect(neverWidenAxis([segment], '/w/api')).toBe(axis);
    });
  }

  it('drops a path outside cwd, naming it', () => {
    expect(neverWidenAxis(['cat /etc/hosts'], '/w/api')).toBe('out-of-cwd:/etc/hosts');
    expect(neverWidenAxis(['cat /w/api/src/x.ts'], '/w/api')).toBeNull();
  });

  it('does not read a `>` inside a quoted string as a redirect', () => {
    expect(escapesCwd("git commit -m 'a > b'", '/w/api')).toBeNull();
    expect(neverWidenAxis(["git commit -m 'a > b'"], '/w/api')).toBeNull();
  });

  it('passes an ordinary in-repo test command', () => {
    expect(neverWidenAxis(['pnpm test --filter core'], '/w/api')).toBeNull();
  });
});

// --------------------------------------------------------------------------- the gates

describe('the gates (§4.3)', () => {
  it('admits the worked example at user tier', () => {
    const { candidate, refusal } = candidateFrom(PNPM_WINDOW);
    expect(refusal).toBeNull();
    expect(candidate).not.toBeNull();
    expect(candidate!.tier).toBe('user');
    expect(candidate!.level).toBe('green');
    expect(candidate!.literal).toBe('pnpm test');
    expect(candidate!.support.occurrences).toBe(5);
    expect(candidate!.id).toBe(candidateId('green-repeat', 'pnpm-test', candidate!.shape12));
    // Dateless: no `2026`, nowhere.
    expect(candidate!.id).not.toMatch(/\d{8}/);
  });

  it('E1 — refuses a support set with a record that has no `call`', () => {
    const window = PNPM_WINDOW.map((r, i) => i === 2 ? { ...r, call: null } : r);
    expect(candidateFrom(window).refusal?.why).toBe('no-call');
  });

  it('E2 — a path-carrying write tool now has a shape, and refuses on the floor instead', () => {
    // This case used to assert `no-matcher-shape`, back when the directory lane did not exist. It
    // still refuses — `src` is one segment, which is a whole top-level tree — but it refuses for the
    // reason the lane gives rather than for want of a lane. `src/test/policy/paths.test.ts` owns the
    // rest of the lane's invariants.
    const writes = Array.from({ length: 6 }, (_, i) => bash('x', {
      tool: 'Write', call: { tool_name: 'Write', input: { file_path: '/w/api/src/a.ts' } },
      sessionId: `s-w${i}`, ts: `2026-08-2${i}T09:00:00.000Z`,
    }));
    expect(candidateFrom(writes).refusal?.why).toBe('path-below-floor');
  });

  it('E2 — refuses a tool that carries no path and no command at all', () => {
    const fetches = Array.from({ length: 6 }, (_, i) => bash('x', {
      tool: 'WebFetch',
      call: { tool_name: 'WebFetch', input: { url: 'https://example.invalid/x' } },
      sessionId: `s-f${i}`, ts: `2026-08-2${i}T09:00:00.000Z`,
    }));
    expect(candidateFrom(fetches).refusal?.why).toBe('no-matcher-shape');
  });

  it('E3a — refuses the whole cluster on an unconfident split (§12.6)', () => {
    const window = [...PNPM_WINDOW, bash("pnpm test 'unbalanced", { sessionId: 's-D' })];
    expect(candidateFrom(window).refusal?.why).toBe('unconfident-split');
  });

  it('E6 — a written red deny contradicts, a fail-closed deny does not (§12.12 of §4.3)', () => {
    const contradicted = [...PNPM_WINDOW, bash('pnpm test --filter core', {
      sessionId: 's-D', decision: 'deny', light: 'red', clause: 'practices §team-test-001',
    })];
    const result = candidateFrom(contradicted);
    expect(result.refusal?.why).toBe('contradicted');
    expect(result.refusal?.detail).toBe('team-test-001');
    // The fail-closed deny already in PNPM_WINDOW is not a contradiction — it is the gap itself.
    expect(candidateFrom(PNPM_WINDOW).refusal).toBeNull();
  });

  it('E7 — a mixed-light support set is rejected outright, not softened (§12.15)', () => {
    const mixed = PNPM_WINDOW.map((r, i) => i === 3 ? { ...r, light: 'yellow' } : r);
    expect(candidateFrom(mixed).refusal?.why).toBe('mixed-light');
  });

  it('E8 — drops rather than narrows', () => {
    const pushes = Array.from({ length: 6 }, (_, i) => bash('git push --force origin main', {
      sessionId: `s-p${i}`, ts: `2026-08-2${i}T09:00:00.000Z`,
    }));
    const result = candidateFrom(pushes);
    // `git push` is also a one-token-per-side case, so assert the axis specifically.
    expect(['never-widen', 'prefix-too-short']).toContain(result.refusal?.why);
  });

  it('refuses a shape nothing was ever silent about', () => {
    const decided = PNPM_WINDOW
      .filter(r => r.actor !== 'timeout')
      .map(r => ({ ...r, actor: 'policy' as const, clause: 'practices §a' }));
    expect(candidateFrom(decided).refusal?.why).toBe('no-gap');
  });

  it('E9 — no derivable matcher means zero files and one report line (§12.11)', () => {
    // A shape whose second token is a flag has no subcommand, so its segments share only `ls` — one
    // token, a whole tool, and never what anyone meant.
    const statuses = ['ls -la', 'ls -R', 'ls -1', 'ls -la src', 'ls -h', 'ls --color']
      .map((command, i) => bash(command, {
        sessionId: `s-l${i}`, ts: `2026-08-2${i}T09:00:00.000Z`,
      }));
    const result = candidateFrom(statuses);
    expect(result.candidate).toBeNull();
    expect(result.refusal?.why).toBe('prefix-too-short');
  });

  it('suppresses a candidate already stated in a repo instruction file (§12.26)', () => {
    const result = candidateFrom(PNPM_WINDOW, {
      instructionText: '# Project rules\n\nAlways run `pnpm test` before pushing.\n',
    });
    expect(result.alreadyStated).toBe(true);
    expect(candidateFrom(PNPM_WINDOW, { instructionText: '# unrelated' }).alreadyStated)
      .toBe(false);
  });
});

// --------------------------------------------------------------------------- the rendered file

describe('the clause file', () => {
  const rendered = (): { candidate: Candidate; text: string } => {
    const candidate = candidateFrom(PNPM_WINDOW).candidate!;
    return { candidate, text: renderClause(candidate, '2026-09-03') };
  };

  it('parses with zero findings above `info`', () => {
    const { candidate, text } = rendered();
    const parsed = parseLearnedClause(
      text, 'user', `data/knowledge/users/devon/learned/${candidate.id}.md`);
    const bad = parsed.findings.filter(f => f.severity !== 'info');
    expect(bad).toEqual([]);
    expect(parsed.clause).not.toBeNull();
    expect(parsed.clause!.status).toBe('proposed');
    expect(parsed.clause!.level).toBe('green');
    expect(parsed.clause!.origin).toBe('learned');
  });

  it('carries a matchable `Match:` line the loader compiles', () => {
    const { text } = rendered();
    const parsed = parseLearnedClause(text, 'user',
      `data/knowledge/users/devon/learned/${rendered().candidate.id}.md`);
    expect(parsed.clause!.entry.text).toContain('Match:');
  });

  it('writes none of the fields the pipeline may never write (§4.8)', () => {
    const { text } = rendered();
    for (const forbidden of [
      'weight:', 'origin:', 'confidence:', 'expires:', 'adopted_at:', 'retired_at:',
      'retired_reason:', 'retired_by:', 'displaces:', 'sessions:',
    ]) {
      expect(text).not.toContain(`\n${forbidden}`);
      expect(text).not.toContain(`\n  ${forbidden}`);
    }
    expect(text).toContain('status: proposed');
  });

  it('is byte-identical over identical evidence (§12.1)', () => {
    expect(renderClause(candidateFrom(PNPM_WINDOW).candidate!, '2026-09-03'))
      .toBe(renderClause(candidateFrom(PNPM_WINDOW).candidate!, '2026-09-03'));
  });

  it('states the counts are window-scoped, because they are', () => {
    expect(rendered().text).toContain('rotates at 4 MiB');
  });
});

// --------------------------------------------------------------------------- §12.4, §12.24 the write

describe('the write boundary and the status guard', () => {
  const write = (root: string, over: Partial<Candidate> = {}) => {
    const candidate = { ...candidateFrom(PNPM_WINDOW).candidate!, ...over } as Candidate;
    return writeClause(root, candidate, renderClause(candidate, '2026-09-03'));
  };

  it('writes exactly `data/knowledge/users/<slug>/learned/<id>.md` (§12.24)', () => {
    const root = corpusRoot();
    const { outcome, file } = write(root);
    expect(outcome).toBe('written');
    expect(file).toBe(
      `data/knowledge/users/devon/learned/${candidateFrom(PNPM_WINDOW).candidate!.id}.md`);
    expect(fs.existsSync(path.join(root, file))).toBe(true);
  });

  it('refuses a scope that escapes the corpus', () => {
    const root = corpusRoot();
    expect(() => write(root, { scope: '../../../etc' })).toThrow(/refusing to write/);
  });

  it('leaves no temp file behind', () => {
    const root = corpusRoot();
    const { file } = write(root);
    const dir = path.dirname(path.join(root, file));
    expect(fs.readdirSync(dir).filter(n => n.includes('tmp'))).toEqual([]);
  });

  it('overwrites a `proposed` file — the normal, correct path (§11.4)', () => {
    const root = corpusRoot();
    expect(write(root).outcome).toBe('written');
    expect(write(root).outcome).toBe('overwritten');
  });

  it('refuses every status that is not `proposed` — one case each (§12.4)', () => {
    for (const status of CLAUSE_STATUSES.filter(s => s !== 'proposed')) {
      const root = corpusRoot();
      const { file } = write(root);
      const target = path.join(root, file);
      const extra = status === 'retired'
        ? '\nretired_at: 2026-09-01\nretired_reason: manual'
        : '';
      fs.writeFileSync(target,
        fs.readFileSync(target, 'utf8').replace('status: proposed', `status: ${status}${extra}`),
        'utf8');
      expect(write(root).outcome).toBe('status-guard');
      // And the human's own decision is still on disk, untouched.
      expect(fs.readFileSync(target, 'utf8')).toContain(`status: ${status}`);
    }
  });

  it('refuses an existing file it cannot parse, rather than guessing it is `proposed`', () => {
    const root = corpusRoot();
    const { file } = write(root);
    fs.writeFileSync(path.join(root, file), 'not a clause at all', 'utf8');
    expect(write(root).outcome).toBe('status-guard');
  });

  it('reads a status the same way the loader does', () => {
    expect(statusOf('---\nid: x\nstatus: declined\n---\n\nbody\n')).toBe('declined');
    expect(statusOf('---\nid: x\nstatus: nonsense\n---\n\nbody\n')).toBeNull();
    expect(statusOf('no frontmatter')).toBeNull();
  });

  it('derives an id that `isSafeId` accepts, from any segment', () => {
    expect(slugOf('npm run build:all', 'Bash')).toBe('npm-run-build-all');
    expect(() => candidateId('green-repeat', slugOf('', 'Bash'), 'abc123def456')).not.toThrow();
  });
});

// --------------------------------------------------------------------------- §12.19-12.21, §12.28, §12.30

describe('retirement — the rule is `classify()`, not a string literal (§12.28, §12.30)', () => {
  /** Build a report the way `ablate` does, with the class *computed* by `classify`. */
  const report = (
    level: 'red' | 'orange' | 'yellow' | 'green',
    changed: number, lifetimeFires: number, misses: number, matches: number,
  ): AblationReport => {
    const evidenceClass = classify(level, changed, lifetimeFires, misses, matches);
    return {
      clause_id: `c-${level}-${evidenceClass}`,
      level,
      tier: 'user',
      window: { decisions: 500, days: 90, lifetime: level === 'red' || level === 'orange' },
      changed,
      near_misses: misses,
      lifetime_fires: lifetimeFires,
      window_fires: 0,
      evidence_class: evidenceClass,
      matches,
      shadowed_by: evidenceClass === 'shadowed' ? "rung 2's corrected — practices §x" : undefined,
      // The broader boolean the pipeline must NOT key off: true for a shadowed green too.
      retirement_candidate: changed === 0 && level !== 'red' && level !== 'orange',
      evidence: `removing §x changes ${changed} of 500 decisions`,
    };
  };

  it('proposes retirement for `retire`, and for nothing else — one case per class', () => {
    // Every class, reached by calling `classify` with inputs that actually produce it.
    const reached = new Map<EvidenceClass, AblationReport>();
    for (const r of [
      report('green', 3, 0, 0, 0),      // in-service
      report('green', 0, 0, 0, 4),      // shadowed  — retirement_candidate is TRUE here
      report('red', 0, 2, 0, 0),        // deterrent
      report('red', 0, 0, 3, 0),        // dead-weight?
      report('red', 0, 0, 0, 0),        // insufficient-exposure
      report('green', 0, 0, 0, 0),      // retire
    ]) {
      reached.set(r.evidence_class, r);
    }
    // If any of those inputs stopped reaching its class, this fails before any assertion below.
    expect([...reached.keys()].sort()).toEqual([
      'dead-weight?', 'deterrent', 'in-service', 'insufficient-exposure', 'retire', 'shadowed',
    ]);

    for (const [cls, r] of reached) {
      const plan = planRetirements([r], false);
      if (cls === 'retire') {
        expect(plan.retirements.map(x => x.target)).toEqual([r.clause_id]);
      } else {
        expect(plan.retirements).toEqual([]);
      }
    }
  });

  it('`dead-weight?` is unreachable for a green, so it is not the green retirement class', () => {
    expect(classify('green', 0, 0, 3, 0)).toBe('retire');
    expect(classify('red', 0, 0, 3, 0)).toBe('dead-weight?');
    // The two are level-partitioned and disjoint: no clause can ever receive both.
    expect(classify('green', 0, 0, 0, 0)).toBe('retire');
    expect(classify('orange', 0, 0, 0, 0)).toBe('insufficient-exposure');
  });

  it('never keys off `retirement_candidate` — a shadowed green has it set (§8.2)', () => {
    const shadowedGreen = report('green', 0, 0, 0, 4);
    expect(shadowedGreen.retirement_candidate).toBe(true);
    expect(shadowedGreen.evidence_class).toBe('shadowed');
    const plan = planRetirements([shadowedGreen], false);
    expect(plan.retirements).toEqual([]);
    expect(plan.redundancies).toHaveLength(1);
    expect(plan.redundancies[0].note).toContain(SHADOWED_NOTE);
    expect(plan.redundancies[0].shadowed_by).toContain('rung 2');
  });

  it('a red ablating to zero is listed, never retired, and carries RED_NOT_PROPOSED (§12.19)', () => {
    for (const r of [report('red', 0, 2, 0, 0), report('red', 0, 0, 3, 0), report('red', 0, 0, 0, 0)]) {
      const plan = planRetirements([r], false);
      expect(plan.retirements).toEqual([]);
      expect(plan.listings).toHaveLength(1);
      expect(plan.listings[0].why).toContain(RED_NOT_PROPOSED);
    }
  });

  it('every green retirement carries GREEN_PERSISTENCE_NOTE verbatim', () => {
    const plan = planRetirements([report('green', 0, 0, 0, 0)], true);
    expect(plan.retirements[0].note).toBe(GREEN_PERSISTENCE_NOTE);
    expect(plan.retirements[0].windowRotated).toBe(true);
  });

  it('a retirement writes no file (§12.21)', () => {
    const root = corpusRoot();
    const plan = planRetirements([report('green', 0, 0, 0, 0)], false);
    expect(plan.retirements).toHaveLength(1);
    // `planRetirements` has no filesystem parameter at all, which is the point — there is no path
    // through it that can write. Assert the corpus is untouched anyway.
    expect(fs.existsSync(path.join(root, 'data'))).toBe(false);
  });
});

// --------------------------------------------------------------------------- §12.29 the ceiling seam

describe('the ceiling exemption depends on the selector, and that is pinned (§12.29)', () => {
  it('a matchable mined clause consumes no rendered budget', () => {
    const candidate = candidateFrom(PNPM_WINDOW).candidate!;
    const compiled = [{
      id: candidate.id,
      origin: 'learned' as const,
      tier: 'user',
      level: 'green' as const,
      status: 'accepted' as const,
      patterns: [{ raw: candidate.match[0], isRegex: true, flags: 'i' }],
      fix: null,
    }];
    // `renderedCount` counts only clauses with `patterns.length === 0`, and gate E9 means a mined
    // clause always has one. If someone reintroduces an unfiltered bundle, this number moves and
    // eviction pressure against reds reappears with nothing else in the system complaining.
    expect(renderedCount(compiled as never, 'learned-green')).toBe(0);
    expect(CEILING_PER_TIER).toBe(25);
  });
});
