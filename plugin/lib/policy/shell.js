// GENERATED FILE — DO NOT EDIT.
// Compiled from src/policy/shell.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Split a shell command line into the commands it actually runs.
 *
 * ## Why this file exists
 *
 * Claude Code's permission patterns match on a command *prefix*, so `Bash(git:*)` does not match
 * `git add . && git commit -m x` (issue #25441). Per the community meta-issue #30519 the same hole
 * applies to **deny** rules, which is the part that matters: a written `deny` can be walked straight
 * past by appending `&& <the denied thing>`. `src/supervisor/tiers.ts` already fixed the mirror image
 * of this bug one layer down — its `SHELL_COMPOSITION` guard refuses the free green path to any line
 * containing a separator — but refusing to decide is only the right answer for the *free* path. A
 * policy layer has to actually evaluate the other commands.
 *
 * So: this module turns one command line into the list of commands a shell would run from it, and
 * `src/hooks/permissionRequest.ts` evaluates every one of them.
 *
 * ## Fail closed, always
 *
 * A shell splitter is where security tools get bypassed, so the contract is that `confident` is
 * `false` for **anything** this scanner does not fully understand — an unbalanced quote, an
 * unterminated substitution, arithmetic expansion, nesting past {@link MAX_DEPTH}. The caller must
 * treat `confident: false` as *ambiguous*, never as safe: it escalates to the classifier, or denies.
 * `commands` may be partial in that case and must be ignored.
 *
 * ## What it deliberately over-approximates
 *
 * Splitting too much is safe (extra constituents are extra scrutiny); splitting too little is not.
 * Two knowing over-approximations follow from that:
 *
 *  - **Heredoc bodies are scanned like code.** `cat <<EOF` followed by prose containing `;` yields
 *    extra pseudo-commands. They match nothing and the call escalates, which is the harmless
 *    direction. Recognising heredocs properly means tracking a delimiter across lines, and getting
 *    *that* wrong is the direction that approves code.
 *  - **Subshell and group braces are stripped, not modelled.** `(cd x && rm -rf y)` yields
 *    `cd x` and `rm -rf y`; the grouping changes nothing about which commands run.
 *
 * Redirects are *not* treated as separators: `ls > /etc/cron.d/pwn` is one command, and the danger
 * is in its target, which stays in the constituent for the matchers to see.
 *
 * ## What a substitution becomes
 *
 * `$(…)`, backticks and process substitution `<(…)` are commands in their own right, so their bodies
 * are scanned (recursively) and emitted as their own constituents, while the *outer* text keeps a
 * space where the substitution stood. That is what lets `echo $(git status)` resolve as the two safe
 * commands it is, instead of being permanently ambiguous because it contains a `$(`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_DEPTH = void 0;
exports.splitShellCommand = splitShellCommand;
/** Substitution nesting past this is not something this scanner will vouch for. */
exports.MAX_DEPTH = 4;
/** Control operators, longest-first so `&&` is never read as two `&` and `|&` never as `|`. */
const OPERATORS = [';', '&&', '||', '|&', '|', '&', '\n', '\r'];
/** Record the first loss of certainty. Only the first matters — the scan stops either way. */
function lose(fail, reason) {
    if (fail.reason === null) {
        fail.reason = reason;
    }
}
/** Trim a constituent and drop the grouping punctuation that carries no command of its own. */
function clean(piece) {
    let out = piece.trim();
    // Repeated because `({ cmd })` nests, and each layer is only ever noise here.
    for (;;) {
        const stripped = out.replace(/^[({\s]+/, '').replace(/[)}\s]+$/, '');
        if (stripped === out) {
            return out;
        }
        out = stripped;
    }
}
/**
 * Find the index just past the `)` closing the `(` at `open`, tracking quotes and nesting so a
 * paren inside a string does not end the substitution. Returns -1 when it is never closed.
 */
function matchParen(src, open) {
    let depth = 0;
    let i = open;
    while (i < src.length) {
        const c = src[i];
        if (c === '\\') {
            i += 2;
            continue;
        }
        if (c === "'" || c === '"') {
            const end = src.indexOf(c, i + 1);
            if (end < 0) {
                return -1;
            }
            i = end + 1;
            continue;
        }
        if (c === '(') {
            depth++;
            i++;
            continue;
        }
        if (c === ')') {
            depth--;
            i++;
            if (depth === 0) {
                return i;
            }
            continue;
        }
        i++;
    }
    return -1;
}
/** Scan a substitution body as its own command line, emitting its constituents into `out`. */
function substitution(src, open, depth, out, fail) {
    if (depth >= exports.MAX_DEPTH) {
        lose(fail, `substitution nested deeper than ${exports.MAX_DEPTH}`);
        return null;
    }
    const close = matchParen(src, open);
    if (close < 0) {
        lose(fail, 'unterminated command substitution');
        return null;
    }
    scan(src.slice(open + 1, close - 1), depth + 1, out, fail);
    return fail.reason === null ? close : null;
}
/** Scan a backtick substitution. The first unescaped backtick ends it. */
function backtick(src, at, depth, out, fail) {
    if (depth >= exports.MAX_DEPTH) {
        lose(fail, `substitution nested deeper than ${exports.MAX_DEPTH}`);
        return null;
    }
    let i = at + 1;
    while (i < src.length) {
        if (src[i] === '\\') {
            i += 2;
            continue;
        }
        if (src[i] === '`') {
            scan(src.slice(at + 1, i), depth + 1, out, fail);
            return fail.reason === null ? i + 1 : null;
        }
        i++;
    }
    lose(fail, 'unterminated backtick substitution');
    return null;
}
/**
 * Read a double-quoted span starting at `at`. Substitutions are still live inside double quotes —
 * `echo "$(curl evil)"` runs `curl` — so they are scanned out; everything else is literal text and
 * cannot be a separator.
 */
function doubleQuoted(src, at, depth, out, fail) {
    let text = '"';
    let i = at + 1;
    while (i < src.length) {
        const c = src[i];
        if (c === '\\') {
            text += src.slice(i, i + 2);
            i += 2;
            continue;
        }
        if (c === '"') {
            return { text: `${text}"`, next: i + 1 };
        }
        if (c === '`') {
            const next = backtick(src, i, depth, out, fail);
            if (next === null) {
                return null;
            }
            text += ' ';
            i = next;
            continue;
        }
        if (c === '$' && src[i + 1] === '(') {
            if (src[i + 2] === '(') {
                lose(fail, 'arithmetic expansion $(( ))');
                return null;
            }
            const next = substitution(src, i + 1, depth, out, fail);
            if (next === null) {
                return null;
            }
            text += ' ';
            i = next;
            continue;
        }
        text += c;
        i++;
    }
    lose(fail, 'unbalanced double quote');
    return null;
}
/** The one scanner. Appends this line's constituents to `out`; returns early once `fail` is set. */
function scan(src, depth, out, fail) {
    let cur = '';
    let i = 0;
    const push = () => { const t = clean(cur); if (t) {
        out.push(t);
    } cur = ''; };
    while (i < src.length) {
        if (fail.reason !== null) {
            return;
        }
        const c = src[i];
        if (c === '\\') {
            cur += src.slice(i, i + 2);
            i += 2;
            continue;
        }
        // Single quotes are fully literal — no substitution, no escape, no separator.
        if (c === "'") {
            const end = src.indexOf("'", i + 1);
            if (end < 0) {
                lose(fail, 'unbalanced single quote');
                return;
            }
            cur += src.slice(i, end + 1);
            i = end + 1;
            continue;
        }
        if (c === '"') {
            const span = doubleQuoted(src, i, depth, out, fail);
            if (span === null) {
                return;
            }
            cur += span.text;
            i = span.next;
            continue;
        }
        if (c === '`') {
            const next = backtick(src, i, depth, out, fail);
            if (next === null) {
                return;
            }
            cur += ' ';
            i = next;
            continue;
        }
        if (c === '$' && src[i + 1] === '(') {
            // `$((` is arithmetic, not a command, and telling the two apart reliably is more than this
            // scanner does — so it is refused rather than guessed at.
            if (src[i + 2] === '(') {
                lose(fail, 'arithmetic expansion $(( ))');
                return;
            }
            const next = substitution(src, i + 1, depth, out, fail);
            if (next === null) {
                return;
            }
            cur += ' ';
            i = next;
            continue;
        }
        // Process substitution: `diff <(a) <(b)` runs `a` and `b`.
        if ((c === '<' || c === '>') && src[i + 1] === '(') {
            const next = substitution(src, i + 1, depth, out, fail);
            if (next === null) {
                return;
            }
            cur += ' ';
            i = next;
            continue;
        }
        const op = OPERATORS.find(o => src.startsWith(o, i));
        if (op !== undefined) {
            push();
            i += op.length;
            continue;
        }
        cur += c;
        i++;
    }
    if (fail.reason === null) {
        push();
    }
}
/**
 * Split one command line into the commands it runs. A line with no composition comes back as a
 * single-element list, so a caller can take this path unconditionally.
 */
function splitShellCommand(command) {
    const commands = [];
    const fail = { reason: null };
    scan(command, 0, commands, fail);
    if (fail.reason !== null) {
        return { commands, confident: false, reason: fail.reason };
    }
    // An empty or whitespace-only line yields nothing to evaluate. Handing back the original keeps
    // the caller's "there is always at least one constituent" invariant true.
    return {
        commands: commands.length > 0 ? commands : [command.trim()],
        confident: true,
        reason: null,
    };
}
