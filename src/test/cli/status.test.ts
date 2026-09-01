import { describe, it, expect } from 'vitest';
import { CliError } from '../../cli/args';
import type { ClaudeSession } from '../../sessionScan';
import { attentionOf, filterSessions, sortByAttention } from '../../cli/sessions';
import { renderJson, renderText, run, parseStatusArgs, type StatusOptions } from '../../cli/status';
import { fakeIo } from './fakeIo';

const NOW = new Date('2026-09-01T09:00:00.000Z');

function session(over: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    sessionId: 'aaa',
    projectName: 'session-sitter',
    projectPath: '/home/u/session-sitter',
    title: 'extract the pure readers',
    updatedAt: new Date(NOW.getTime() - 60_000),
    status: 'idle',
    source: 'claude',
    ...over,
  };
}

const OPTIONS: StatusOptions = {
  needsMe: false, sort: 'needs-me', peers: false, json: false,
};

describe('attentionOf', () => {
  it('names what the session is waiting on, from the human side', () => {
    // `idle` in the store means the agent finished and the transcript went quiet — your turn.
    expect(attentionOf({ status: 'idle' })).toBe('needs-you');
    expect(attentionOf({ status: 'active' })).toBe('working');
    expect(attentionOf({ status: 'waiting' })).toBe('queued');
  });

  it('treats an unknown status as needing a human, never as safe to ignore', () => {
    expect(attentionOf({ status: 'something-new' })).toBe('needs-you');
  });
});

describe('sortByAttention', () => {
  it('leads with the sessions that need you, newest first inside each group', () => {
    const rows = sortByAttention([
      session({ sessionId: 'working-old', status: 'active', updatedAt: new Date(NOW.getTime() - 5_000) }),
      session({ sessionId: 'needs-old', updatedAt: new Date(NOW.getTime() - 900_000) }),
      session({ sessionId: 'needs-new', updatedAt: new Date(NOW.getTime() - 30_000) }),
      session({ sessionId: 'queued', status: 'waiting' }),
    ]);
    expect(rows.map(r => r.sessionId)).toEqual(['needs-new', 'needs-old', 'working-old', 'queued']);
  });

  it('breaks a full tie on the session id, so the order holds between passes', () => {
    const at = new Date(NOW.getTime() - 1000);
    const rows = sortByAttention([
      session({ sessionId: 'b', updatedAt: at }),
      session({ sessionId: 'a', updatedAt: at }),
    ]);
    expect(rows.map(r => r.sessionId)).toEqual(['a', 'b']);
  });

  it('does not mutate its input', () => {
    const input = [session({ sessionId: 'b' }), session({ sessionId: 'a' })];
    sortByAttention(input);
    expect(input.map(s => s.sessionId)).toEqual(['b', 'a']);
  });
});

describe('filterSessions', () => {
  const sessions = [
    session({ sessionId: 'recent-claude' }),
    session({ sessionId: 'old-claude', updatedAt: new Date(NOW.getTime() - 3 * 86_400_000) }),
    session({ sessionId: 'chat', source: 'chat' }),
    session({ sessionId: 'busy', status: 'active' }),
  ];

  it('drops sessions older than the window', () => {
    expect(filterSessions(sessions, { since: new Date(NOW.getTime() - 86_400_000) })
      .map(s => s.sessionId)).toEqual(['recent-claude', 'chat', 'busy']);
  });

  it('filters by agent', () => {
    expect(filterSessions(sessions, { agent: 'chat' }).map(s => s.sessionId)).toEqual(['chat']);
  });

  it('--needs-me keeps only the sessions whose turn it is for a human', () => {
    expect(filterSessions(sessions, { needsMe: true }).map(s => s.sessionId))
      .toEqual(['recent-claude', 'old-claude', 'chat']);
  });

  it('keeps everything with no filter', () => {
    expect(filterSessions(sessions, {})).toHaveLength(4);
  });
});

describe('parseStatusArgs', () => {
  const io = fakeIo({ now: NOW });

  it('defaults to a 24-hour window and the needs-me order', () => {
    const options = parseStatusArgs([], io);
    expect(options.sort).toBe('needs-me');
    expect(options.since).toEqual(new Date(NOW.getTime() - 86_400_000));
  });

  it('--all lifts the window', () => {
    expect(parseStatusArgs(['--all'], io).since).toBeUndefined();
  });

  it('rejects contradictions rather than silently preferring one', () => {
    expect(() => parseStatusArgs(['--all', '--since', '2h'], io)).toThrow(/contradict/);
    expect(() => parseStatusArgs(['--watch', '--json'], io)).toThrow(/cannot be combined/);
  });

  it('accepts every order sessionSort defines, and rejects anything else', () => {
    for (const mode of ['recent', 'workspace', 'hostWorkspace', 'status', 'source', 'title']) {
      expect(parseStatusArgs(['--sort', mode], io).sort).toBe(mode);
    }
    expect(() => parseStatusArgs(['--sort', 'sideways'], io)).toThrow(/unknown --sort/);
  });

  it('rejects an agent it cannot filter by', () => {
    expect(parseStatusArgs(['--agent', 'CLAUDE'], io).agent).toBe('claude');
    expect(() => parseStatusArgs(['--agent', 'gemini'], io)).toThrow(/unknown --agent/);
  });

  it('refuses --watch when stdout is not a terminal', () => {
    // Into a pipe the escapes are garbage and the frames append forever.
    expect(() => parseStatusArgs(['--watch'], io)).toThrow(/--watch needs a terminal/);
    const tty = fakeIo({ now: NOW, isTty: true });
    expect(parseStatusArgs(['--watch'], tty).watchSeconds).toBe(5);
    expect(parseStatusArgs(['--watch', '2'], tty).watchSeconds).toBe(2);
    expect(() => parseStatusArgs(['--watch', '0'], tty)).toThrow(/at least 1 second/);
  });

  it('rejects a positional argument', () => {
    expect(() => parseStatusArgs(['claude'], io)).toThrow(CliError);
  });
});

describe('renderText', () => {
  const sessions = [
    session({ sessionId: 'a', title: 'needs a human' }),
    session({ sessionId: 'b', title: 'running tools', status: 'active' }),
  ];

  it('emits no escape sequences at all when stdout is a pipe', () => {
    const io = fakeIo({ now: NOW });
    const out = renderText(sessions, { sessions, peers: [] }, OPTIONS, io);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\u001b\[/);
    expect(out).toContain('needs you');
    expect(out).toContain('working');
    expect(out).toContain('2 sessions');
  });

  it('paints when stdout is a terminal', () => {
    const io = fakeIo({ now: NOW, isTty: true });
    // eslint-disable-next-line no-control-regex
    expect(renderText(sessions, { sessions, peers: [] }, OPTIONS, io)).toMatch(/\u001b\[/);
  });

  it('honours NO_COLOR on a terminal', () => {
    const io = fakeIo({ now: NOW, isTty: true, env: { NO_COLOR: '1' } });
    // eslint-disable-next-line no-control-regex
    expect(renderText(sessions, { sessions, peers: [] }, OPTIONS, io)).not.toMatch(/\u001b\[/);
  });

  it('omits the machine column when everything is local', () => {
    const io = fakeIo({ now: NOW });
    expect(renderText(sessions, { sessions, peers: [] }, OPTIONS, io)).not.toContain('MACHINE');
  });

  it('shows the machine column, by short host, once a peer is in the list', () => {
    const io = fakeIo({ now: NOW });
    const withPeer = [...sessions, session({ sessionId: 'c', peer: 'u@buildbox.example.com' })];
    const out = renderText(withPeer, { sessions: withPeer, peers: [] }, OPTIONS, io);
    expect(out).toContain('MACHINE');
    expect(out).toContain('buildbox');
    expect(out).not.toContain('buildbox.example.com');
  });

  it('says so when a session list is empty instead of printing a bare header', () => {
    const io = fakeIo({ now: NOW });
    expect(renderText([], { sessions: [], peers: [] }, OPTIONS, io)).toContain('No sessions match');
  });

  it('reports an unreachable peer rather than dropping it silently', () => {
    const io = fakeIo({ now: NOW });
    const out = renderText(sessions, {
      sessions,
      peers: [{ peer: 'u@dead', reachable: false, error: 'publickey' }],
    }, { ...OPTIONS, peers: true }, io);
    expect(out).toContain('unreachable');
    expect(out).toContain('publickey');
  });

  it('says peers were not asked for, so an absent machine is never a mystery', () => {
    const io = fakeIo({ now: NOW });
    expect(renderText(sessions, { sessions, peers: [] }, OPTIONS, io))
      .toContain('Peer machines not included');
  });
});

describe('renderJson', () => {
  it('matches the documented version 1 contract', () => {
    const sessions = [session({ sessionId: 'local-1' }), session({
      sessionId: 'remote-1', status: 'active', peer: 'u@buildbox.example.com',
    })];
    const json = renderJson(sessions, { sessions, peers: [] }, NOW);

    expect(json.version).toBe(1);
    expect(json.generatedAt).toBe(NOW.toISOString());
    expect(json.counts).toEqual({ total: 2, 'needs-you': 1, working: 1, queued: 0 });
    expect(Object.keys(json.sessions[0]).sort()).toEqual([
      'ageSeconds', 'agent', 'attention', 'local', 'machine', 'sessionId', 'status', 'title',
      'updatedAt', 'workspace',
    ]);
    expect(json.sessions[0]).toMatchObject({
      sessionId: 'local-1',
      agent: 'claude',
      status: 'idle',
      attention: 'needs-you',
      local: true,
      ageSeconds: 60,
      workspace: { name: 'session-sitter', path: '/home/u/session-sitter' },
    });
    expect(json.sessions[1]).toMatchObject({ local: false, machine: 'buildbox', attention: 'working' });
  });

  it('reports peer reachability with nulls, never with invented values', () => {
    const json = renderJson([], { sessions: [], peers: [{ peer: 'u@dead', reachable: false }] }, NOW);
    expect(json.peers).toEqual([
      { peer: 'u@dead', reachable: false, sessionCount: null, error: null },
    ]);
  });
});

describe('run', () => {
  const collect = async (): Promise<{ sessions: ClaudeSession[]; peers: [] }> => ({
    sessions: [session({ sessionId: 'only' })], peers: [],
  });

  it('prints help and exits 0', async () => {
    const io = fakeIo({ now: NOW });
    expect(await run(['--help'], io, collect)).toBe(0);
    expect(io.text()).toContain('session-sitter status');
  });

  it('prints valid JSON for --json', async () => {
    const io = fakeIo({ now: NOW });
    expect(await run(['--json'], io, collect)).toBe(0);
    expect(JSON.parse(io.text()).sessions[0].sessionId).toBe('only');
  });

  it('prints the table by default', async () => {
    const io = fakeIo({ now: NOW });
    expect(await run([], io, collect)).toBe(0);
    expect(io.text()).toContain('SESSION');
  });
});
