#!/usr/bin/env node
/**
 * `session-sitter` — the terminal front end.
 *
 * Session Sitter's engine was built host-free (`src/supervisor/*` has no `import 'vscode'` in
 * 4,659 lines), and session reading now is too (`src/sessionScan.ts`). This command is the second
 * front end over it, for the people who never open the IDE panel: the worklist, the audit trail of
 * supervision decisions, an overnight digest, and a linter for the practices file.
 *
 *     session-sitter status              every session, and which of them need you
 *     session-sitter log                 the audit trail of supervision decisions
 *     session-sitter digest              what your agents did last night
 *     session-sitter policy check        lint a practices file, replay decisions against it
 *     session-sitter learn               propose practices from the decision trail
 *
 * Exit codes are uniform across every command: 0 answered, 1 something it needed was missing or
 * unreadable, 2 the arguments were wrong.
 */

import { BUILD_TIME, BUILD_VERSION } from '../buildInfo';
import { CliError } from './args';
import { processIo, type Io } from './render';
import * as digest from './digest';
import * as learn from './learn';
import * as log from './log';
import * as policy from './policy';
import * as status from './status';

interface Command {
  summary: string;
  run(argv: readonly string[], io: Io): Promise<number>;
}

const COMMANDS: Readonly<Record<string, Command>> = {
  status: { summary: 'every agent session, and which of them need you', run: status.run },
  log: { summary: 'query the audit trail of supervision decisions', run: log.run },
  digest: { summary: 'what your agents did last night, one page per session', run: digest.run },
  policy: { summary: 'lint a practices file and replay decisions against it', run: policy.run },
  learn: { summary: 'propose practices from the decision trail — no model, ever', run: learn.run },
};

const USAGE = `session-sitter — agent governance in the terminal

Usage:
  session-sitter <command> [options]

Commands:
${Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(8)}${c.summary}`).join('\n')}

Options:
  -h, --help      show this help, or a command's help after its name
  -v, --version   print the version

Run \`session-sitter <command> --help\` for a command's flags. Every command supports --json.
`;

export async function main(argv: readonly string[], io: Io = processIo()): Promise<number> {
  const [name, ...rest] = argv;

  if (name === undefined) { io.err(USAGE); return 2; }
  if (name === '-h' || name === '--help') { io.out(USAGE); return 0; }
  if (name === '-v' || name === '--version') {
    io.out(`session-sitter ${BUILD_VERSION} (built ${BUILD_TIME})\n`);
    return 0;
  }

  const command = COMMANDS[name];
  if (command === undefined) {
    io.err(`session-sitter: unknown command "${name}"\n\n${USAGE}`);
    return 2;
  }
  return command.run(rest, io);
}

/**
 * Turn any failure into an exit code and one line on stderr.
 *
 * A `CliError` carries its own code and is the user's mistake, so it prints alone. Anything else is
 * ours, and prints with its stack — a governance tool that swallows its own bugs is a tool you
 * cannot trust the output of.
 */
export async function runMain(argv: readonly string[], io: Io = processIo()): Promise<number> {
  try {
    return await main(argv, io);
  } catch (err) {
    if (err instanceof CliError) {
      io.err(`session-sitter: ${err.message}\n`);
      return err.exitCode;
    }
    io.err(`session-sitter: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    return 1;
  }
}

// Only run when invoked directly, so tests can import the module.
if (require.main === module) {
  void runMain(process.argv.slice(2)).then(code => process.exit(code));
}
