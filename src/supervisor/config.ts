/**
 * Configuration for the runtime supervisor.
 *
 * Ported from the Python supervisor (`config.py`. Values come from (highest precedence first):
 * explicit overrides, the process environment, a `.env` file, then built-in defaults.
 *
 * The extension builds this from its `sessionSitter.*` settings; the CLI builds it from the
 * environment + `.env`, so both drive the same orchestrator.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const DEFAULT_ORANGE_TIMEOUT_MINUTES = 30;
export const DEFAULT_CLAUDE_CLI_PATH = 'claude';
export const DEFAULT_CLASSIFIER_TIMEOUT_SECONDS = 300;
/** "bob" (IBM Bob Shell) | "claude" (Claude Code) */
export const DEFAULT_SUPERVISOR_ENGINE = 'bob';
export const DEFAULT_BOB_CLI_PATH = 'bob';

export interface SupervisorConfig {
  /** Root the state dir is derived from when not given explicitly. */
  workspaceRoot: string;
  stateDir: string;
  orangeResponseTimeoutMinutes: number;
  /** Which agent CLI classifies: "bob" (default) or "claude". */
  supervisorEngine: string;
  claudeCliPath: string;
  classifierTimeoutSeconds: number;
  bobCliPath: string;
  /** Bob API key for headless classification (passed as BOBSHELL_API_KEY). */
  bobShellApiKey: string | null;
  /**
   * Claude Code gateway, passed into the `claude` subprocess env so a `.env`-sourced gateway
   * still reaches it (the CLI reads these from its environment, and `.env` is not loaded into
   * `process.env`). Process env still wins over `.env`.
   */
  anthropicBaseUrl: string | null;
  anthropicAuthToken: string | null;
  /** "stub" (writes to files) | "telegram" (real decision cards). */
  messagingChannel: string;
  /**
   * Whether a Red classification also sends a human notification. Policy: Red sends a one-way
   * INFORMATIONAL alert (not a decision prompt — no reply-wait/timeout/fallback); the block
   * persists until a human explicitly unblocks. Default on; set RED_NOTIFY=0 to silence.
   */
  redNotify: boolean;
  telegramBotToken: string | null;
  telegramChatId: string | null;
  /** Optional registry markdown validating the (user, project, team) triple. */
  knowledgeRegistryPath: string;
  /** Local knowledge repo checkout containing `data/knowledge/`. */
  knowledgeLocalRepo: string;
  /** Git URL, used only when no local checkout is configured. */
  knowledgeRepo: string;
  knowledgeRef: string;
}

export function historyDir(c: SupervisorConfig): string { return path.join(c.stateDir, 'history'); }
export function outboxDir(c: SupervisorConfig): string { return path.join(c.stateDir, 'outbox'); }
export function inboxDir(c: SupervisorConfig): string { return path.join(c.stateDir, 'inbox'); }
export function recordsDir(c: SupervisorConfig): string { return path.join(c.stateDir, 'records'); }
export function notificationsDir(c: SupervisorConfig): string {
  return path.join(c.stateDir, 'notifications');
}

export function ensureDirs(c: SupervisorConfig): void {
  for (const d of [
    c.stateDir, historyDir(c), outboxDir(c), inboxDir(c), recordsDir(c), notificationsDir(c),
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/**
 * Parse a minimal `.env` file (KEY=VALUE lines). Never throws on a missing file. Supports
 * optional surrounding quotes and `#` comments. Does not mutate `process.env`.
 */
export function loadDotenv(filePath: string): Record<string, string> {
  const values: Record<string, string> = {};
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return values;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) { continue; }
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && val[0] === val[val.length - 1] && (val[0] === "'" || val[0] === '"')) {
      val = val.slice(1, -1);
    }
    if (key) { values[key] = val; }
  }
  return values;
}

function get(env: Record<string, string>, key: string, fallback?: string): string | undefined {
  // Process env wins over the .env file.
  return process.env[key] ?? env[key] ?? fallback;
}

function getInt(env: Record<string, string>, key: string, fallback: number): number {
  const raw = get(env, key);
  if (raw === undefined || raw.trim() === '') { return fallback; }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function getBool(env: Record<string, string>, key: string, fallback: boolean): boolean {
  const raw = get(env, key);
  if (raw === undefined) { return fallback; }
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export interface LoadConfigOverrides {
  workspaceRoot?: string;
  stateDir?: string;
  /** Extra `.env` files to layer, lowest precedence first. */
  envFiles?: string[];
}

/** Build a `SupervisorConfig`, layering the process env over any `.env` files. */
export function loadConfig(overrides: LoadConfigOverrides = {}): SupervisorConfig {
  const root = path.resolve(overrides.workspaceRoot ?? process.cwd());
  // Layer (lowest→highest): parent-of-root .env < root .env < any explicitly listed file.
  // Process env still wins over all of these (see `get`).
  const env: Record<string, string> = Object.assign(
    {},
    loadDotenv(path.join(path.dirname(root), '.env')),
    loadDotenv(path.join(root, '.env')),
    ...(overrides.envFiles ?? []).map(loadDotenv),
  );

  const envStateDir = get(env, 'STATE_DIR');
  const stateDir = path.resolve(
    overrides.stateDir ?? (envStateDir ? expandHome(envStateDir) : path.join(root, '.supervisor-state')),
  );

  return {
    workspaceRoot: root,
    stateDir,
    orangeResponseTimeoutMinutes: getInt(
      env, 'ORANGE_RESPONSE_TIMEOUT_MINUTES', DEFAULT_ORANGE_TIMEOUT_MINUTES),
    supervisorEngine: (get(env, 'SUPERVISOR_ENGINE', DEFAULT_SUPERVISOR_ENGINE)
      ?? DEFAULT_SUPERVISOR_ENGINE).toLowerCase(),
    claudeCliPath: get(env, 'CLAUDE_CLI_PATH', DEFAULT_CLAUDE_CLI_PATH) ?? DEFAULT_CLAUDE_CLI_PATH,
    classifierTimeoutSeconds: getInt(
      env, 'CLAUDE_TIMEOUT_SECONDS', DEFAULT_CLASSIFIER_TIMEOUT_SECONDS),
    bobCliPath: get(env, 'BOB_CLI_PATH', DEFAULT_BOB_CLI_PATH) ?? DEFAULT_BOB_CLI_PATH,
    // Bob's headless auth. Accept either BOBSHELL_API_KEY or BOB_API_KEY.
    bobShellApiKey: get(env, 'BOBSHELL_API_KEY') ?? get(env, 'BOB_API_KEY') ?? null,
    anthropicBaseUrl: get(env, 'ANTHROPIC_BASE_URL') ?? null,
    anthropicAuthToken: get(env, 'ANTHROPIC_AUTH_TOKEN') ?? null,
    messagingChannel: (get(env, 'MESSAGING_CHANNEL', 'stub') ?? 'stub').toLowerCase(),
    redNotify: getBool(env, 'RED_NOTIFY', true),
    telegramBotToken: get(env, 'TELEGRAM_BOT_TOKEN') ?? null,
    telegramChatId: get(env, 'TELEGRAM_CHAT_ID') ?? null,
    knowledgeRegistryPath: get(env, 'KNOWLEDGE_REGISTRY_PATH', '') ?? '',
    knowledgeLocalRepo: get(env, 'KNOWLEDGE_LOCAL_REPO') ?? get(env, 'KB_SITTER_LOCAL_REPO', '') ?? '',
    knowledgeRepo: get(env, 'KNOWLEDGE_REPO') ?? get(env, 'KB_SITTER_KNOWLEDGE_REPO', '') ?? '',
    knowledgeRef: get(env, 'KNOWLEDGE_REF', 'main') ?? 'main',
  };
}
