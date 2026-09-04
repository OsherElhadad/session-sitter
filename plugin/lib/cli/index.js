#!/usr/bin/env node
// GENERATED FILE — DO NOT EDIT.
// Compiled from src/cli/index.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
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
 *     session-sitter policy explain      what would happen to this call, and which clause decides
 *     session-sitter export --html       the trail as one self-contained snapshot to send someone
 *
 * Exit codes are uniform across every command: 0 answered, 1 something it needed was missing or
 * unreadable, 2 the arguments were wrong.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.main = main;
exports.runMain = runMain;
const buildInfo_1 = require("../buildInfo");
const args_1 = require("./args");
const render_1 = require("./render");
const digest = __importStar(require("./digest"));
const exportCmd = __importStar(require("./export"));
const learn = __importStar(require("./learn"));
const log = __importStar(require("./log"));
const policy = __importStar(require("./policy"));
const status = __importStar(require("./status"));
const COMMANDS = {
    status: { summary: 'every agent session, and which of them need you', run: status.run },
    log: { summary: 'query the audit trail of supervision decisions', run: log.run },
    digest: { summary: 'what your agents did last night, one page per session', run: digest.run },
    policy: { summary: 'lint a practices file, or ask what it would decide', run: policy.run },
    learn: { summary: 'propose practices from the decision trail — no model, ever', run: learn.run },
    export: {
        summary: 'the decision trail as ndjson, or as one self-contained HTML snapshot',
        run: exportCmd.run,
    },
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
async function main(argv, io = (0, render_1.processIo)()) {
    const [name, ...rest] = argv;
    if (name === undefined) {
        io.err(USAGE);
        return 2;
    }
    if (name === '-h' || name === '--help') {
        io.out(USAGE);
        return 0;
    }
    if (name === '-v' || name === '--version') {
        // A plugin install has no build time — it is a git ref cloned into place, not a build — and
        // `scripts/build-plugin-lib.js` empties the field rather than shipping the moment a maintainer
        // ran `make plugin`. Printing `(built )` would be worse than printing nothing.
        io.out(buildInfo_1.BUILD_TIME
            ? `session-sitter ${buildInfo_1.BUILD_VERSION} (built ${buildInfo_1.BUILD_TIME})\n`
            : `session-sitter ${buildInfo_1.BUILD_VERSION}\n`);
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
async function runMain(argv, io = (0, render_1.processIo)()) {
    try {
        return await main(argv, io);
    }
    catch (err) {
        if (err instanceof args_1.CliError) {
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
