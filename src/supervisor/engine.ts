/**
 * The classifier engine: run a fresh agent CLI per supervision request.
 *
 * Ported from `reckon_supervisor/engine.py`. `classify(prompt)` returns the model's raw response
 * text (expected to be the strict JSON assessment — validated separately in `schema.ts`). Each
 * call is a fresh, stateless invocation; no state carries between calls, and no process is kept
 * alive while waiting on a human.
 *
 * The abstraction lets one CLI be swapped for another. `FakeEngine` drives the offline tests.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractJsonObject } from './schema';

/** A classifier invocation failed (non-zero exit, no output, unreadable result). */
export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

/** The classifier invocation exceeded its timeout. */
export class EngineTimeout extends EngineError {
  constructor(message: string) {
    super(message);
    this.name = 'EngineTimeout';
  }
}

export interface EngineResult {
  invocationId: string;
  raw: string;
}

export interface ClassifierEngine {
  /** Run one fresh classification pass and return its raw text output. */
  classify(prompt: string): Promise<EngineResult>;
}

function newInvocationId(): string {
  const hex = Math.random().toString(16).slice(2).padEnd(12, '0').slice(0, 12);
  return `inv-${hex}`;
}

/** Appended on a retry when an agentic CLI returned prose instead of the required JSON. */
const JSON_HARDENER =
  '\n\nCRITICAL OUTPUT REQUIREMENT: Your ENTIRE response must be exactly one JSON object — '
  + "start with '{' and end with '}'. Output NO prose, NO summary, NO headings, NO markdown "
  + 'fences, and do NOT narrate the decision. Just the JSON object.';

// A short, constant one-shot trigger passed to Bob via `-p` (its text is appended after the
// stdin prompt). Kept tiny so argv never approaches the OS limit — the real prompt rides on
// stdin. See the E2BIG note in `BobCliEngine.runBob`.
const BOB_ONESHOT = 'Now output ONLY the JSON assessment object for the request described above.';

/** True when `raw` contains a JSON object with a traffic_light (a usable assessment). */
export function hasAssessment(raw: string): boolean {
  try {
    const obj = JSON.parse(extractJsonObject(raw)) as unknown;
    return !!obj && typeof obj === 'object' && !Array.isArray(obj)
      && 'traffic_light' in (obj as Record<string, unknown>);
  } catch {
    return false; // any parse failure just means "retry"
  }
}

export interface SpawnOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run a command with the prompt on **stdin**, never as an argv element.
 *
 * A supervision prompt embeds the full transcript + BDI and routinely exceeds the OS
 * single-argument limit (on Linux `MAX_ARG_STRLEN` ≈ 128 KiB), which makes `execve` fail with
 * `E2BIG` — the original bug this shape fixes.
 */
export function runWithStdin(
  cmd: string,
  args: string[],
  input: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<SpawnOutcome> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env });
    } catch (err) {
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

    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') { reject(new EngineError(`${cmd} CLI not found at ${JSON.stringify(cmd)}`)); return; }
      reject(new EngineError(`failed to launch ${cmd}: ${String(err)}`));
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    // A closed/failed stdin must not crash the extension host.
    child.stdin?.on('error', () => { /* the close handler reports the real failure */ });
    child.stdin?.end(input, 'utf8');
  });
}

export interface ClaudeCodeEngineOptions {
  cliPath?: string;
  cwd?: string;
  timeoutSeconds?: number;
  anthropicBaseUrl?: string | null;
  anthropicAuthToken?: string | null;
  /** Injectable runner (tests). Defaults to `runWithStdin`. */
  run?: typeof runWithStdin;
}

/**
 * Spawns `claude -p --output-format json` as a fresh process per request, with the prompt on
 * stdin. With `--output-format json` Claude Code returns an envelope like
 * `{"type":"result","result":"<assistant text>", …}`; we return the `result` text (which the
 * prompt instructs to be our strict JSON).
 */
export class ClaudeCodeEngine implements ClassifierEngine {
  private readonly cli: string;
  private readonly cwd?: string;
  private readonly timeoutMs: number;
  private readonly baseUrl?: string | null;
  private readonly authToken?: string | null;
  private readonly run: typeof runWithStdin;

  constructor(opts: ClaudeCodeEngineOptions = {}) {
    this.cli = opts.cliPath ?? 'claude';
    this.cwd = opts.cwd;
    this.timeoutMs = (opts.timeoutSeconds ?? 300) * 1000;
    this.baseUrl = opts.anthropicBaseUrl;
    this.authToken = opts.anthropicAuthToken;
    this.run = opts.run ?? runWithStdin;
  }

  async classify(prompt: string): Promise<EngineResult> {
    const invocationId = newInvocationId();
    const args = ['-p', '--output-format', 'json'];
    // The claude CLI reads its gateway + token from the environment. Layer the configured
    // values on top of the inherited env (only when set), so a configured gateway still
    // reaches the subprocess.
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.baseUrl) { env.ANTHROPIC_BASE_URL = this.baseUrl; }
    if (this.authToken) { env.ANTHROPIC_AUTH_TOKEN = this.authToken; }

    const res = await this.run(this.cli, args, prompt, {
      cwd: this.cwd, env, timeoutMs: this.timeoutMs,
    });
    if (res.timedOut) {
      throw new EngineTimeout(`claude timed out after ${this.timeoutMs / 1000}s`);
    }
    if (res.code !== 0) {
      throw new EngineError(
        `claude exited ${res.code}: ${(res.stderr || res.stdout || '').trim().slice(0, 500)}`);
    }
    const raw = (res.stdout || '').trim();
    if (!raw) { throw new EngineError('claude produced no output'); }
    return { invocationId, raw: ClaudeCodeEngine.extractResult(raw) };
  }

  /** Unwrap the Claude Code JSON envelope to the assistant text, if present. */
  static extractResult(stdout: string): string {
    let env: unknown;
    try {
      env = JSON.parse(stdout);
    } catch {
      return stdout; // not the JSON envelope — assume stdout is already the assistant text
    }
    if (env && typeof env === 'object' && !Array.isArray(env)) {
      const r = (env as Record<string, unknown>).result;
      if (typeof r === 'string') { return r; }
    }
    // Some CLI versions emit a list of message events; find the last text result.
    if (Array.isArray(env)) {
      for (let i = env.length - 1; i >= 0; i--) {
        const item = env[i];
        if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).result === 'string') {
          return (item as Record<string, string>).result;
        }
      }
    }
    return stdout;
  }
}

export interface BobCliEngineOptions {
  cliPath?: string;
  cwd?: string;
  timeoutSeconds?: number;
  apiKey?: string | null;
  run?: typeof runWithStdin;
}

/**
 * Spawns IBM Bob Shell headless with the prompt on stdin. Bob has no reliable JSON-only mode,
 * so the prompt asks for raw JSON and `schema.extractJsonObject` recovers it (tolerating
 * surrounding prose and the trailing stats object). Auth is the Bob API key, passed via
 * `BOBSHELL_API_KEY` in the child env.
 */
export class BobCliEngine implements ClassifierEngine {
  private readonly cli: string;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly apiKey?: string | null;
  private readonly run: typeof runWithStdin;

  constructor(opts: BobCliEngineOptions = {}) {
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

  async classify(prompt: string): Promise<EngineResult> {
    const invocationId = newInvocationId();
    // Bob is an agentic shell: it USUALLY honors "output JSON" but sometimes returns a prose
    // summary instead. If the first run isn't a valid assessment, retry once with a hardened
    // instruction. Kept to 2 attempts to bound latency; the orchestrator salvages prose and, as
    // a last resort, escalates to the human — so a non-JSON reply never hard-fails.
    let lastRaw = '';
    for (const text of [prompt, prompt + JSON_HARDENER]) {
      lastRaw = await this.runBob(text);
      if (hasAssessment(lastRaw)) { return { invocationId, raw: lastRaw }; }
    }
    // No attempt produced an assessment — return the last output so the schema error is clear.
    return { invocationId, raw: lastRaw };
  }

  private async runBob(prompt: string): Promise<string> {
    // The prompt rides on STDIN, not argv (see runWithStdin). The short, constant `-p` trigger
    // only selects one-shot non-interactive mode; its text is appended after the stdin input.
    const args = [
      '--accept-license', '--hide-intermediary-output',
      '--output-format', 'json', '-p', BOB_ONESHOT,
    ];
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.apiKey) { env.BOBSHELL_API_KEY = this.apiKey; }

    const res = await this.run(this.cli, args, prompt, {
      cwd: this.cwd, env, timeoutMs: this.timeoutMs,
    });
    if (res.timedOut) { throw new EngineTimeout(`bob timed out after ${this.timeoutMs / 1000}s`); }
    if (res.code !== 0) {
      throw new EngineError(
        `bob exited ${res.code}: ${(res.stderr || res.stdout || '').trim().slice(0, 500)}`);
    }
    const raw = (res.stdout || '').trim();
    if (!raw) { throw new EngineError('bob produced no output'); }
    return raw;
  }
}

export type FakeResponse = string | Error | ((prompt: string) => string);

/**
 * Test engine: returns scripted responses in order, recording every prompt seen.
 * A response may be a string, a function of the prompt, or an Error instance (which is thrown).
 */
export class FakeEngine implements ClassifierEngine {
  readonly prompts: string[] = [];
  readonly invocations: string[] = [];
  private cursor = 0;

  constructor(private readonly responses: FakeResponse[]) {}

  async classify(prompt: string): Promise<EngineResult> {
    this.prompts.push(prompt);
    const invocationId = newInvocationId();
    this.invocations.push(invocationId);
    if (this.cursor >= this.responses.length) {
      throw new EngineError('FakeEngine ran out of scripted responses');
    }
    const item = this.responses[this.cursor];
    this.cursor++;
    if (item instanceof Error) { throw item; }
    const raw = typeof item === 'function' ? item(prompt) : item;
    return { invocationId, raw: String(raw) };
  }

  get callCount(): number {
    return this.prompts.length;
  }
}
