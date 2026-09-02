import { describe, it, expect } from 'vitest';
import {
  clauseIdFor,
  clauseMatches,
  findMatchingClause,
  parsePractices,
  rankClauses,
} from '../../policy/practices';
import type { KnowledgeEntry } from '../../supervisor/knowledge';

const PRACTICES = `
# Bottom line — platform

## Intentions

### Intention: Never force-push to a shared branch

| Field | Value |
|---|---|
| id | team-git-002 |
| level | red |
| tags | git, history |

Match: \`git push --force\`, \`/git\\s+push\\b.*--delete/\`

Rewriting history on a branch other people build on destroys their work.

---

### Intention: 4. Reading the repository never needs approval

| Field | Value |
|---|---|
| level | green |

Match: npm test

Tests are read-only with respect to anything that matters.

---

### Belief: Secrets are referenced by environment variable

| Field | Value |
|---|---|
| id | team-sec-001 |
| level | red |

No Match line, so this clause informs the classifier but cannot deny on its own.
`;

const entry = (over: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({
  kind: 'intention', title: 'A title', tier: 'team', text: '', id: null, source: null,
  confidence: null, scope: null, added: null, updated: null, tags: [], level: null,
  supersedes: null, expires: null, sourceFile: null, ...over,
});

describe('clauseIdFor', () => {
  it('prefers the explicit id field', () => {
    expect(clauseIdFor(entry({ id: 'team-git-002', title: '4. Something' }))).toBe('team-git-002');
  });
  it('falls back to a self-numbering heading', () => {
    expect(clauseIdFor(entry({ title: '4. Never force-push' }))).toBe('4');
    expect(clauseIdFor(entry({ title: '§7 Never force-push' }))).toBe('7');
  });
  it('falls back to a slug of the title', () => {
    expect(clauseIdFor(entry({ title: 'Never force-push to a shared branch' })))
      .toBe('never-force-push-to-a-shared-branch');
  });
  it('never produces an empty id', () => {
    expect(clauseIdFor(entry({ title: '!!!' }))).toBe('unnamed');
  });
});

describe('parsePractices', () => {
  const clauses = parsePractices(PRACTICES, 'team', 'team/bottom-line.md');

  it('reads every entry as a clause', () => {
    expect(clauses).toHaveLength(3);
  });

  it('builds a citation from the clause id', () => {
    expect(clauses[0].citation).toBe('practices §team-git-002');
    expect(clauses[1].citation).toBe('practices §4');
  });

  it('normalizes the level', () => {
    expect(clauses.map(c => c.level)).toEqual(['red', 'green', 'red']);
  });

  it('lifts the Match line out of the prose', () => {
    expect(clauses[0].text).not.toContain('Match:');
    expect(clauses[0].text).toContain('destroys their work');
  });

  it('compiles both substring and regex patterns', () => {
    expect(clauses[0].patterns).toHaveLength(2);
    expect(clauseMatches(clauses[0], 'Bash {"command":"git push --force origin main"}')).toBe(true);
    expect(clauseMatches(clauses[0], 'Bash {"command":"git push --delete origin x"}')).toBe(true);
  });

  it('loosens whitespace in a substring pattern', () => {
    expect(clauseMatches(clauses[0], 'git  push   --force')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(clauseMatches(clauses[0], 'GIT PUSH --FORCE')).toBe(true);
  });

  it('leaves a clause with no Match line unmatchable', () => {
    expect(clauses[2].patterns).toEqual([]);
    expect(clauseMatches(clauses[2], 'anything at all, including secrets')).toBe(false);
  });

  it('records the tier and source file', () => {
    expect(clauses[0].tier).toBe('team');
    expect(clauses[0].sourceFile).toBe('team/bottom-line.md');
  });

  it('drops an unparseable regex instead of throwing', () => {
    const broken = parsePractices('### Intention: Bad\n\nMatch: `/(/`\n');
    expect(broken[0].patterns).toEqual([]);
  });

  it('keeps a comma inside a backticked pattern', () => {
    const commad = parsePractices('### Intention: X\n\nMatch: `chmod 777 a,b`\n');
    expect(commad[0].patterns).toHaveLength(1);
    expect(clauseMatches(commad[0], 'chmod 777 a,b')).toBe(true);
  });
});

describe('rankClauses', () => {
  it('puts the narrower tier first', () => {
    const ranked = rankClauses([
      { ...parsePractices('### Intention: T\n')[0], tier: 'team' },
      { ...parsePractices('### Intention: U\n')[0], tier: 'user' },
      { ...parsePractices('### Intention: P\n')[0], tier: 'project' },
    ]);
    expect(ranked.map(c => c.tier)).toEqual(['user', 'project', 'team']);
  });
});

describe('findMatchingClause', () => {
  const clauses = parsePractices(PRACTICES, 'team');

  it('finds a matching red clause', () => {
    const hit = findMatchingClause(clauses, 'git push --force', 'red');
    expect(hit?.citation).toBe('practices §team-git-002');
  });

  it('finds a matching green clause when asked for green', () => {
    expect(findMatchingClause(clauses, 'npm test', 'green')?.citation).toBe('practices §4');
  });

  it('does not return a green clause when asked for red', () => {
    expect(findMatchingClause(clauses, 'npm test', 'red')).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(findMatchingClause(clauses, 'ls -la', 'red')).toBeNull();
  });

  it('prefers the narrower tier when two clauses match', () => {
    const team = parsePractices('### Intention: Team rule\n\n| Field | Value |\n|---|---|\n'
      + '| level | red |\n\nMatch: rm -rf\n', 'team');
    const user = parsePractices('### Intention: User rule\n\n| Field | Value |\n|---|---|\n'
      + '| level | red |\n\nMatch: rm -rf\n', 'user');
    expect(findMatchingClause([...team, ...user], 'rm -rf build', 'red')?.title)
      .toBe('User rule');
  });
});
