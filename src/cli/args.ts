/**
 * Argument parsing for the `session-sitter` command.
 *
 * Hand-rolled, like `src/supervisor/cli.ts`, because this repo ships with zero runtime
 * dependencies and an option parser is a hundred lines. The spec-driven shape here (rather than
 * that CLI's switch statement) exists because four subcommands share a dozen flags, and a
 * per-command switch would drift the moment one of them grew a flag the others also want.
 *
 * Exit codes, which every command returns and `index.ts` passes to `process.exit`:
 *
 *   0  the command ran and printed its answer
 *   1  the command ran and something it needed was missing or unreadable
 *   2  the arguments were wrong — an unknown flag, a missing value, an unparseable time
 */

/** A failure with an exit code attached, so `main` never has to guess between 1 and 2. */
export class CliError extends Error {
  constructor(message: string, readonly exitCode: number = 2) {
    super(message);
    this.name = 'CliError';
  }
}

/**
 * What a flag carries.
 *
 * `optionalNumber` is `--watch [seconds]`: present alone it means "yes, with the default"; present
 * with a number it means that number. It cannot swallow the next argument blindly, or
 * `--watch --json` would consume `--json` as the interval.
 */
export type FlagKind = 'boolean' | 'string' | 'number' | 'optionalNumber';

export type FlagSpec = Readonly<Record<string, FlagKind>>;

export type FlagValue = string | number | boolean;

export interface ParsedArgs {
  flags: Readonly<Record<string, FlagValue>>;
  /** Everything that was not a flag, in the order it was given. */
  positional: readonly string[];
}

/** Is this token a flag rather than a value? A negative number is a value. */
function isFlag(token: string | undefined): boolean {
  return token !== undefined && token.startsWith('-') && !/^-?\d+(\.\d+)?$/.test(token);
}

function toNumber(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) { throw new CliError(`${flag} needs a number, got "${raw}"`); }
  return n;
}

/**
 * Parse `argv` against `spec`. Accepts both `--flag value` and `--flag=value`, and the single-dash
 * aliases the spec declares (`-h` is declared like any other name).
 *
 * Unknown flags are an error rather than a positional: a typo that silently becomes a filename is
 * the failure mode where a CLI reports the wrong answer confidently.
 */
export function parseFlags(argv: readonly string[], spec: FlagSpec): ParsedArgs {
  const flags: Record<string, FlagValue> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!isFlag(token)) { positional.push(token); continue; }

    const eq = token.indexOf('=');
    const name = eq >= 0 ? token.slice(0, eq) : token;
    const inlineValue = eq >= 0 ? token.slice(eq + 1) : undefined;
    const kind = spec[name];
    if (kind === undefined) { throw new CliError(`unknown option: ${name}`); }

    if (kind === 'boolean') {
      if (inlineValue !== undefined) { throw new CliError(`${name} takes no value`); }
      flags[name] = true;
      continue;
    }

    if (kind === 'optionalNumber') {
      if (inlineValue !== undefined) { flags[name] = toNumber(name, inlineValue); continue; }
      // Consume the next token only when it actually is a number. Anything else — a flag, a
      // subcommand, a path — belongs to whoever comes next, and guessing here would make
      // `--watch` swallow it.
      const next = argv[i + 1];
      if (next !== undefined && /^\d+(\.\d+)?$/.test(next)) {
        flags[name] = toNumber(name, argv[++i]);
      } else {
        flags[name] = true;
      }
      continue;
    }

    const value = inlineValue ?? (isFlag(argv[i + 1]) ? undefined : argv[++i]);
    if (value === undefined) { throw new CliError(`${name} needs a value`); }
    flags[name] = kind === 'number' ? toNumber(name, value) : value;
  }

  return { flags, positional };
}

// ── Reading a parsed flag ───────────────────────────────────────────────────
// Small readers rather than a generic type parameter: every call site knows which kind it asked
// for, and the alternative is a cast at each one.

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const v = args.flags[name];
  return typeof v === 'number' ? v : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] !== undefined;
}
