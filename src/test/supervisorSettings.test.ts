/**
 * The supervisor is configured from `sessionSitter.*` settings. Environment variables and `.env`
 * files remain only as a fallback for values the user has NOT set, so an existing env-based
 * install keeps working — this pins that precedence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// supervisorSettings.ts imports 'vscode' at module load; the tests inject a reader instead.
vi.mock('vscode', () => ({ workspace: { getConfiguration: vi.fn() } }));
import {
  applySupervisorSettings,
  readSupervisorSettings,
  supervisorConfigFromSettings,
  userValue,
  type SettingsReader,
} from '../supervisorSettings';
import { loadConfig } from '../supervisor/config';

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'SUPERVISOR_ENGINE', 'MESSAGING_CHANNEL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
  'ORANGE_RESPONSE_TIMEOUT_MINUTES', 'RED_NOTIFY', 'NOTIFY_RULE_DECISIONS', 'BOB_CLI_PATH',
  'BOBSHELL_API_KEY', 'BOB_API_KEY', 'KNOWLEDGE_REF', 'STATE_DIR',
];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-settings-'));
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) { delete process.env[k]; } else { process.env[k] = savedEnv[k]; }
  }
});

/**
 * A settings reader over a plain map of user-set values. Anything absent from the map is
 * "not set by the user", which is exactly what `inspect()` reports for a package.json default.
 */
function reader(values: Record<string, unknown>): SettingsReader {
  return {
    inspect: <T>(section: string) => (
      section in values
        ? { globalValue: values[section] as T }
        : { globalValue: undefined }
    ),
  };
}

describe('userValue', () => {
  it('prefers the most specific scope the user set', () => {
    const cfg: SettingsReader = {
      inspect: <T>() => ({
        globalValue: 'user' as unknown as T,
        workspaceValue: 'workspace' as unknown as T,
        workspaceFolderValue: 'folder' as unknown as T,
      }),
    };
    expect(userValue<string>(cfg, 'anything')).toBe('folder');
  });

  it('is undefined when only the package.json default applies', () => {
    expect(userValue<string>(reader({}), 'supervisor.engine')).toBeUndefined();
  });
});

describe('readSupervisorSettings', () => {
  it('reads every supervisor setting the user set', () => {
    const s = readSupervisorSettings(reader({
      'supervisor.engine': 'claude',
      'supervisor.claudeCliPath': '/opt/bin/claude',
      'supervisor.messagingChannel': 'telegram',
      'supervisor.telegramBotToken': '123:abc',
      'supervisor.telegramChatId': '-1001',
      'supervisor.classifierTimeoutSeconds': 90,
      'supervisor.orangeResponseTimeoutMinutes': 5,
      'supervisor.redNotify': false,
      'supervisor.notifyRuleDecisions': false,
      'supervisor.knowledgeRef': 'develop',
      'dataRepoPath': '/home/me/corpus',
      'knowledge.registryPath': '/home/me/registry.md',
    }));
    expect(s).toMatchObject({
      engine: 'claude',
      claudeCliPath: '/opt/bin/claude',
      messagingChannel: 'telegram',
      telegramBotToken: '123:abc',
      telegramChatId: '-1001',
      classifierTimeoutSeconds: 90,
      orangeResponseTimeoutMinutes: 5,
      redNotify: false,
      notifyRuleDecisions: false,
      knowledgeRef: 'develop',
      knowledgeLocalRepo: '/home/me/corpus',
      knowledgeRegistryPath: '/home/me/registry.md',
    });
  });

  it('treats an empty or whitespace-only string as unset', () => {
    const s = readSupervisorSettings(reader({
      'supervisor.telegramBotToken': '',
      'supervisor.bobCliPath': '   ',
    }));
    expect(s.telegramBotToken).toBeUndefined();
    expect(s.bobCliPath).toBeUndefined();
  });

  it('trims surrounding whitespace off a path', () => {
    const s = readSupervisorSettings(reader({ 'supervisor.bobCliPath': ' /opt/bob ' }));
    expect(s.bobCliPath).toBe('/opt/bob');
  });
});

describe('applySupervisorSettings', () => {
  const base = loadConfig({ workspaceRoot: '/tmp/root', stateDir: '/tmp/state' });

  it('leaves the base untouched when nothing is set', () => {
    expect(applySupervisorSettings(base, {})).toEqual(base);
  });

  it('overrides only what is set', () => {
    const out = applySupervisorSettings(base, { engine: 'CLAUDE', notifyRuleDecisions: false });
    expect(out.supervisorEngine).toBe('claude'); // normalized to lower case
    expect(out.notifyRuleDecisions).toBe(false);
    expect(out.bobCliPath).toBe(base.bobCliPath); // untouched
  });

  it('ignores a nonsensical number rather than breaking the timer', () => {
    const out = applySupervisorSettings(base, {
      orangeResponseTimeoutMinutes: Number.NaN, classifierTimeoutSeconds: -5,
    });
    expect(out.orangeResponseTimeoutMinutes).toBe(base.orangeResponseTimeoutMinutes);
    expect(out.classifierTimeoutSeconds).toBe(base.classifierTimeoutSeconds);
  });

  it('honors `false` for a boolean the user explicitly turned off', () => {
    expect(applySupervisorSettings(base, { redNotify: false }).redNotify).toBe(false);
  });
});

describe('supervisorConfigFromSettings', () => {
  it('lets a setting win over the same value in the environment', () => {
    process.env.SUPERVISOR_ENGINE = 'bob';
    process.env.TELEGRAM_CHAT_ID = 'from-env';
    const cfg = supervisorConfigFromSettings(
      { workspaceRoot: tmp, stateDir: path.join(tmp, 'state') },
      reader({ 'supervisor.engine': 'claude', 'supervisor.telegramChatId': 'from-settings' }),
    );
    expect(cfg.supervisorEngine).toBe('claude');
    expect(cfg.telegramChatId).toBe('from-settings');
  });

  it('falls back to the environment for a setting the user left empty', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'env-token';
    process.env.MESSAGING_CHANNEL = 'telegram';
    const cfg = supervisorConfigFromSettings(
      { workspaceRoot: tmp, stateDir: path.join(tmp, 'state') },
      reader({ 'supervisor.telegramBotToken': '' }),
    );
    expect(cfg.telegramBotToken).toBe('env-token');
    expect(cfg.messagingChannel).toBe('telegram');
  });

  it('falls back to a .env file, then to the built-in defaults', () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'BOB_CLI_PATH=/opt/bob\n', 'utf8');
    const cfg = supervisorConfigFromSettings(
      { workspaceRoot: tmp, stateDir: path.join(tmp, 'state') }, reader({}));
    expect(cfg.bobCliPath).toBe('/opt/bob');
    expect(cfg.supervisorEngine).toBe('bob');       // built-in default
    expect(cfg.notifyRuleDecisions).toBe(true);     // built-in default: rules ARE reported
    expect(cfg.stateDir).toBe(path.join(tmp, 'state'));
  });
});
