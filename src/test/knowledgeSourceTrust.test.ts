import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The knowledge source must never default to the supervised workspace.
 *
 * `sessionSitter.dataRepoPath` names a corpus repo, and the highest-precedence knowledge tier is
 * read from it. The workspace is the one tree the supervised agent can write — so a fallback from
 * the corpus to the workspace let an agent write the clauses that govern its own next tool call,
 * at the tier that outranks the team's. With no source configured, supervision classifies without
 * BDI (`Orchestrator.loadKnowledgeFor` handles an unrouted session already), which is the same
 * never-substitute-a-guess rule the slug routing follows.
 *
 * This is a source-shape guard because the wiring lives in `activate()`, which needs a real
 * extension host to run. Crude, and the only thing that catches the fallback being reintroduced
 * for convenience — the same reason WebviewStyles.test.ts reads its stylesheet.
 */
describe('knowledge source is never the supervised workspace', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension.ts'), 'utf8');
  // Comments explain the ban, so they must not be searched for it.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('does not fall back to workspaceRoot when assigning knowledgeLocalRepo', () => {
    const assignments = [...code.matchAll(/knowledgeLocalRepo\s*:\s*([^,\n}]+)/g)]
      .map(m => m[1].trim());
    for (const rhs of assignments) {
      expect(rhs, `knowledgeLocalRepo assigned from ${JSON.stringify(rhs)}`)
        .not.toMatch(/workspaceRoot/);
    }
  });

  it('says so when nothing is configured, rather than guessing a source', () => {
    expect(code).toMatch(/no knowledge source configured/);
  });
});
