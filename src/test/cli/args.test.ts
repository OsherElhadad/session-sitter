import { describe, it, expect } from 'vitest';
import { CliError, flagBool, flagNumber, flagString, parseFlags, type FlagSpec } from '../../cli/args';

const SPEC: FlagSpec = {
  '--name': 'string',
  '--limit': 'number',
  '--json': 'boolean',
  '--watch': 'optionalNumber',
};

describe('parseFlags', () => {
  it('reads a value as a separate argument and as --flag=value', () => {
    expect(flagString(parseFlags(['--name', 'Bash'], SPEC), '--name')).toBe('Bash');
    expect(flagString(parseFlags(['--name=Bash'], SPEC), '--name')).toBe('Bash');
  });

  it('keeps positionals in the order they were given', () => {
    const args = parseFlags(['check', 'PRACTICES.md', '--json'], SPEC);
    expect(args.positional).toEqual(['check', 'PRACTICES.md']);
    expect(flagBool(args, '--json')).toBe(true);
  });

  it('rejects an unknown flag rather than treating it as a positional', () => {
    // A typo that silently becomes a filename is how a CLI reports the wrong answer confidently.
    expect(() => parseFlags(['--nmae', 'Bash'], SPEC)).toThrow(/unknown option: --nmae/);
    expect(() => parseFlags(['--nmae'], SPEC)).toThrow(CliError);
  });

  it('rejects a value-taking flag with no value', () => {
    expect(() => parseFlags(['--name'], SPEC)).toThrow(/--name needs a value/);
    // The next flag is not a value either, however much it looks like one.
    expect(() => parseFlags(['--name', '--json'], SPEC)).toThrow(/--name needs a value/);
  });

  it('rejects a value on a boolean flag', () => {
    expect(() => parseFlags(['--json=yes'], SPEC)).toThrow(/--json takes no value/);
  });

  it('rejects a non-number where a number is required', () => {
    expect(() => parseFlags(['--limit', 'lots'], SPEC)).toThrow(/--limit needs a number/);
  });

  it('treats a negative number as a value, not a flag', () => {
    expect(flagNumber(parseFlags(['--limit', '-5'], SPEC), '--limit')).toBe(-5);
  });

  describe('optionalNumber', () => {
    it('is true when given alone', () => {
      expect(parseFlags(['--watch'], SPEC).flags['--watch']).toBe(true);
    });

    it('takes the number when one follows', () => {
      expect(flagNumber(parseFlags(['--watch', '2'], SPEC), '--watch')).toBe(2);
      expect(flagNumber(parseFlags(['--watch=2'], SPEC), '--watch')).toBe(2);
    });

    it('does not swallow the following flag as its interval', () => {
      const args = parseFlags(['--watch', '--json'], SPEC);
      expect(args.flags['--watch']).toBe(true);
      expect(flagBool(args, '--json')).toBe(true);
    });

    it('does not swallow a following positional', () => {
      const args = parseFlags(['--watch', 'check'], SPEC);
      expect(args.flags['--watch']).toBe(true);
      expect(args.positional).toEqual(['check']);
    });
  });

  it('reports an absent flag as absent, not as a default', () => {
    const args = parseFlags([], SPEC);
    expect(flagString(args, '--name')).toBeUndefined();
    expect(flagNumber(args, '--limit')).toBeUndefined();
    expect(flagBool(args, '--json')).toBe(false);
  });
});

describe('CliError', () => {
  it('defaults to exit 2 — the code for a bad argument', () => {
    expect(new CliError('nope').exitCode).toBe(2);
    expect(new CliError('missing thing', 1).exitCode).toBe(1);
  });
});
