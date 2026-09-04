// GENERATED FILE — DO NOT EDIT.
// Compiled from src/cli/policy.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * `session-sitter policy check` — lint a practices file, and replay real decisions against it.
 *
 * ## The seam
 *
 * The practices parser lives in `src/policy/` and is built separately. This module deliberately
 * does **not** parse a practices file: a second parser would have to be deleted the day the first
 * one lands, and until then the two would disagree about what a clause is — which is precisely the
 * failure a citable clause exists to prevent.
 *
 * So the contract is stated here as `PolicyModule` and loaded at runtime. When the parser is
 * absent, the command says so and exits 1; it never falls back to a guess. Everything in this file
 * is reading and reporting: which clauses were found, what could not be parsed, and which of the
 * last N real decisions a policy edit would change.
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
exports.clauseOf = exports.HELP = exports.PRACTICES_CANDIDATES = void 0;
exports.loadPolicyModule = loadPolicyModule;
exports.findPracticesFile = findPracticesFile;
exports.replay = replay;
exports.run = run;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const audit_1 = require("./audit");
const args_1 = require("./args");
const log_1 = require("./log");
Object.defineProperty(exports, "clauseOf", { enumerable: true, get: function () { return log_1.clauseOf; } });
const render_1 = require("./render");
const explain_1 = require("../policy/explain");
// The write path and the ablation report live in the policy module's own CLI. They are forwarded
// rather than reimplemented, for the same reason `explain` is — see the dispatcher below.
const cli_1 = require("../policy/cli");
/** Where the parser is expected to live, relative to this module in `out/`. */
const POLICY_MODULE = '../policy';
/**
 * Load the parser, or return why it could not be loaded.
 *
 * A variable path on purpose: a static import would make this file fail to compile until the parser
 * exists, which would couple two independently built pieces at build time for no benefit at run
 * time.
 */
function loadPolicyModule(specifier = POLICY_MODULE) {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require(specifier);
        if (typeof mod.parsePractices !== 'function') {
            return `${specifier} does not export parsePractices(source, path)`;
        }
        return mod;
    }
    catch (err) {
        return `the practices parser is not installed (${specifier}): ${err instanceof Error ? err.message : String(err)}`;
    }
}
// ── Finding the practices file ──────────────────────────────────────────────
/** Where a practices file conventionally lives, in the order they are tried. */
exports.PRACTICES_CANDIDATES = [
    'PRACTICES.md',
    'practices.md',
    path.join('docs', 'PRACTICES.md'),
    path.join('.claude', 'PRACTICES.md'),
];
function findPracticesFile(cwd, exists = fs.existsSync) {
    for (const candidate of exports.PRACTICES_CANDIDATES) {
        const full = path.join(cwd, candidate);
        if (exists(full)) {
            return full;
        }
    }
    return undefined;
}
// ── The command ─────────────────────────────────────────────────────────────
exports.HELP = `session-sitter policy — lint, compile, and ask what a practices file decides

Usage:
  session-sitter policy check [PATH] [options]
  session-sitter policy explain <tool> [--command CMD | --input JSON] [--rev REV] [--json]
  session-sitter policy compile [--corpus DIR] [--user U] [--project P] [--team T]
                                [--registry FILE] [--data-dir DIR] [--dry-run]
  session-sitter policy ablate [--data-dir DIR] [--decisions N] [--days N]

Arguments:
  PATH              the practices file. Defaults to the first of
                    ${exports.PRACTICES_CANDIDATES.join(', ')} that exists.

Options:
  --replay N        re-decide the last N real decisions against this policy and report which
                    would change, so an edit can be reviewed before it ships
  --state-dir PATH  read this state dir for --replay instead of searching for one
  --json            machine-readable output (see docs/CLI.md for the contract)
  -h, --help        show this help

compile publishes the versioned artifact the runtime loads, and is what puts a revision on every
decision record: without it rev is null and "explain --rev" has nothing to resolve. ablate
re-decides the recorded window with each clause removed, so a clause that changes nothing is a
retirement candidate with evidence. Both take their own flags — run them with --help.

Exit codes: 0 the file parsed · 1 it did not parse, or the parser is not installed · 2 bad arguments
`;
const SPEC = {
    '--replay': 'number',
    '--state-dir': 'string',
    '--json': 'boolean',
    '--help': 'boolean',
    '-h': 'boolean',
};
const LIGHT_COLOR = {
    green: 'green', yellow: 'yellow', orange: 'magenta', red: 'red',
};
/**
 * Re-decide recorded calls against a parsed policy.
 *
 * A decision with no recorded input is **skipped and counted**, never treated as unchanged: a
 * replay that quietly ignores half the trail reports a reassuring number about the wrong half.
 */
function replay(policy, decisions, evaluate) {
    const result = { considered: 0, skipped: 0, changes: [] };
    for (const decision of decisions) {
        if (decision.input === undefined || !decision.tool) {
            result.skipped += 1;
            continue;
        }
        result.considered += 1;
        const verdict = evaluate(policy, {
            tool: decision.tool,
            input: decision.input,
            sessionId: decision.sessionId,
            agent: decision.agent,
        });
        if (verdict.outcome !== decision.outcome) {
            result.changes.push({
                decision, was: decision.outcome, now: verdict.outcome, clauseId: verdict.clauseId,
            });
        }
    }
    return result;
}
function renderText(policy, replayed, io) {
    const paint = (0, render_1.painter)((0, render_1.colorEnabled)(io));
    const lines = [
        paint(`${policy.path}`, 'bold'),
        paint(`${policy.clauses.length} clause${policy.clauses.length === 1 ? '' : 's'} · ${policy.issues.length} unparseable`, 'dim'),
        '',
    ];
    if (policy.clauses.length > 0) {
        lines.push((0, render_1.table)([{ header: 'ID' }, { header: 'LIGHT' }, { header: 'LINE', right: true },
            { header: 'CLAUSE', max: Math.max(24, io.columns - 26) }], policy.clauses.map(c => [
            c.id,
            paint(c.light, LIGHT_COLOR[c.light] ?? 'gray'),
            c.line === undefined ? '' : String(c.line),
            c.text,
        ]), paint));
    }
    if (policy.issues.length > 0) {
        lines.push('', paint('Could not parse:', 'red'));
        for (const issue of policy.issues) {
            const where = issue.line > 0 ? `${policy.path}:${issue.line}` : policy.path;
            lines.push(`  ${paint(where, 'dim')} ${issue.message}${issue.text ? paint(`  — ${issue.text}`, 'dim') : ''}`);
        }
    }
    if (replayed) {
        lines.push('', paint(`replay: ${replayed.considered} decisions re-decided · ${replayed.changes.length} would change`
            + `${replayed.skipped > 0 ? ` · ${replayed.skipped} had no recorded input` : ''}`, 'bold'));
        for (const change of replayed.changes) {
            lines.push(`  ${change.decision.tool || '(no tool)'}: ${paint(change.was, 'yellow')} → ${paint(change.now, 'green')}${change.clauseId ? paint(` (${change.clauseId})`, 'dim') : ''}`);
        }
    }
    return `${lines.join('\n')}\n`;
}
async function run(argv, io, deps = {}) {
    const [subcommand, ...rest] = argv;
    if (subcommand === '-h' || subcommand === '--help' || subcommand === undefined) {
        io.out(exports.HELP);
        return subcommand === undefined ? 2 : 0;
    }
    // `explain` is the query surface, and it is deliberately not implemented here: it must call the
    // enforcement path's own evaluator, which is exactly what this module refuses to duplicate for
    // `check`. So it is forwarded, unparsed, to the one implementation.
    if (subcommand === 'explain') {
        return (0, explain_1.runExplain)(rest, { out: io.out, err: io.err });
    }
    // Same contract, and for the same reason: `compile` is the write path's last gate and `ablate`
    // re-runs the enforcement evaluator, so both must be the one implementation. They were reachable
    // only as `node .../lib/policy/cli.js compile` — while that file's own usage text says
    // "session-sitter policy", naming an entry point that rejected the subcommand.
    if (subcommand === 'compile') {
        return (deps.compile ?? cli_1.compile)([...rest]);
    }
    if (subcommand === 'ablate') {
        return (deps.ablate ?? cli_1.ablateCommand)([...rest]);
    }
    if (subcommand !== 'check') {
        throw new args_1.CliError(`unknown policy subcommand "${subcommand}" — the four are "check", "explain", "compile" `
            + 'and "ablate"');
    }
    const args = (0, args_1.parseFlags)(rest, SPEC);
    if ((0, args_1.flagBool)(args, '--help') || (0, args_1.flagBool)(args, '-h')) {
        io.out(exports.HELP);
        return 0;
    }
    if (args.positional.length > 1) {
        throw new args_1.CliError(`policy check takes one path, got "${args.positional.join('", "')}"`);
    }
    const cwd = deps.cwd ?? process.cwd();
    const filePath = args.positional[0] ?? findPracticesFile(cwd);
    if (filePath === undefined) {
        throw new args_1.CliError(`no practices file found in ${cwd} — looked for ${exports.PRACTICES_CANDIDATES.join(', ')}; `
            + 'pass one as an argument');
    }
    let source;
    try {
        source = await fs.promises.readFile(filePath, 'utf8');
    }
    catch (err) {
        throw new args_1.CliError(`cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`, 1);
    }
    const loaded = (deps.load ?? loadPolicyModule)();
    if (typeof loaded === 'string') {
        // Exit 1, not 2: the arguments were fine, the tool is incomplete. Saying which is the
        // difference between "you typed it wrong" and "this build cannot answer that".
        throw new args_1.CliError(`${loaded}\nUntil it is, policy check cannot parse a practices file.`, 1);
    }
    const policy = await loaded.parsePractices(source, filePath);
    const replayCount = (0, args_1.flagNumber)(args, '--replay');
    let replayed = null;
    if (replayCount !== undefined) {
        if (replayCount <= 0 || !Number.isInteger(replayCount)) {
            throw new args_1.CliError('--replay needs a positive whole number of decisions');
        }
        if (!loaded.evaluate) {
            throw new args_1.CliError(`${POLICY_MODULE} exports no evaluate(policy, call), so --replay cannot re-decide anything`, 1);
        }
        const state = (0, audit_1.resolveState)((0, args_1.flagString)(args, '--state-dir'), cwd);
        const read = deps.read ?? audit_1.readDecisions;
        const recent = (0, audit_1.filterDecisions)(await read(state.dir, state.hookTrail), {}).slice(-replayCount);
        replayed = replay(policy, recent, loaded.evaluate);
    }
    if ((0, args_1.flagBool)(args, '--json')) {
        const payload = {
            version: 1,
            generatedAt: io.now().toISOString(),
            path: policy.path,
            ok: policy.issues.length === 0,
            clauses: policy.clauses,
            issues: policy.issues,
            replay: replayed === null ? null : {
                considered: replayed.considered,
                skipped: replayed.skipped,
                changed: replayed.changes.length,
                changes: replayed.changes.map(c => ({
                    id: c.decision.id,
                    at: c.decision.at.toISOString(),
                    tool: c.decision.tool,
                    was: c.was,
                    now: c.now,
                    clauseId: c.clauseId,
                })),
            },
        };
        io.out(`${JSON.stringify(payload, null, 2)}\n`);
    }
    else {
        io.out(renderText(policy, replayed, io));
    }
    // A file that did not fully parse is a failed lint, whatever else the run reported.
    return policy.issues.length === 0 ? 0 : 1;
}
