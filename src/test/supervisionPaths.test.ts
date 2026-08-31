import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { resolveStateDir, resolveWorkspaceRoot } from '../supervisionPaths';

// A deterministic auto-respond decision must be recorded on a DEFAULT install — no setting
// required. `supervisorStateDir` used to gate every reporting destination, so with it unset the
// rules still fired but nothing reached the activity feed or Telegram. These tests pin the split:
// the state dir always resolves; `explicit` (which is what still gates the AI supervisor) does not.
describe('resolveStateDir', () => {
  const storage = '/home/u/.config/Code/globalStorage/eranra.session-sitter';

  it('falls back to <globalStorage>/state when the setting is unset', () => {
    expect(resolveStateDir(undefined, storage))
      .toEqual({ dir: path.join(storage, 'state'), explicit: false });
  });

  it('treats an empty or whitespace-only setting as unset', () => {
    expect(resolveStateDir('', storage).explicit).toBe(false);
    expect(resolveStateDir('   ', storage).explicit).toBe(false);
    expect(resolveStateDir('   ', storage).dir).toBe(path.join(storage, 'state'));
  });

  it('uses the configured dir, trimmed, and marks it explicit', () => {
    expect(resolveStateDir('  /srv/state  ', storage))
      .toEqual({ dir: '/srv/state', explicit: true });
  });
});

describe('resolveWorkspaceRoot', () => {
  const storage = '/home/u/.config/Code/globalStorage/eranra.session-sitter';
  const explicitDir = resolveStateDir('/repo/supervisor/.state', storage);
  const defaultedDir = resolveStateDir('', storage);

  it('prefers an explicitly configured repo path', () => {
    expect(resolveWorkspaceRoot('/repo', explicitDir, '/ws')).toBe('/repo');
    expect(resolveWorkspaceRoot('  /repo  ', defaultedDir, '/ws')).toBe('/repo');
  });

  it('derives the root from an EXPLICIT state dir', () => {
    expect(resolveWorkspaceRoot('', explicitDir, '/ws')).toBe('/repo/supervisor');
  });

  it('never derives a root from a DEFAULTED state dir — global storage is not a repo', () => {
    expect(resolveWorkspaceRoot('', defaultedDir, '/ws')).toBe('/ws');
  });

  it('returns empty when nothing identifies a root (the supervisor then stays off)', () => {
    expect(resolveWorkspaceRoot(undefined, defaultedDir, undefined)).toBe('');
  });
});
