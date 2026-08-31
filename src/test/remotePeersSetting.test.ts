import { describe, expect, it, vi } from 'vitest';
import { remotePeersEnabled } from '../SessionManager';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
    createFileSystemWatcher: () => ({
      onDidCreate: vi.fn(), onDidChange: vi.fn(), onDidDelete: vi.fn(), dispose: vi.fn(),
    }),
  },
  RelativePattern: class { constructor(public base: unknown, public pattern: string) {} },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  EventEmitter: class { event = vi.fn(); fire = vi.fn(); dispose = vi.fn(); },
}));

// The kill switch. `off` must mean the extension opens no SSH connection at all, and anything we
// cannot read must mean the same — we do not reach out from a host we could not ask for consent.

describe('remotePeersEnabled', () => {
  it('is on by default when the setting is unset', () => {
    expect(remotePeersEnabled(() => undefined)).toBe(true);
  });

  it('is on for an explicit auto', () => {
    expect(remotePeersEnabled(() => 'auto')).toBe(true);
  });

  it('is off for off', () => {
    expect(remotePeersEnabled(() => 'off')).toBe(false);
  });

  it('fails closed when reading the setting throws', () => {
    // An unexpected host, or a configuration API that is absent: do the least, not the most.
    expect(remotePeersEnabled(() => { throw new Error('no configuration api'); })).toBe(false);
  });
});
