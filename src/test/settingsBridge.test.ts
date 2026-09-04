import { describe, it, expect } from 'vitest';
import {
  HEADLESS_EQUIVALENT, envNameFor, envNames, envSettingsReader, layeredSettingsReader,
} from '../settingsBridge';
import { remoteControlConfigFrom } from '../telegram/config';
import type { SupervisorConfig } from '../supervisor/config';

describe('the headless equivalent table', () => {
  it('names an equivalent for every setting, with no empty classification', () => {
    for (const [setting, how] of Object.entries(HEADLESS_EQUIVALENT)) {
      expect(how.kind, setting).toMatch(/^(env|flag|ide)$/);
      if (how.kind === 'env') { expect(how.name, setting).toMatch(/^[A-Z][A-Z0-9_]*$/); }
      if (how.kind === 'flag') { expect(how.name, setting).toMatch(/^--/); }
      // "No equivalent needed" is a claim, and an unexplained one is how a real gap gets filed
      // under this heading and forgotten.
      if (how.kind === 'ide') { expect(how.why.length, setting).toBeGreaterThan(30); }
    }
  });

  it('keys every entry by a full sessionSitter setting id', () => {
    for (const setting of Object.keys(HEADLESS_EQUIVALENT)) {
      expect(setting).toMatch(/^sessionSitter\./);
    }
  });

  it('maps a setting to its variable, and says so only for the env kind', () => {
    expect(envNameFor('sessionSitter.telegram.remoteControl'))
      .toBe('SESSION_SITTER_TELEGRAM_REMOTE_CONTROL');
    // A flag is not a variable, and reporting one would send someone exporting something inert.
    expect(envNameFor('sessionSitter.remotePeers')).toBeNull();
    expect(envNameFor('sessionSitter.workspaceColors')).toBeNull();
    expect(envNameFor('sessionSitter.nonexistent')).toBeNull();
  });

  it('lists only the env-settable ones', () => {
    const names = envNames();
    expect(names['sessionSitter.supervisor.engine']).toBe('SUPERVISOR_ENGINE');
    expect(names['sessionSitter.remotePeers']).toBeUndefined();
  });

  it('never maps two settings to the same variable', () => {
    const names = Object.values(envNames());
    // A shared variable means setting one thing changes another, which nobody would predict.
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('envSettingsReader', () => {
  it('falls back when the variable is unset, empty, or whitespace', () => {
    for (const env of [
      {},
      { SESSION_SITTER_TELEGRAM_REMOTE_CONTROL: '' },
      { SESSION_SITTER_TELEGRAM_REMOTE_CONTROL: '   ' },
    ]) {
      expect(envSettingsReader(env).getBoolean('telegram.remoteControl', false)).toBe(false);
    }
  });

  it('reads the spellings people actually use for a boolean', () => {
    for (const on of ['1', 'true', 'TRUE', 'yes', 'on', 'On']) {
      expect(envSettingsReader({ SESSION_SITTER_TELEGRAM_REMOTE_CONTROL: on }).getBoolean(
        'telegram.remoteControl', false), on).toBe(true);
    }
    for (const off of ['0', 'false', 'no', 'off']) {
      expect(envSettingsReader({ SESSION_SITTER_TELEGRAM_FULL_MESSAGES: off }).getBoolean(
        'telegram.fullMessages', true), off).toBe(false);
    }
  });

  /**
   * Falling back rather than throwing: a malformed `.env` should leave a setting at its default, which
   * is what a missing value already does. It must not stop the daemon starting.
   */
  it('falls back on a value it cannot read, rather than throwing', () => {
    expect(envSettingsReader({ SESSION_SITTER_TELEGRAM_REMOTE_CONTROL: 'perhaps' })
      .getBoolean('telegram.remoteControl', false)).toBe(false);
    expect(envSettingsReader({ SESSION_SITTER_TELEGRAM_MAX_MESSAGE_PARTS: 'lots' })
      .getNumber('telegram.maxMessageParts', 4)).toBe(4);
  });

  it('splits a list on commas or whitespace, and drops the gaps', () => {
    const read = (v: string): string[] => envSettingsReader({
      SESSION_SITTER_TELEGRAM_ALLOWED_USER_IDS: v,
    }).getStringArray('telegram.allowedUserIds', []);
    // Both separators, because both are what people type into a shell profile — and a list that
    // silently keeps a stray space becomes an id that never matches.
    expect(read('111,222')).toEqual(['111', '222']);
    expect(read('111 222')).toEqual(['111', '222']);
    expect(read(' 111 , 222 ')).toEqual(['111', '222']);
  });

  it('reads a number', () => {
    expect(envSettingsReader({ SESSION_SITTER_TELEGRAM_MAX_MESSAGE_PARTS: '7' })
      .getNumber('telegram.maxMessageParts', 4)).toBe(7);
  });

  it('returns the fallback for a key that is not env-settable at all', () => {
    expect(envSettingsReader({ ANYTHING: 'x' }).getBoolean('workspaceColors', true)).toBe(true);
  });
});

describe('layeredSettingsReader', () => {
  const none = {
    getBoolean: () => undefined,
    getStringArray: () => undefined,
    getNumber: () => undefined,
  };

  it('uses the environment when the user has set nothing', () => {
    const reader = layeredSettingsReader(none, {
      SESSION_SITTER_TELEGRAM_REMOTE_CONTROL: 'on',
      SESSION_SITTER_TELEGRAM_MAX_MESSAGE_PARTS: '9',
      SESSION_SITTER_TELEGRAM_ALLOWED_USER_IDS: '42',
    });
    expect(reader.getBoolean('telegram.remoteControl', false)).toBe(true);
    expect(reader.getNumber('telegram.maxMessageParts', 4)).toBe(9);
    expect(reader.getStringArray('telegram.allowedUserIds', [])).toEqual(['42']);
  });

  /**
   * The precedence that makes an existing env-based install keep working while never quietly
   * overriding something a person typed into the Settings UI.
   */
  it('prefers what the user explicitly set over the environment', () => {
    const reader = layeredSettingsReader({
      getBoolean: () => false,
      getStringArray: () => ['explicit'],
      getNumber: () => 2,
    }, {
      SESSION_SITTER_TELEGRAM_REMOTE_CONTROL: 'on',
      SESSION_SITTER_TELEGRAM_MAX_MESSAGE_PARTS: '9',
      SESSION_SITTER_TELEGRAM_ALLOWED_USER_IDS: '42',
    });
    expect(reader.getBoolean('telegram.remoteControl', true)).toBe(false);
    expect(reader.getNumber('telegram.maxMessageParts', 4)).toBe(2);
    expect(reader.getStringArray('telegram.allowedUserIds', [])).toEqual(['explicit']);
  });

  it('keeps an explicit `false`, rather than treating it as unset', () => {
    const reader = layeredSettingsReader(
      { ...none, getBoolean: () => false },
      { SESSION_SITTER_TELEGRAM_REMOTE_CONTROL: 'on' });
    // `??` and not `||`: a user who turned this off must not be overridden by a stale variable.
    expect(reader.getBoolean('telegram.remoteControl', true)).toBe(false);
  });

  it('falls through to the declared default when neither says anything', () => {
    const reader = layeredSettingsReader(none, {});
    expect(reader.getBoolean('telegram.fullMessages', true)).toBe(true);
    expect(reader.getNumber('telegram.maxMessageParts', 4)).toBe(4);
  });
});

describe('the Telegram remote interface, configured with no VS Code', () => {
  const supervisor = { telegramBotToken: 't', telegramChatId: 'c' } as SupervisorConfig;
  const noSettings = {
    getBoolean: () => undefined,
    getStringArray: () => undefined,
    getNumber: () => undefined,
  };

  it('can be turned on entirely from the environment', () => {
    const config = remoteControlConfigFrom(
      layeredSettingsReader(noSettings, {
        SESSION_SITTER_TELEGRAM_REMOTE_CONTROL: 'on',
        SESSION_SITTER_TELEGRAM_ALLOWED_USER_IDS: '111,222',
        SESSION_SITTER_TELEGRAM_MAX_MESSAGE_PARTS: '6',
      }),
      supervisor);
    expect(config.enabled).toBe(true);
    expect(config.allowedUserIds).toEqual(['111', '222']);
    expect(config.maxMessageParts).toBe(6);
  });

  /**
   * The default that matters most: an empty allow-list authorises nobody. A headless path that
   * accidentally defaulted this open would be a remote-control interface anyone could drive.
   */
  it('authorises nobody when the allow-list is not set', () => {
    const config = remoteControlConfigFrom(
      layeredSettingsReader(noSettings, { SESSION_SITTER_TELEGRAM_REMOTE_CONTROL: 'on' }),
      supervisor);
    expect(config.allowedUserIds).toEqual([]);
  });

  it('is off unless it is turned on', () => {
    expect(remoteControlConfigFrom(layeredSettingsReader(noSettings, {}), supervisor).enabled)
      .toBe(false);
  });
});
