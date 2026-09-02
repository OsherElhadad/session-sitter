/**
 * Build the supervisor's configuration from **VS Code settings**.
 *
 * Settings are the source of truth: everything the supervisor needs is a `sessionSitter.*`
 * setting, editable in the Settings UI. Environment variables and `.env` files are kept only as
 * a legacy fallback for values the user has not set in settings, so an existing `.env`-based
 * install keeps working — but nothing requires an env var any more.
 *
 * Precedence, highest first:
 *   1. an explicitly-set `sessionSitter.*` setting (workspace folder > workspace > user)
 *   2. `process.env` / `.env` (legacy)
 *   3. built-in defaults
 *
 * The layering is a pure function (`applySupervisorSettings`) so it is testable without VS Code;
 * `readSupervisorSettings` is the only part that touches the `vscode` API.
 */

import * as vscode from 'vscode';
import { LoadConfigOverrides, SupervisorConfig, loadConfig } from './supervisor/config';

/**
 * The raw user-set values, all optional. `undefined` means "not set in settings" — the env/`.env`
 * fallback then applies. An empty string is treated as unset for path/token-shaped settings.
 */
export interface SupervisorSettings {
  engine?: string;
  bobCliPath?: string;
  claudeCliPath?: string;
  bobApiKey?: string;
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
  classifierTimeoutSeconds?: number;
  fastClassifier?: boolean;
  fastClassifierModel?: string;
  fastClassifierTimeoutSeconds?: number;
  fastClassifierBaseUrl?: string;
  orangeResponseTimeoutMinutes?: number;
  messagingChannel?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  redNotify?: boolean;
  notifyRuleDecisions?: boolean;
  knowledgeRegistryPath?: string;
  knowledgeLocalRepo?: string;
  knowledgeRepo?: string;
  knowledgeRef?: string;
}

/** Minimal shape of `vscode.WorkspaceConfiguration` this module needs (keeps tests light). */
export interface SettingsReader {
  inspect<T>(section: string): {
    globalValue?: T;
    workspaceValue?: T;
    workspaceFolderValue?: T;
  } | undefined;
}

/**
 * The value the user actually set, most specific scope first. Returns `undefined` when only the
 * package.json default applies — that is what lets an env/`.env` value still be honored.
 */
export function userValue<T>(cfg: SettingsReader, section: string): T | undefined {
  const i = cfg.inspect<T>(section);
  if (!i) { return undefined; }
  return i.workspaceFolderValue ?? i.workspaceValue ?? i.globalValue ?? undefined;
}

/** Same, but an empty/whitespace-only string counts as unset. */
function userText(cfg: SettingsReader, section: string): string | undefined {
  const v = userValue<string>(cfg, section);
  if (typeof v !== 'string') { return undefined; }
  const trimmed = v.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Read every supervisor setting the user has explicitly set. */
export function readSupervisorSettings(cfg: SettingsReader): SupervisorSettings {
  return {
    engine: userText(cfg, 'supervisor.engine'),
    bobCliPath: userText(cfg, 'supervisor.bobCliPath'),
    claudeCliPath: userText(cfg, 'supervisor.claudeCliPath'),
    bobApiKey: userText(cfg, 'supervisor.bobApiKey'),
    anthropicBaseUrl: userText(cfg, 'supervisor.anthropicBaseUrl'),
    anthropicAuthToken: userText(cfg, 'supervisor.anthropicAuthToken'),
    classifierTimeoutSeconds: userValue<number>(cfg, 'supervisor.classifierTimeoutSeconds'),
    fastClassifier: userValue<boolean>(cfg, 'supervisor.fastClassifier'),
    fastClassifierModel: userText(cfg, 'supervisor.fastClassifierModel'),
    fastClassifierTimeoutSeconds: userValue<number>(cfg, 'supervisor.fastClassifierTimeoutSeconds'),
    fastClassifierBaseUrl: userText(cfg, 'supervisor.fastClassifierBaseUrl'),
    orangeResponseTimeoutMinutes: userValue<number>(cfg, 'supervisor.orangeResponseTimeoutMinutes'),
    messagingChannel: userText(cfg, 'supervisor.messagingChannel'),
    telegramBotToken: userText(cfg, 'supervisor.telegramBotToken'),
    telegramChatId: userText(cfg, 'supervisor.telegramChatId'),
    redNotify: userValue<boolean>(cfg, 'supervisor.redNotify'),
    notifyRuleDecisions: userValue<boolean>(cfg, 'supervisor.notifyRuleDecisions'),
    knowledgeRegistryPath: userText(cfg, 'knowledge.registryPath'),
    knowledgeLocalRepo: userText(cfg, 'dataRepoPath'),
    knowledgeRepo: userText(cfg, 'supervisor.knowledgeRepo'),
    knowledgeRef: userText(cfg, 'supervisor.knowledgeRef'),
  };
}

/** Layer explicitly-set settings over a base config (which already carries env/`.env`/defaults). */
export function applySupervisorSettings(
  base: SupervisorConfig, s: SupervisorSettings,
): SupervisorConfig {
  const num = (v: number | undefined, fallback: number): number =>
    (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
  return {
    ...base,
    supervisorEngine: (s.engine ?? base.supervisorEngine).toLowerCase(),
    bobCliPath: s.bobCliPath ?? base.bobCliPath,
    claudeCliPath: s.claudeCliPath ?? base.claudeCliPath,
    bobShellApiKey: s.bobApiKey ?? base.bobShellApiKey,
    anthropicBaseUrl: s.anthropicBaseUrl ?? base.anthropicBaseUrl,
    anthropicAuthToken: s.anthropicAuthToken ?? base.anthropicAuthToken,
    classifierTimeoutSeconds: num(s.classifierTimeoutSeconds, base.classifierTimeoutSeconds),
    fastClassifierEnabled: s.fastClassifier ?? base.fastClassifierEnabled,
    fastClassifierModel: s.fastClassifierModel ?? base.fastClassifierModel,
    fastClassifierTimeoutSeconds: num(
      s.fastClassifierTimeoutSeconds, base.fastClassifierTimeoutSeconds),
    fastClassifierBaseUrl: s.fastClassifierBaseUrl ?? base.fastClassifierBaseUrl,
    orangeResponseTimeoutMinutes: num(
      s.orangeResponseTimeoutMinutes, base.orangeResponseTimeoutMinutes),
    messagingChannel: (s.messagingChannel ?? base.messagingChannel).toLowerCase(),
    telegramBotToken: s.telegramBotToken ?? base.telegramBotToken,
    telegramChatId: s.telegramChatId ?? base.telegramChatId,
    redNotify: s.redNotify ?? base.redNotify,
    notifyRuleDecisions: s.notifyRuleDecisions ?? base.notifyRuleDecisions,
    knowledgeRegistryPath: s.knowledgeRegistryPath ?? base.knowledgeRegistryPath,
    knowledgeLocalRepo: s.knowledgeLocalRepo ?? base.knowledgeLocalRepo,
    knowledgeRepo: s.knowledgeRepo ?? base.knowledgeRepo,
    knowledgeRef: s.knowledgeRef ?? base.knowledgeRef,
  };
}

/**
 * The extension's supervisor configuration: settings over env/`.env` over defaults.
 * `reader` is injectable so tests need no VS Code host.
 */
export function supervisorConfigFromSettings(
  overrides: LoadConfigOverrides, reader?: SettingsReader,
): SupervisorConfig {
  const cfg = reader ?? vscode.workspace.getConfiguration('sessionSitter');
  return applySupervisorSettings(loadConfig(overrides), readSupervisorSettings(cfg));
}
