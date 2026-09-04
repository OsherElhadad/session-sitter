import { describe, expect, it } from 'vitest';
import {
  effectiveMessageParts,
  remoteControlConfigFrom,
  startupBlocker,
  type RemoteControlConfig,
  type SettingsReader,
} from '../../telegram/config';
import { MAX_MESSAGE_PARTS_DEFAULT, MAX_MESSAGE_PARTS_LIMIT } from '../../telegram/render';
import type { SupervisorConfig } from '../../supervisor/config';

function settings(values: Record<string, unknown> = {}): SettingsReader {
  return {
    getBoolean: (key, fallback) => (key in values ? values[key] as boolean : fallback),
    getStringArray: (key, fallback) => (key in values ? values[key] as string[] : fallback),
    getNumber: (key, fallback) => (key in values ? values[key] as number : fallback),
  };
}

function supervisor(over: Partial<SupervisorConfig> = {}): SupervisorConfig {
  return {
    telegramBotToken: 'tok',
    telegramChatId: '-100999',
    ...over,
  } as SupervisorConfig;
}

function config(over: Partial<RemoteControlConfig> = {}): RemoteControlConfig {
  return {
    enabled: true,
    botToken: 'tok',
    chatId: '-100999',
    allowedUserIds: ['42'],
    fullMessages: true,
    maxMessageParts: MAX_MESSAGE_PARTS_DEFAULT,
    ...over,
  };
}

describe('remoteControlConfigFrom', () => {
  it('is off unless the switch is set', () => {
    expect(remoteControlConfigFrom(settings(), supervisor()).enabled).toBe(false);
  });

  it('reuses the supervisor token and chat id, so the group is shared', () => {
    const cfg = remoteControlConfigFrom(settings(), supervisor());
    expect(cfg.botToken).toBe('tok');
    expect(cfg.chatId).toBe('-100999');
  });

  it('tolerates a missing token and chat id without throwing', () => {
    const cfg = remoteControlConfigFrom(
      settings(), supervisor({ telegramBotToken: null, telegramChatId: null }));
    expect(cfg.botToken).toBe('');
    expect(cfg.chatId).toBe('');
  });

  it('trims ids and drops empty entries, so a stray comma cannot break matching', () => {
    const cfg = remoteControlConfigFrom(
      settings({ 'telegram.allowedUserIds': [' 42 ', '', '  '] }), supervisor());
    expect(cfg.allowedUserIds).toEqual(['42']);
  });

  it('trims a pasted token and chat id', () => {
    const cfg = remoteControlConfigFrom(
      settings(), supervisor({ telegramBotToken: ' tok ', telegramChatId: ' -1 ' }));
    expect(cfg.botToken).toBe('tok');
    expect(cfg.chatId).toBe('-1');
  });
});

describe('startupBlocker', () => {
  it('has nothing to say when the feature is off', () => {
    expect(startupBlocker(config({ enabled: false }))).toBeNull();
  });

  it('passes a complete configuration', () => {
    expect(startupBlocker(config())).toBeNull();
  });

  it('steers a missing token to the environment, because each machine needs its own bot', () => {
    const blocker = startupBlocker(config({ botToken: '' }));
    expect(blocker).toContain('TELEGRAM_BOT_TOKEN');
    expect(blocker).toContain('.env');
  });

  it('reports a missing chat id', () => {
    expect(startupBlocker(config({ chatId: '' }))).toContain('chat id');
  });

  it('refuses to start with an empty allowlist', () => {
    // Starting anyway would connect, create topics, and silently discard every message — which
    // looks like a broken bot rather than an unfinished setup.
    const blocker = startupBlocker(config({ allowedUserIds: [] }));
    expect(blocker).toContain('allowedUserIds');
  });

  it('reports the token before the allowlist, so setup is fixed in order', () => {
    expect(startupBlocker(config({ botToken: '', allowedUserIds: [] }))).toContain('bot token');
  });
});

describe('remoteControlConfigFrom message parts', () => {
  it('mirrors whole turns unless told otherwise', () => {
    // Default-on: the truncated mirror was unusable away from the machine, so the fix is not
    // something a user should have to discover a setting to get.
    expect(remoteControlConfigFrom(settings(), supervisor()).fullMessages).toBe(true);
  });

  it('can be switched back to the one-message preview', () => {
    const cfg = remoteControlConfigFrom(
      settings({ 'telegram.fullMessages': false }), supervisor());
    expect(cfg.fullMessages).toBe(false);
  });

  it('defaults the budget to more than one message', () => {
    expect(remoteControlConfigFrom(settings(), supervisor()).maxMessageParts)
      .toBe(MAX_MESSAGE_PARTS_DEFAULT);
  });

  it('takes the budget from settings', () => {
    expect(remoteControlConfigFrom(
      settings({ 'telegram.maxMessageParts': 8 }), supervisor()).maxMessageParts).toBe(8);
  });

  it('clamps a budget that would spend more than a minute of the group’s allowance', () => {
    // Telegram takes ~20 messages a minute for one group. A setting of 500 would wedge every
    // other topic behind one answer, so the ceiling is enforced here rather than trusted.
    expect(remoteControlConfigFrom(
      settings({ 'telegram.maxMessageParts': 500 }), supervisor()).maxMessageParts)
      .toBe(MAX_MESSAGE_PARTS_LIMIT);
  });

  it('clamps a zero, negative or fractional budget to one whole message', () => {
    for (const bad of [0, -4, 0.5]) {
      expect(remoteControlConfigFrom(
        settings({ 'telegram.maxMessageParts': bad }), supervisor()).maxMessageParts).toBe(1);
    }
  });

  it('falls back to the default when the setting is not a number', () => {
    // VS Code will hand back whatever is in settings.json, including a string.
    expect(remoteControlConfigFrom(
      settings({ 'telegram.maxMessageParts': 'lots' }), supervisor()).maxMessageParts)
      .toBe(MAX_MESSAGE_PARTS_DEFAULT);
  });

  it('reports the effective budget as 1 when full mode is off', () => {
    // One place decides it, so the service never has to combine the two settings itself.
    const cfg = remoteControlConfigFrom(
      settings({ 'telegram.fullMessages': false, 'telegram.maxMessageParts': 8 }), supervisor());
    expect(effectiveMessageParts(cfg)).toBe(1);
    expect(effectiveMessageParts(config({ fullMessages: true, maxMessageParts: 8 }))).toBe(8);
  });
});
