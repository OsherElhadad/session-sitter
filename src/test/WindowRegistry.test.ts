import { describe, it, expect, vi } from 'vitest';
import { detectIdeCli } from '../WindowRegistry';

describe('detectIdeCli', () => {
  it('returns the remote-cli executable path when present (IBM Bob)', () => {
    const execPath = '/home/u/.bobide-server/bin/abc123/node';
    const readdir = vi.fn().mockReturnValue(['helpers', 'bobide', '.keep']);
    expect(detectIdeCli(execPath, 'IBM Bob', readdir)).toBe(
      '/home/u/.bobide-server/bin/abc123/bin/remote-cli/bobide',
    );
    expect(readdir).toHaveBeenCalledWith('/home/u/.bobide-server/bin/abc123/bin/remote-cli');
  });

  it('falls back to "bobide" by appName when remote-cli dir is unreadable', () => {
    const readdir = vi.fn(() => { throw new Error('ENOENT'); });
    expect(detectIdeCli('/usr/lib/code/node', 'IBM Bob', readdir)).toBe('bobide');
  });

  it('falls back to "code" for VS Code desktop', () => {
    const readdir = vi.fn(() => { throw new Error('ENOENT'); });
    expect(detectIdeCli('/usr/lib/code/node', 'Visual Studio Code', readdir)).toBe('code');
  });
});
