// GENERATED FILE — DO NOT EDIT.
// Compiled from src/hooks/io.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Hook process plumbing: read the JSON event on stdin, write the JSON decision on stdout, exit 0.
 *
 * Every hook in this directory is the same shape — a testable `handle(input)` and a thin wrapper
 * that runs it as a process — so the wrapper lives here once.
 *
 * Two contract facts drive the design, both from the hooks reference:
 *
 *  - **Exit 2 is not honoured for `PermissionRequest`.** Only the `decision` object decides. So a
 *    hook must always print valid JSON, and a crash must not become an accidental silence.
 *  - **Exit 1 is a non-blocking error**: the action proceeds. Which means a thrown exception in a
 *    governance hook fails *open* unless the hook catches it and prints a decision itself. Hence
 *    `fallback`: the caller supplies the output to print when `handle` throws, and for
 *    `PermissionRequest` that fallback is a deny.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.readStdin = readStdin;
exports.parseInput = parseInput;
exports.runHook = runHook;
/** Read all of stdin. Resolves to the empty string when nothing is piped in. */
function readStdin(stream = process.stdin) {
    return new Promise(resolve => {
        let text = '';
        // A hook is always given stdin, but a hand-run `node hooks/x.js` with a tty is not, and it
        // must not hang forever waiting for a line nobody will type.
        if (stream.isTTY) {
            resolve('');
            return;
        }
        stream.setEncoding('utf8');
        stream.on('data', chunk => { text += chunk; });
        stream.on('end', () => resolve(text));
        stream.on('error', () => resolve(text));
    });
}
/** Parse the event JSON. A malformed or empty payload becomes an empty event, never a throw. */
function parseInput(text) {
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        return {};
    }
}
/**
 * Run a hook as a process. Always writes valid JSON and always exits 0 — a non-zero exit from a
 * governance hook is either ignored (`PermissionRequest`) or read as a non-blocking error, and
 * neither is a decision.
 */
async function runHook(handle, opts = {}) {
    const input = parseInput(await readStdin());
    let output;
    try {
        output = await handle(input);
    }
    catch (err) {
        output = opts.fallback ? opts.fallback(input, err) : {};
    }
    process.stdout.write(`${JSON.stringify(output ?? {})}\n`);
    process.exit(0);
}
