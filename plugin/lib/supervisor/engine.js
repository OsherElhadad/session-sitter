// GENERATED FILE — DO NOT EDIT.
// Compiled from src/supervisor/engine.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * The classifier engine: run a fresh agent CLI per supervision request.
 *
 * Ported from the Python supervisor (`engine.py`. `classify(prompt)` returns the model's raw response
 * text (expected to be the strict JSON assessment — validated separately in `schema.ts`). Each
 * call is a fresh, stateless invocation; no state carries between calls, and no process is kept
 * alive while waiting on a human.
 *
 * The abstraction lets one CLI be swapped for another. `FakeEngine` drives the offline tests.
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
exports.FakeEngine = exports.BobCliEngine = exports.ClaudeCodeEngine = exports.EngineTimeout = exports.EngineError = void 0;
exports.hasAssessment = hasAssessment;
exports.runWithStdin = runWithStdin;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const schema_1 = require("./schema");
/** A classifier invocation failed (non-zero exit, no output, unreadable result). */
class EngineError extends Error {
    constructor(message) {
        super(message);
        this.name = 'EngineError';
    }
}
exports.EngineError = EngineError;
/** The classifier invocation exceeded its timeout. */
class EngineTimeout extends EngineError {
    constructor(message) {
        super(message);
        this.name = 'EngineTimeout';
    }
}
exports.EngineTimeout = EngineTimeout;
function newInvocationId() {
    const hex = Math.random().toString(16).slice(2).padEnd(12, '0').slice(0, 12);
    return `inv-${hex}`;
}
/** Appended on a retry when an agentic CLI returned prose instead of the required JSON. */
const JSON_HARDENER = '\n\nCRITICAL OUTPUT REQUIREMENT: Your ENTIRE response must be exactly one JSON object — '
    + "start with '{' and end with '}'. Output NO prose, NO summary, NO headings, NO markdown "
    + 'fences, and do NOT narrate the decision. Just the JSON object.';
// A short, constant one-shot trigger passed to Bob via `-p` (its text is appended after the
// stdin prompt). Kept tiny so argv never approaches the OS limit — the real prompt rides on
// stdin. See the E2BIG note in `BobCliEngine.runBob`.
const BOB_ONESHOT = 'Now output ONLY the JSON assessment object for the request described above.';
/** True when `raw` contains a JSON object with a traffic_light (a usable assessment). */
function hasAssessment(raw) {
    try {
        const obj = JSON.parse((0, schema_1.extractJsonObject)(raw));
        return !!obj && typeof obj === 'object' && !Array.isArray(obj)
            && 'traffic_light' in obj;
    }
    catch {
        return false; // any parse failure just means "retry"
    }
}
/**
 * Run a command with the prompt on **stdin**, never as an argv element.
 *
 * A supervision prompt embeds the full transcript + BDI and routinely exceeds the OS
 * single-argument limit (on Linux `MAX_ARG_STRLEN` ≈ 128 KiB), which makes `execve` fail with
 * `E2BIG` — the original bug this shape fixes.
 */
function runWithStdin(cmd, args, input, opts) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = (0, child_process_1.spawn)(cmd, args, { cwd: opts.cwd, env: opts.env });
        }
        catch (err) {
            reject(new EngineError(`failed to launch ${cmd}: ${String(err)}`));
            return;
        }
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, opts.timeoutMs);
        child.stdout?.on('data', (b) => { stdout += b.toString('utf8'); });
        child.stderr?.on('data', (b) => { stderr += b.toString('utf8'); });
        child.on('error', (err) => {
            clearTimeout(timer);
            if (err.code === 'ENOENT') {
                reject(new EngineError(`${cmd} CLI not found at ${JSON.stringify(cmd)}`));
                return;
            }
            reject(new EngineError(`failed to launch ${cmd}: ${String(err)}`));
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr, timedOut });
        });
        // A closed/failed stdin must not crash the extension host.
        child.stdin?.on('error', () => { });
        child.stdin?.end(input, 'utf8');
    });
}
/**
 * Spawns `claude -p --output-format json` as a fresh process per request, with the prompt on
 * stdin. With `--output-format json` Claude Code returns an envelope like
 * `{"type":"result","result":"<assistant text>", …}`; we return the `result` text (which the
 * prompt instructs to be our strict JSON).
 */
class ClaudeCodeEngine {
    constructor(opts = {}) {
        this.cli = opts.cliPath ?? 'claude';
        this.cwd = opts.cwd;
        this.timeoutMs = (opts.timeoutSeconds ?? 300) * 1000;
        this.baseUrl = opts.anthropicBaseUrl;
        this.authToken = opts.anthropicAuthToken;
        this.run = opts.run ?? runWithStdin;
    }
    async classify(prompt) {
        const invocationId = newInvocationId();
        const args = ['-p', '--output-format', 'json'];
        // The claude CLI reads its gateway + token from the environment. Layer the configured
        // values on top of the inherited env (only when set), so a configured gateway still
        // reaches the subprocess.
        const env = { ...process.env };
        if (this.baseUrl) {
            env.ANTHROPIC_BASE_URL = this.baseUrl;
        }
        if (this.authToken) {
            env.ANTHROPIC_AUTH_TOKEN = this.authToken;
        }
        const started = Date.now();
        const res = await this.run(this.cli, args, prompt, {
            cwd: this.cwd, env, timeoutMs: this.timeoutMs,
        });
        if (res.timedOut) {
            throw new EngineTimeout(`claude timed out after ${this.timeoutMs / 1000}s`);
        }
        if (res.code !== 0) {
            throw new EngineError(`claude exited ${res.code}: ${(res.stderr || res.stdout || '').trim().slice(0, 500)}`);
        }
        const raw = (res.stdout || '').trim();
        if (!raw) {
            throw new EngineError('claude produced no output');
        }
        return {
            invocationId,
            raw: ClaudeCodeEngine.extractResult(raw),
            telemetry: ClaudeCodeEngine.extractTelemetry(raw, Date.now() - started),
        };
    }
    /**
     * The `usage` block of the Claude Code envelope, as a {@link FastTelemetry}.
     *
     * The envelope already carries the four token counts this repository measures prompt-cache health
     * on; `extractResult` reads one field out of it and drops the rest, so the numbers were being
     * thrown away rather than being unavailable.
     *
     * Returns null whenever the shape is not there — a plain-text stdout, an older CLI, an envelope
     * with no `usage`. The transcript JSONL and this envelope are both officially internal and
     * unstable, so a miss must degrade to "not recorded" and never to a fabricated zero.
     */
    static extractTelemetry(stdout, latencyMs) {
        let env;
        try {
            env = JSON.parse(stdout);
        }
        catch {
            return null;
        }
        const last = Array.isArray(env) ? env[env.length - 1] : env;
        if (!last || typeof last !== 'object') {
            return null;
        }
        const usage = last.usage;
        if (!usage || typeof usage !== 'object') {
            return null;
        }
        const count = (key) => {
            const v = usage[key];
            return typeof v === 'number' && Number.isFinite(v) ? v : 0;
        };
        const models = last.modelUsage;
        const model = models && typeof models === 'object' && !Array.isArray(models)
            ? Object.keys(models)[0] ?? '' : '';
        return {
            tier: 'agent_cli',
            model,
            latency_ms: latencyMs,
            input_tokens: count('input_tokens'),
            cache_creation_input_tokens: count('cache_creation_input_tokens'),
            cache_read_input_tokens: count('cache_read_input_tokens'),
            output_tokens: count('output_tokens'),
        };
    }
    /** Unwrap the Claude Code JSON envelope to the assistant text, if present. */
    static extractResult(stdout) {
        let env;
        try {
            env = JSON.parse(stdout);
        }
        catch {
            return stdout; // not the JSON envelope — assume stdout is already the assistant text
        }
        if (env && typeof env === 'object' && !Array.isArray(env)) {
            const r = env.result;
            if (typeof r === 'string') {
                return r;
            }
        }
        // Some CLI versions emit a list of message events; find the last text result.
        if (Array.isArray(env)) {
            for (let i = env.length - 1; i >= 0; i--) {
                const item = env[i];
                if (item && typeof item === 'object' && typeof item.result === 'string') {
                    return item.result;
                }
            }
        }
        return stdout;
    }
}
exports.ClaudeCodeEngine = ClaudeCodeEngine;
/**
 * Spawns IBM Bob Shell headless with the prompt on stdin. Bob has no reliable JSON-only mode,
 * so the prompt asks for raw JSON and `schema.extractJsonObject` recovers it (tolerating
 * surrounding prose and the trailing stats object). Auth is the Bob API key, passed via
 * `BOBSHELL_API_KEY` in the child env.
 */
class BobCliEngine {
    constructor(opts = {}) {
        this.cli = opts.cliPath ?? 'bob';
        // Run in an ISOLATED empty dir, never the workspace. Bob's context/import gathering scans
        // the workspace and can crash on knowledge markdown; repo context also nudges it toward
        // prose instead of the required JSON. The prompt is self-contained (inline BDI), so no repo
        // access is needed. One temp dir per engine; the OS reaps it.
        this.cwd = opts.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-bob-'));
        this.timeoutMs = (opts.timeoutSeconds ?? 300) * 1000;
        this.apiKey = opts.apiKey;
        this.run = opts.run ?? runWithStdin;
    }
    async classify(prompt) {
        const invocationId = newInvocationId();
        // Bob is an agentic shell: it USUALLY honors "output JSON" but sometimes returns a prose
        // summary instead. If the first run isn't a valid assessment, retry once with a hardened
        // instruction. Kept to 2 attempts to bound latency; the orchestrator salvages prose and, as
        // a last resort, escalates to the human — so a non-JSON reply never hard-fails.
        let lastRaw = '';
        for (const text of [prompt, prompt + JSON_HARDENER]) {
            lastRaw = await this.runBob(text);
            if (hasAssessment(lastRaw)) {
                return { invocationId, raw: lastRaw };
            }
        }
        // No attempt produced an assessment — return the last output so the schema error is clear.
        return { invocationId, raw: lastRaw };
    }
    async runBob(prompt) {
        // The prompt rides on STDIN, not argv (see runWithStdin). The short, constant `-p` trigger
        // only selects one-shot non-interactive mode; its text is appended after the stdin input.
        const args = [
            '--accept-license', '--hide-intermediary-output',
            '--output-format', 'json', '-p', BOB_ONESHOT,
        ];
        const env = { ...process.env };
        if (this.apiKey) {
            env.BOBSHELL_API_KEY = this.apiKey;
        }
        const res = await this.run(this.cli, args, prompt, {
            cwd: this.cwd, env, timeoutMs: this.timeoutMs,
        });
        if (res.timedOut) {
            throw new EngineTimeout(`bob timed out after ${this.timeoutMs / 1000}s`);
        }
        if (res.code !== 0) {
            throw new EngineError(`bob exited ${res.code}: ${(res.stderr || res.stdout || '').trim().slice(0, 500)}`);
        }
        const raw = (res.stdout || '').trim();
        if (!raw) {
            throw new EngineError('bob produced no output');
        }
        return raw;
    }
}
exports.BobCliEngine = BobCliEngine;
/**
 * Test engine: returns scripted responses in order, recording every prompt seen.
 * A response may be a string, a function of the prompt, or an Error instance (which is thrown).
 */
class FakeEngine {
    constructor(responses) {
        this.responses = responses;
        this.prompts = [];
        this.invocations = [];
        this.cursor = 0;
    }
    async classify(prompt) {
        this.prompts.push(prompt);
        const invocationId = newInvocationId();
        this.invocations.push(invocationId);
        if (this.cursor >= this.responses.length) {
            throw new EngineError('FakeEngine ran out of scripted responses');
        }
        const item = this.responses[this.cursor];
        this.cursor++;
        if (item instanceof Error) {
            throw item;
        }
        const raw = typeof item === 'function' ? item(prompt) : item;
        return { invocationId, raw: String(raw) };
    }
    get callCount() {
        return this.prompts.length;
    }
}
exports.FakeEngine = FakeEngine;
