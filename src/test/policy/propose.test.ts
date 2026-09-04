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
  ablate,
  classify,
  renderedCount,
} from '../../policy/ablate';
import type { AblationReport } from '../../policy/ablate';
import { CLAUSE_STATUSES, parseLearnedClause } from '../../supervisor/learnedClauses';
import { compilePolicy } from '../../policy/compile';
import type { Clause } from '../../policy/practices';
import { compileMatcher, parsePractices } from '../../policy/practices';
import { clusterWindow, supportOf, tierFor } from '../../policy/mine';
import {
  Candidate,
  MERGE_NON_WIDENING,
  candidateId,
  commandMatcher,
  commonLiteral,
  escapesCwd,
  findSubsumptions,
  gate,
  neverWidenAxis,
  planRetirements,
  renderClause,
  slugOf,
  statusOf,
  subsumesClause,
  subsumesMatcher,
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

  it('E2 — refuses a tool with no matcher shape (the directory lane is not built)', () => {
    const writes = Array.from({ length: 6 }, (_, i) => bash('x', {
      tool: 'Write', call: { tool_name: 'Write', input: { file_path: '/w/api/src/a.ts' } },
      sessionId: `s-w${i}`, ts: `2026-08-2${i}T09:00:00.000Z`,
    }));
    expect(candidateFrom(writes).refusal?.why).toBe('no-matcher-shape');
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

// --------------------------------------------------------------------------- §8.3 merge

/**
 * Merge — the containment that is provable, and the intersection that is not (§8.3).
 *
 * Every clause here is built by `parsePractices` or by wrapping `commandMatcher`'s real output in
 * `compileMatcher`, never by hand-writing a `ClauseMatcher`: the whole claim under test is about the
 * shapes the *pipeline itself emits*, and a hand-written literal would let the emitter and the reader
 * of that emitter drift apart without any test noticing.
 */
describe('§8.3 merge — provable containment only', () => {
  const clause = (over: Partial<Clause> & { clauseId: string; match: string[] }): Clause => ({
    clauseId: over.clauseId,
    citation: `practices §${over.clauseId}`,
    kind: 'intention',
    level: over.level ?? 'green',
    title: over.clauseId,
    tier: over.tier ?? 'user',
    text: 'invented fixture',
    tags: [],
    patterns: over.match.map(m => compileMatcher(m)!),
    sourceFile: null,
    origin: over.origin ?? 'learned',
  });

  /**
   * One `learned/<id>.md` through the real parser, so the compile assertion below is made against a
   * clause the loader actually produced rather than a hand-built object shaped like one.
   */
  const learnedFile = (id: string, match: string, supersedes: readonly string[]) => {
    const text = [
      '---',
      `id: ${id}`,
      'status: accepted',
      'level: green',
      'evidence: EXTRACTED',
      'support: 12',
      'weight: medium',
      'contradictions: 0',
      'learned_at: 2026-08-30',
      'adopted_at: 2026-09-01',
      ...(supersedes.length === 0 ? [] : [`supersedes: [${supersedes.join(', ')}]`]),
      'learned_from:',
      '  decisions: [d-8f21e0, d-8f2244]',
      '---',
      '',
      `### Intention: ${id}`,
      '',
      `Match: \`${match}\``,
      '',
      'Observed repeatedly and never contradicted by a written rule, so the classifier was answering '
        + 'a question a clause can answer for free. Invented fixture, no real path or project.',
    ].join('\n');
    const rel = `data/knowledge/users/devon/learned/${id}.md`;
    const parsed = parseLearnedClause(text, 'user', rel);
    if (!parsed.clause) {
      throw new Error(`fixture does not parse: ${JSON.stringify(parsed.findings)}`);
    }
    return parsed.clause;
  };

  /** The anchored form the miner actually emits, for a command literal. */
  const mined = (id: string, literal: string, over: Partial<Clause> = {}): Clause =>
    clause({ clauseId: id, match: [commandMatcher(literal)], ...over });

  it('proves a command-prefix containment on the shape the miner emits', () => {
    const found = findSubsumptions([mined('a-npm-test', 'npm test'),
      mined('b-npm-test-watch', 'npm test --watch')]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      keep: 'a-npm-test', drop: 'b-npm-test-watch', proof: 'command-prefix', proposed: true,
    });
    expect(found[0].note).toContain(MERGE_NON_WIDENING);
  });

  it('refuses a prefix that does not land on a token boundary', () => {
    // `np` and `npm test` overlap textually and neither subsumes the other: `npm` fails `np`'s own
    // word-boundary lookahead, so the shorter matcher does not match the command the longer one does.
    expect(findSubsumptions([mined('a-np', 'np'), mined('b-npm-test', 'npm test')])).toEqual([]);
  });

  it('a human substring clause subsumes a mined clause on the same command', () => {
    const human = parsePractices([
      '### Intention: pnpm test is fine',
      '',
      '| Field | Value |',
      '| --- | --- |',
      '| id | user-test-001 |',
      '| level | green |',
      '',
      'Match: `pnpm test`',
      '',
      'Invented fixture.',
    ].join('\n'), 'user')[0];
    const found = findSubsumptions([human, mined('z-pnpm-test-filter', 'pnpm test --filter core')]);
    expect(found.map(f => [f.keep, f.drop, f.proof]))
      .toEqual([['user-test-001', 'z-pnpm-test-filter', 'substring']]);
  });

  it('never drops a human clause, whichever way containment runs', () => {
    const human = clause({ clauseId: 'h-narrow', match: ['pnpm test --filter core'],
      origin: 'human' });
    const learned = clause({ clauseId: 'l-broad', match: ['pnpm test'] });
    // `l-broad` subsumes `h-narrow`, and only the learned clause is eligible to be dropped.
    expect(findSubsumptions([human, learned]).map(f => f.drop)).toEqual([]);
  });

  it('says nothing about a regex it did not emit', () => {
    const found = findSubsumptions([
      clause({ clauseId: 'a-re', match: ['/npm\\s+(test|run)/'] }),
      mined('b-npm-test', 'npm test'),
    ]);
    expect(found).toEqual([]);
    expect(subsumesMatcher(compileMatcher('/npm\\s+(test|run)/')!,
      compileMatcher(commandMatcher('npm test'))!)).toBeNull();
  });

  it('never proposes retiring a prose clause on the strength of it having no matchers', () => {
    const prose = clause({ clauseId: 'p-prose', match: [] });
    expect(findSubsumptions([mined('a-npm-test', 'npm test'), prose])).toEqual([]);
    expect(subsumesClause(mined('a-npm-test', 'npm test'), prose)).toBeNull();
  });

  // ---- the non-widening proof, asserted by the real evaluator rather than argued

  it('a merge cannot widen: the corpus decides the same calls with the dropped clause gone', () => {
    const corpus = [mined('a-npm-test', 'npm test'), mined('b-npm-test-watch', 'npm test --watch')];
    const found = findSubsumptions(corpus);
    expect(found).toHaveLength(1);
    // Fail-closed denies, because that is the traffic a green is learned from *and* the only traffic
    // a green's ablation can move: `RECORDED` injections replay a model-allowed call's own recorded
    // allow, so removing a green over an all-allow window reports zero whatever the clause does. That
    // trap is why the liveness assertion below exists — the first draft of this test passed against a
    // window in which nothing could ever change.
    const denied = { light: null, decision: 'deny' as const, clause: null, actor: 'timeout' as const };
    const records = [
      bash('npm test', { sessionId: 's-w1', ...denied }),
      bash('npm test --watch', { sessionId: 's-w2', ...denied }),
      bash('npm test --filter core', { sessionId: 's-w3', ...denied }),
      bash('npm run build', { sessionId: 's-w4', ...denied }),
    ];
    // Ablation is the runtime's own evaluator pointed backwards. Zero changes over a window that
    // exercises both clauses *and* a command only the kept one covers is set equality, not an
    // inequality: no allow is added and none is removed.
    const report = ablate(found[0].drop, corpus, records);
    expect(report.changed).toBe(0);
    // And the window is live rather than empty: removing the *kept* clause does move decisions, so
    // the zero above is a measurement rather than an artefact of nothing being replayed.
    expect(ablate(found[0].keep, corpus, records).changed).toBeGreaterThan(0);
  });

  it('a broad clause and its narrower exception at a different level are never merged', () => {
    // The case merging must never touch: the yellow exists precisely to withhold what the green
    // grants, and a merge here deletes the exception while looking like tidying.
    const green = mined('a-pnpm', 'pnpm test');
    const yellow = mined('b-pnpm-e2e', 'pnpm test --e2e', { level: 'yellow' });
    expect(findSubsumptions([green, yellow])).toEqual([]);
    // The containment itself is real — it is the level check that refuses, not a failed proof.
    expect(subsumesClause(green, yellow)).toBe('command-prefix');
  });

  it('never merges across tiers, because a missing tier is skipped rather than inherited', () => {
    const team = mined('a-team', 'pnpm test', { tier: 'team' });
    const user = mined('b-user', 'pnpm test --filter core', { tier: 'user' });
    expect(findSubsumptions([team, user])).toEqual([]);
  });

  it('a red containment is listed, never proposed, and carries RED_NOT_PROPOSED', () => {
    const found = findSubsumptions([
      mined('a-force', 'git push --force', { level: 'red' }),
      mined('b-force-origin', 'git push --force origin', { level: 'red' }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].proposed).toBe(false);
    expect(found[0].note).toContain(RED_NOT_PROPOSED);
  });

  // ---- the cycle #60 refuses to compile

  it('two clauses saying the same thing yield one finding, not a two-cycle', () => {
    const found = findSubsumptions([mined('b-second', 'pnpm test'), mined('a-first', 'pnpm test')]);
    expect(found.map(f => [f.keep, f.drop])).toEqual([['a-first', 'b-second']]);
  });

  it('the findings can never form a supersession cycle, and the real compiler agrees', () => {
    // A chain and an equal pair together: the shapes that would produce a ring if the direction or
    // the tie-break were wrong.
    const corpus = [
      mined('a-pnpm', 'pnpm test'),
      mined('b-pnpm-filter', 'pnpm test --filter core'),
      mined('c-pnpm-filter-cli', 'pnpm test --filter cli'),
      mined('d-pnpm-dup', 'pnpm test'),
    ];
    const found = findSubsumptions(corpus);
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) { expect(f.keep).not.toBe(f.drop); }
    // No clause is dropped twice, and no pair points both ways.
    expect(new Set(found.map(f => f.drop)).size).toBe(found.length);
    const edges = new Set(found.map(f => `${f.keep}->${f.drop}`));
    for (const f of found) { expect(edges.has(`${f.drop}->${f.keep}`)).toBe(false); }

    // And handed to the real compiler as the `supersedes` edges §8.3 would have written: #60 refuses
    // a cycle among accepted clauses, so a two-cycle in the findings fails here rather than in a
    // reviewer's PR. Nothing in this lane writes a `supersedes` — this is the stronger claim, that
    // even the shape it declined to emit would compile.
    const supersedesOf = (id: string): string[] =>
      found.filter(f => f.keep === id).map(f => f.drop);
    const result = compilePolicy({
      routing: { user: 'devon', project: '', team: '' },
      human: [],
      learned: corpus.map(c => learnedFile(c.clauseId, `/${c.patterns[0].raw}/`, supersedesOf(c.clauseId))),
      today: '2026-09-04',
      builtAt: '2026-09-04T00:00:00.000Z',
    });
    expect(result.errors).toEqual([]);
    expect(result.policy).not.toBeNull();
  });
});
