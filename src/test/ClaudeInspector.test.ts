import { describe, it, expect, vi } from 'vitest';

// ClaudeInspector imports 'vscode' and 'inspector' at load; stub the vscode part
// unused by the pure helper under test.
vi.mock('vscode', () => ({ extensions: { getExtension: vi.fn() } }));

import { parseClaudeOpenState } from '../agents/ClaudeInspector';

describe('parseClaudeOpenState', () => {
  it('parses open ids and active id', () => {
    expect(parseClaudeOpenState('{"open":["a","b"],"active":"a"}')).toEqual({ open: ['a', 'b'], active: 'a' });
  });

  it('dedupes and drops empty/non-string open entries', () => {
    expect(parseClaudeOpenState('{"open":["a","a","",1,null,"b"],"active":null}'))
      .toEqual({ open: ['a', 'b'], active: null });
  });

  it('active is null when missing or not a non-empty string', () => {
    expect(parseClaudeOpenState('{"open":[]}')).toEqual({ open: [], active: null });
    expect(parseClaudeOpenState('{"open":[],"active":""}')).toEqual({ open: [], active: null });
  });

  it('returns empty state for non-string input (inspector failure)', () => {
    expect(parseClaudeOpenState(undefined)).toEqual({ open: [], active: null });
  });

  it('returns empty state for malformed JSON', () => {
    expect(parseClaudeOpenState('nope')).toEqual({ open: [], active: null });
  });
});
