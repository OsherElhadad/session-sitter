import { describe, it, expect, vi } from 'vitest';

// ClaudeInspector imports 'vscode' and 'inspector' at load; stub the vscode part
// unused by the pure helper under test.
vi.mock('vscode', () => ({ extensions: { getExtension: vi.fn() } }));

import { parseClaudeOpenState } from '../agents/ClaudeInspector';

const EMPTY = { open: [], panels: [], states: [], active: null };

describe('parseClaudeOpenState', () => {
  it('keeps panels and states apart, and derives open as their union', () => {
    // `panels` = sessions open as editor panels; `states` = every session the
    // manager holds (side bar included). The split is what tells us WHERE a
    // session lives, so it must survive parsing.
    expect(parseClaudeOpenState('{"panels":["a"],"states":["a","b"],"active":"a"}')).toEqual({
      open: ['a', 'b'], panels: ['a'], states: ['a', 'b'], active: 'a',
    });
  });

  it('reports a side bar session as a state with no panel', () => {
    // The reported bug: this session is live but has no editor panel. Callers must
    // be able to see that, instead of a merged set that looks identical to "closed".
    expect(parseClaudeOpenState('{"panels":[],"states":["sidebar-sess"],"active":null}')).toEqual({
      open: ['sidebar-sess'], panels: [], states: ['sidebar-sess'], active: null,
    });
  });

  it('dedupes and drops empty/non-string entries in both arrays', () => {
    expect(parseClaudeOpenState('{"panels":["a","a","",1,null],"states":["b","b",false],"active":null}'))
      .toEqual({ open: ['a', 'b'], panels: ['a'], states: ['b'], active: null });
  });

  it('active is null when missing or not a non-empty string', () => {
    expect(parseClaudeOpenState('{"panels":[],"states":[]}')).toEqual(EMPTY);
    expect(parseClaudeOpenState('{"panels":[],"states":[],"active":""}')).toEqual(EMPTY);
  });

  it('treats missing arrays as empty rather than throwing', () => {
    expect(parseClaudeOpenState('{}')).toEqual(EMPTY);
    expect(parseClaudeOpenState('{"panels":"nope","states":42}')).toEqual(EMPTY);
  });

  it('returns empty state for non-string input (inspector failure)', () => {
    expect(parseClaudeOpenState(undefined)).toEqual(EMPTY);
  });

  it('returns empty state for malformed JSON', () => {
    expect(parseClaudeOpenState('nope')).toEqual(EMPTY);
  });
});
