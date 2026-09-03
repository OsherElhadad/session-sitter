/**
 * The classifier rubric may only ask the model to weigh attributes the prompt actually
 * supplies. It named four attributes of a knowledge entry; `renderKnowledge` supplied one.
 */

import { describe, it, expect } from 'vitest';
import { buildSupervisionPrompt, renderKnowledge } from '../../supervisor/prompt';
import type { NormalizedSession } from '../../supervisor/transcript';
import { loadKnowledge, parseBottomLine } from '../../supervisor/knowledge';
import { PROJECT, TEAM, USER, bottomLine, makeKnowledgeRepo, makeTmpDir } from './fixtures';

const ENTRIES = parseBottomLine(bottomLine('team', 'team-b1', 'red'), 'team', 'f/bottom-line.md');

const SESSION = {
  sessionId: 's', source: 'test', turns: [], waitingReason: '', user: null,
  projectPath: '/p', projectName: 'p', status: 'waiting', approvalConfig: null,
  title: 't', pendingAction: null,
} as NormalizedSession;

const PROMPT = buildSupervisionPrompt(SESSION, {
  user: USER, project: PROJECT, team: TEAM, entries: ENTRIES, loadedFiles: [], missingFiles: [],
});

describe('renderKnowledge', () => {
  it('renders the tier, kind, id and level', () => {
    expect(renderKnowledge(ENTRIES)).toContain('[team] belief team-b1 level=red');
  });

  it('does not render the hand-typed entry confidence', () => {
    // The fixture file DOES carry a `confidence | high` row, so this can only pass by the
    // render dropping it, not by the parser losing it.
    expect(ENTRIES[0].confidence).toBe('high');
    expect(renderKnowledge(ENTRIES)).not.toContain('confidence');
  });
});

describe('the rubric names only what the render supplies', () => {
  it("keeps the model's own confidence, which gates the fast path", () => {
    expect(PROMPT).toContain('your confidence');
  });

  it('no longer asks the model to weigh entry attributes the prompt never emits', () => {
    for (const gone of [
      "each knowledge entry's scope/confidence",
      'recency/provenance',
      'judge its scope/confidence/recency',
      'recency', // no date is rendered anywhere, so recency is unreadable by construction
    ]) {
      expect(PROMPT).not.toContain(gone);
    }
    expect(PROMPT).toContain("each knowledge entry's scope,");
    expect(PROMPT).toContain('but judge its scope and the actual situation');
  });
});

describe('backward compatibility', () => {
  it('still loads every entry from bottom-line.md files carrying a confidence row', async () => {
    const root = makeKnowledgeRepo(makeTmpDir('prompt-compat-'));
    const bundle = await loadKnowledge({ user: USER, project: PROJECT, team: TEAM, localRepo: root });
    expect(bundle.entries.length).toBe(ENTRIES.length * 3);
    expect(bundle.entries.every(e => e.confidence !== null)).toBe(true);
  });
});
