/**
 * Configuration layering (overrides > process env > `.env` > defaults), the derived state
 * directories, and the CLI argument contract.
 *
 * Ports `supervisor/tests/test_cli.py` and the config half of the Python suite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_ORANGE_TIMEOUT_MINUTES,
  DEFAULT_SUPERVISOR_ENGINE,
  ensureDirs,
  historyDir,
  inboxDir,
  loadConfig,
  loadDotenv,
  notificationsDir,
  outboxDir,
  recordsDir,
} from '../../supervisor/config';
import { normalizeArgv, parseArgs } from '../../supervisor/cli';
import { buildChannel, buildEngine, buildOrchestrator } from '../../supervisor/factory';
import { StubChannel } from '../../supervisor/messaging';
import { TelegramChannel } from '../../supervisor/telegram';
import { BobCliEngine, ClaudeCodeEngine } from '../../supervisor/engine';
import { makeConfig, makeTmpDir } from './fixtures';

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'STATE_DIR', 'SUPERVISOR_ENGINE', 'MESSAGING_CHANNEL', 'ORANGE_RESPONSE_TIMEOUT_MINUTES',
  'RED_NOTIFY', 'BOBSHELL_API_KEY', 'BOB_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
  'KB_SITTER_LOCAL_REPO', 'KNOWLEDGE_LOCAL_REPO', 'CLAUDE_TIMEOUT_SECONDS',
];

beforeEach(() => {
  tmp = makeTmpDir('config-');
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) { delete process.env[k]; } else { process.env[k] = savedEnv[k]; }
  }
});

describe('loadDotenv', () => {
  it('reads KEY=VALUE lines, strips quotes, and skips comments', () => {
    const p = path.join(tmp, '.env');
    fs.writeFileSync(p, [
      '# a comment',
      '',
      'PLAIN=value',
      'QUOTED="quoted value"',
      "SINGLE='single'",
      'SPACED = spaced ',
      'EMPTY=',
      'no_equals_here',
    ].join('\n'), 'utf8');

    expect(loadDotenv(p)).toEqual({
      PLAIN: 'value', QUOTED: 'quoted value', SINGLE: 'single', SPACED: 'spaced', EMPTY: '',
    });
  });

  it('returns nothing for a missing file instead of throwing', () => {
    expect(loadDotenv(path.join(tmp, 'nope.env'))).toEqual({});
  });
});

describe('loadConfig', () => {
  it('falls back to documented defaults', () => {
    const cfg = loadConfig({ workspaceRoot: tmp });
    expect(cfg.supervisorEngine).toBe(DEFAULT_SUPERVISOR_ENGINE);
    expect(cfg.orangeResponseTimeoutMinutes).toBe(DEFAULT_ORANGE_TIMEOUT_MINUTES);
    expect(cfg.messagingChannel).toBe('stub');
    expect(cfg.redNotify).toBe(true);
    expect(cfg.stateDir).toBe(path.join(tmp, '.supervisor-state'));
  });

  it('reads a .env at the workspace root', () => {
    fs.writeFileSync(path.join(tmp, '.env'),
      'SUPERVISOR_ENGINE=claude\nORANGE_RESPONSE_TIMEOUT_MINUTES=5\nRED_NOTIFY=0\n', 'utf8');
    const cfg = loadConfig({ workspaceRoot: tmp });
    expect(cfg.supervisorEngine).toBe('claude');
    expect(cfg.orangeResponseTimeoutMinutes).toBe(5);
    expect(cfg.redNotify).toBe(false);
  });

  it('lets the process environment win over .env', () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'SUPERVISOR_ENGINE=claude\n', 'utf8');
    process.env.SUPERVISOR_ENGINE = 'bob';
    expect(loadConfig({ workspaceRoot: tmp }).supervisorEngine).toBe('bob');
  });

  it('lets an explicit override win over everything', () => {
    process.env.STATE_DIR = path.join(tmp, 'from-env');
    const cfg = loadConfig({ workspaceRoot: tmp, stateDir: path.join(tmp, 'explicit') });
    expect(cfg.stateDir).toBe(path.join(tmp, 'explicit'));
  });

  it('layers extra .env files last', () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'MESSAGING_CHANNEL=stub\n', 'utf8');
    const extra = path.join(tmp, 'extra.env');
    fs.writeFileSync(extra, 'MESSAGING_CHANNEL=telegram\n', 'utf8');
    expect(loadConfig({ workspaceRoot: tmp, envFiles: [extra] }).messagingChannel)
      .toBe('telegram');
  });

  it('accepts either name for the Bob API key', () => {
    process.env.BOB_API_KEY = 'from-bob-api-key';
    expect(loadConfig({ workspaceRoot: tmp }).bobShellApiKey).toBe('from-bob-api-key');
    process.env.BOBSHELL_API_KEY = 'from-bobshell';
    expect(loadConfig({ workspaceRoot: tmp }).bobShellApiKey).toBe('from-bobshell');
  });

  it('accepts the legacy knowledge env names', () => {
    process.env.KB_SITTER_LOCAL_REPO = '/legacy/repo';
    expect(loadConfig({ workspaceRoot: tmp }).knowledgeLocalRepo).toBe('/legacy/repo');
    process.env.KNOWLEDGE_LOCAL_REPO = '/new/repo';
    expect(loadConfig({ workspaceRoot: tmp }).knowledgeLocalRepo).toBe('/new/repo');
  });

  it('ignores a non-numeric interval rather than crashing', () => {
    process.env.ORANGE_RESPONSE_TIMEOUT_MINUTES = 'soon';
    expect(loadConfig({ workspaceRoot: tmp }).orangeResponseTimeoutMinutes)
      .toBe(DEFAULT_ORANGE_TIMEOUT_MINUTES);
  });

  it('reads every truthy spelling for a boolean', () => {
    for (const raw of ['1', 'true', 'YES', 'on']) {
      process.env.RED_NOTIFY = raw;
      expect(loadConfig({ workspaceRoot: tmp }).redNotify, raw).toBe(true);
    }
    for (const raw of ['0', 'false', 'no', '']) {
      process.env.RED_NOTIFY = raw;
      expect(loadConfig({ workspaceRoot: tmp }).redNotify, raw).toBe(false);
    }
  });

  it('expands a leading ~ in STATE_DIR', () => {
    process.env.STATE_DIR = '~/state-here';
    expect(loadConfig({ workspaceRoot: tmp }).stateDir)
      .toBe(path.join(os.homedir(), 'state-here'));
  });
});

describe('the state directory layout', () => {
  it('derives every sub-directory and creates them', () => {
    const cfg = makeConfig(path.join(tmp, 'state'));
    expect(historyDir(cfg)).toBe(path.join(cfg.stateDir, 'history'));
    expect(outboxDir(cfg)).toBe(path.join(cfg.stateDir, 'outbox'));
    expect(inboxDir(cfg)).toBe(path.join(cfg.stateDir, 'inbox'));
    expect(recordsDir(cfg)).toBe(path.join(cfg.stateDir, 'records'));
    expect(notificationsDir(cfg)).toBe(path.join(cfg.stateDir, 'notifications'));

    ensureDirs(cfg);
    for (const d of [historyDir, outboxDir, inboxDir, recordsDir, notificationsDir]) {
      expect(fs.existsSync(d(cfg))).toBe(true);
    }
    ensureDirs(cfg); // idempotent
  });
});

describe('the factory', () => {
  it('builds the stub channel by default', () => {
    expect(buildChannel(makeConfig(path.join(tmp, 's')))).toBeInstanceOf(StubChannel);
  });

  it('builds the Telegram channel when it is configured', () => {
    const cfg = makeConfig(path.join(tmp, 's'), {
      messagingChannel: 'telegram', telegramBotToken: 'tok', telegramChatId: '42',
    });
    expect(buildChannel(cfg)).toBeInstanceOf(TelegramChannel);
  });

  it('falls back to the stub — with a warning — when Telegram credentials are missing', () => {
    const logs: string[] = [];
    const cfg = makeConfig(path.join(tmp, 's'), { messagingChannel: 'telegram' });
    expect(buildChannel(cfg, m => logs.push(m))).toBeInstanceOf(StubChannel);
    expect(logs.join('\n')).toContain('missing');
  });

  it('selects the engine named by the configuration', () => {
    expect(buildEngine(makeConfig(path.join(tmp, 's')))).toBeInstanceOf(BobCliEngine);
    expect(buildEngine(makeConfig(path.join(tmp, 's'), { supervisorEngine: 'claude' })))
      .toBeInstanceOf(ClaudeCodeEngine);
  });

  it('wires an orchestrator over a created state directory', () => {
    const cfg = makeConfig(path.join(tmp, 'state'));
    const orch = buildOrchestrator({ config: cfg });
    expect(orch.config.stateDir).toBe(cfg.stateDir);
    expect(fs.existsSync(recordsDir(cfg))).toBe(true);
  });
});

describe('the CLI argument contract', () => {
  it('treats a bare session id as the run command', () => {
    expect(normalizeArgv(['sess-1'])).toEqual(['run', 'sess-1']);
    expect(normalizeArgv(['run', 'sess-1'])).toEqual(['run', 'sess-1']);
    expect(normalizeArgv(['poll'])).toEqual(['poll']);
    expect(normalizeArgv(['--help'])).toEqual(['--help']);
    expect(normalizeArgv([])).toEqual([]);
  });

  it('parses run with its routing triple and a transcript override', () => {
    const args = parseArgs([
      'sess-1', '--user', 'alice', '--project', 'demo', '--team', 'platform',
      '--transcript', '/tmp/export.json', '--state-dir', '/tmp/state',
    ]);
    expect(args).toMatchObject({
      command: 'run', sessionId: 'sess-1', user: 'alice', project: 'demo', team: 'platform',
      transcript: '/tmp/export.json', stateDir: '/tmp/state',
    });
  });

  it('parses poll with an interval, defaulting to a single pass', () => {
    expect(parseArgs(['poll'])).toMatchObject({ command: 'poll', loop: 0 });
    expect(parseArgs(['poll', '--loop', '5'])).toMatchObject({ command: 'poll', loop: 5 });
  });

  it('accepts --repo-root as an alias for --workspace-root', () => {
    expect(parseArgs(['poll', '--repo-root', '/w']).workspaceRoot).toBe('/w');
    expect(parseArgs(['poll', '--workspace-root', '/w']).workspaceRoot).toBe('/w');
  });

  it('rejects a missing session id, an unknown option, and a stray argument', () => {
    expect(() => parseArgs(['run'])).toThrow(/needs a <session_id>/);
    expect(() => parseArgs(['poll', '--nope'])).toThrow(/unknown option/);
    expect(() => parseArgs(['poll', '--loop'])).toThrow(/needs a value/);
    expect(() => parseArgs(['run', 'a', 'b'])).toThrow(/unexpected argument/);
  });

  it('reads any bare first word as a session id, per the documented shorthand', () => {
    // `supervise <session_id>` is the shorthand, so there is no such thing as an unknown
    // command in first position — it is a session id.
    expect(parseArgs(['fly'])).toMatchObject({ command: 'run', sessionId: 'fly' });
  });
});
