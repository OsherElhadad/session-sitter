#!/usr/bin/env node
/**
 * CLI entrypoint for the runtime supervisor — the TypeScript replacement for `supervise.py`.
 *
 *     node out/supervisor/cli.js <session_id> [--user U --project P --team T] [--transcript PATH]
 *     node out/supervisor/cli.js poll [--loop SECONDS]
 *
 * `run <session_id>` runs one classification pass over a paused session (whose transcript the
 * extension has exported to `<stateDir>/history/<id>.json`) and acts on the result. Orange
 * notifies + persists + exits. `poll` resumes pending records: it correlates user replies and
 * applies the timeout → Yellow fallback. Both are idempotent and restart-safe.
 *
 * The extension normally does all of this in-process (`SupervisionService`); this CLI exists for
 * offline runs, manual replays, and debugging, and keeps the same argument contract the Python
 * entrypoint had.
 *
 * Prints the resulting record(s) as JSON to stdout.
 */

import { SupervisionRecord } from './models';
import { LoadConfigOverrides, SupervisorConfig, loadConfig } from './config';
import { buildOrchestrator } from './factory';
import { Orchestrator } from './orchestrator';

interface Args {
  command: 'run' | 'poll';
  sessionId?: string;
  user?: string;
  project?: string;
  team?: string;
  transcript?: string;
  workspaceRoot?: string;
  stateDir?: string;
  loop: number;
}

const USAGE = `supervise — runtime supervisor for coding-agent sessions

Usage:
  supervise run <session_id> [options]
  supervise <session_id> [options]            (shorthand for "run")
  supervise poll [--loop SECONDS] [options]

Options:
  --user U --project P --team T   knowledge-routing triple
  --transcript PATH               read a transcript export directly (offline runs)
  --workspace-root PATH           workspace root (default: cwd)
  --state-dir PATH                supervision state dir (default: <root>/.supervisor-state)
  --loop SECONDS                  poll: repeat every N seconds (0 = one pass)
  -h, --help                      show this help
`;

/** Allow `supervise <session_id>` as shorthand for `supervise run <session_id>`. */
export function normalizeArgv(argv: string[]): string[] {
  if (argv.length && !['run', 'poll', '-h', '--help'].includes(argv[0]) && !argv[0].startsWith('-')) {
    return ['run', ...argv];
  }
  return argv;
}

export function parseArgs(argv: string[]): Args {
  const norm = normalizeArgv(argv);
  if (norm.length === 0 || norm[0] === '-h' || norm[0] === '--help') {
    process.stdout.write(USAGE);
    process.exit(norm.length === 0 ? 2 : 0);
  }
  const command = norm[0];
  if (command !== 'run' && command !== 'poll') {
    throw new Error(`unknown command: ${command}\n\n${USAGE}`);
  }
  const args: Args = { command, loop: 0 };
  const rest = norm.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = (): string => {
      const v = rest[++i];
      if (v === undefined) { throw new Error(`${a} needs a value`); }
      return v;
    };
    switch (a) {
      case '--user': args.user = next(); break;
      case '--project': args.project = next(); break;
      case '--team': args.team = next(); break;
      case '--transcript': args.transcript = next(); break;
      case '--workspace-root': case '--repo-root': args.workspaceRoot = next(); break;
      case '--state-dir': args.stateDir = next(); break;
      case '--loop': args.loop = Number.parseInt(next(), 10) || 0; break;
      default:
        if (a.startsWith('-')) { throw new Error(`unknown option: ${a}\n\n${USAGE}`); }
        if (args.sessionId === undefined) { args.sessionId = a; } else {
          throw new Error(`unexpected argument: ${a}`);
        }
    }
  }
  if (command === 'run' && !args.sessionId) { throw new Error('run needs a <session_id>'); }
  return args;
}

function configFrom(args: Args): SupervisorConfig {
  const overrides: LoadConfigOverrides = {
    workspaceRoot: args.workspaceRoot,
    stateDir: args.stateDir,
  };
  return loadConfig(overrides);
}

function printRecord(record: SupervisionRecord): void {
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}

async function cmdRun(args: Args): Promise<number> {
  const orch = buildOrchestrator({
    config: configFrom(args),
    transcriptOverride: args.transcript,
    log: msg => process.stderr.write(`${msg}\n`),
  });
  const record = await orch.supervise(args.sessionId!, {
    user: args.user, project: args.project, team: args.team,
  });
  printRecord(record);
  return record.state === 'failed' ? 1 : 0;
}

async function onePass(orch: Orchestrator): Promise<void> {
  const processed = await orch.poll();
  await orch.refreshTimers(); // tick countdowns (Telegram); no-op for the stub
  process.stdout.write(`${JSON.stringify({
    processed: processed.map(r => r.request_id), count: processed.length,
  })}\n`);
}

async function cmdPoll(args: Args): Promise<number> {
  const orch = buildOrchestrator({
    config: configFrom(args),
    log: msg => process.stderr.write(`${msg}\n`),
  });
  // Clear any stale webhook once so getUpdates can consume taps/replies.
  await orch.channel.ensurePollingReady?.();

  if (args.loop > 0) {
    process.stderr.write('supervise poll: loop started, consuming updates\n');
    for (;;) {
      // A single bad pass (transient API/parse error) must never kill the loop — otherwise
      // taps/replies stop being consumed and every decision silently times out.
      try {
        await onePass(orch);
      } catch (err) {
        process.stderr.write(`supervise poll: pass error (continuing): ${String(err)}\n`);
      }
      await new Promise<void>(r => setTimeout(r, args.loop * 1000));
    }
  }
  await onePass(orch);
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  return args.command === 'poll' ? cmdPoll(args) : cmdRun(args);
}

// Only run when invoked directly, so tests can import the module.
if (require.main === module) {
  main().then(
    code => process.exit(code),
    err => { process.stderr.write(`${String(err)}\n`); process.exit(1); },
  );
}
