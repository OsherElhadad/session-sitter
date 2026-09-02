import { describe, it, expect } from 'vitest';
import { BUILD_VERSION } from '../../buildInfo';
import { main, runMain } from '../../cli/index';
import { fakeIo } from './fakeIo';

// The whole point of the `require.main === module` guard in index.ts: importing it must not run it.
describe('top-level dispatch', () => {
  it('lists every command in the top-level help', async () => {
    const io = fakeIo();
    expect(await main(['--help'], io)).toBe(0);
    for (const command of ['status', 'log', 'digest', 'policy']) {
      expect(io.text()).toContain(command);
    }
  });

  it('exits 2 with usage on stderr when given no command at all', async () => {
    const io = fakeIo();
    // Usage goes to stderr here because nothing was asked for — stdout stays clean for a pipe.
    expect(await main([], io)).toBe(2);
    expect(io.errText()).toContain('Usage:');
    expect(io.text()).toBe('');
  });

  it('exits 2 on an unknown command, and says which', async () => {
    const io = fakeIo();
    expect(await main(['statsu'], io)).toBe(2);
    expect(io.errText()).toContain('unknown command "statsu"');
  });

  it('prints the version from buildInfo', async () => {
    for (const flag of ['-v', '--version']) {
      const io = fakeIo();
      expect(await main([flag], io)).toBe(0);
      expect(io.text()).toContain(BUILD_VERSION);
    }
  });

  it('passes a command its own flags, not the top-level ones', async () => {
    const io = fakeIo();
    expect(await main(['log', '--help'], io)).toBe(0);
    expect(io.text()).toContain('session-sitter log');
  });
});

describe('runMain', () => {
  it('turns a bad argument into exit 2 and one line on stderr', async () => {
    const io = fakeIo();
    expect(await runMain(['status', '--nonsense'], io)).toBe(2);
    expect(io.errText()).toBe('session-sitter: unknown option: --nonsense\n');
  });

  it('turns a missing practices parser into exit 1', async () => {
    const io = fakeIo();
    // The parser lives in src/policy/, which is built separately; this is the seam reporting itself.
    expect(await runMain(['policy', 'check', 'PRACTICES.md'], io)).toBe(1);
    expect(io.errText()).toMatch(/practices parser is not installed|cannot read/);
  });

  it('reports an unexpected failure with its stack rather than swallowing it', async () => {
    const io = fakeIo();
    const exploding = { ...io, now: () => { throw new Error('clock exploded'); } };
    expect(await runMain(['status', '--json'], exploding)).toBe(1);
    expect(io.errText()).toContain('clock exploded');
    expect(io.errText()).toContain('at ');
  });
});
