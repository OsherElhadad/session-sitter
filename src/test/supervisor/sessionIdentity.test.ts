/**
 * Naming the session a decision belongs to, and the machine it ran on.
 *
 * Every rendered surface — the Telegram card, the panel's activity feed — goes through these, so
 * the fallbacks matter as much as the happy path: a record written before the fields existed must
 * still read as it always did (`session: <id>`), never as an empty label.
 */

import { describe, it, expect } from 'vitest';
import {
  hostFromPeer,
  sessionDisplayName,
  sessionNameFrom,
  sessionRefLine,
  shortHost,
} from '../../supervisor/sessionIdentity';

describe('shortHost', () => {
  it('drops the DNS domain and trims', () => {
    expect(shortHost('devbox.lan')).toBe('devbox');
    expect(shortHost('  devbox  ')).toBe('devbox');
    expect(shortHost('devbox')).toBe('devbox');
  });

  it('is empty for nothing', () => {
    expect(shortHost('')).toBe('');
    expect(shortHost(null)).toBe('');
    expect(shortHost(undefined)).toBe('');
  });
});

describe('hostFromPeer', () => {
  it('takes the host out of a "user@host" peer spec', () => {
    expect(hostFromPeer('eranra@devbox')).toBe('devbox');
    expect(hostFromPeer('eranra@devbox.lan')).toBe('devbox');
  });

  it('accepts a bare host, and yields nothing for an absent peer', () => {
    expect(hostFromPeer('devbox')).toBe('devbox');
    expect(hostFromPeer(undefined)).toBe('');
    expect(hostFromPeer('')).toBe('');
  });
});

describe('sessionNameFrom', () => {
  it('prefers the title, falls back to the project name', () => {
    expect(sessionNameFrom({ title: 'fix the login flow', projectName: 'app' }))
      .toBe('fix the login flow');
    expect(sessionNameFrom({ title: '   ', projectName: 'app' })).toBe('app');
  });

  it('is null when the session has neither, so the display falls back to the id', () => {
    expect(sessionNameFrom({})).toBeNull();
    expect(sessionNameFrom({ title: '', projectName: '' })).toBeNull();
  });
});

describe('sessionDisplayName', () => {
  it('uses the recorded name, else the id', () => {
    expect(sessionDisplayName('fix the login flow', 'sess-1')).toBe('fix the login flow');
    expect(sessionDisplayName(null, 'sess-1')).toBe('sess-1');
    expect(sessionDisplayName('  ', 'sess-1')).toBe('sess-1');
  });
});

describe('sessionRefLine', () => {
  it('names the session, the machine, and keeps the id for support', () => {
    expect(sessionRefLine({
      session_name: 'fix the login flow', host: 'devbox', session_id: 'sess-1',
    })).toBe('session: fix the login flow @ devbox (sess-1)');
  });

  it('omits the host when the record has none', () => {
    expect(sessionRefLine({ session_name: 'fix the login flow', session_id: 'sess-1' }))
      .toBe('session: fix the login flow (sess-1)');
  });

  it('reads exactly as before for a record written without a name', () => {
    expect(sessionRefLine({ session_id: 'sess-1' })).toBe('session: sess-1');
    expect(sessionRefLine({ session_name: null, host: null, session_id: 'sess-1' }))
      .toBe('session: sess-1');
  });

  it('never repeats the id when the name IS the id', () => {
    expect(sessionRefLine({ session_name: 'sess-1', host: 'devbox', session_id: 'sess-1' }))
      .toBe('session: sess-1 @ devbox');
  });
});
