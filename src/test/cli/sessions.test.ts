import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ClaudeSession, SessionStorePaths } from '../../sessionScan';
import { collectSessions, localHost, peerHost, type RemoteReader } from '../../cli/sessions';

// A fixture home, so this passes on a machine with no agents installed and is not perturbed by one
// that has them.
let home: string;
let paths: SessionStorePaths;

beforeEach(async () => {
  home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ss-collect-'));
  paths = {
    projectsDir: path.join(home, '.claude', 'projects'),
    bobDbPath: path.join(home, '.bob', 'db', 'bob.db'),
    codexSessionsDir: path.join(home, '.codex', 'sessions'),
    codexIndexPath: path.join(home, '.codex', 'session_index.jsonl'),
    vscodeUserDir: path.join(home, 'Code', 'User'),
  };
});

afterEach(async () => {
  await fs.promises.rm(home, { recursive: true, force: true });
});

async function writeClaudeSession(name: string, lines: object[]): Promise<void> {
  const dir = path.join(paths.projectsDir, '-home-u-proj');
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(
    path.join(dir, `${name}.jsonl`), `${lines.map(l => JSON.stringify(l)).join('\n')}\n`, 'utf8');
}

function remote(sessions: ClaudeSession[], fail = false): RemoteReader {
  return {
    refresh: async () => { if (fail) { throw new Error('vpn down'); } },
    getSessions: () => sessions,
    getPeerStatuses: () => [{ peer: 'u@buildbox', reachable: !fail, sessionCount: sessions.length }],
  };
}

describe('collectSessions', () => {
  it('returns nothing, and does not throw, when no agent has ever run here', async () => {
    const worklist = await collectSessions({ paths });
    expect(worklist.sessions).toEqual([]);
    expect(worklist.peers).toEqual([]);
  });

  it('reads a Claude session through the same parser the extension uses', async () => {
    await writeClaudeSession('11111111-1111-1111-1111-111111111111', [
      { type: 'user', cwd: '/home/u/proj', message: { content: 'refactor the reader' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
    ]);
    const worklist = await collectSessions({ paths });
    expect(worklist.sessions).toHaveLength(1);
    expect(worklist.sessions[0]).toMatchObject({
      sessionId: '11111111-1111-1111-1111-111111111111',
      title: 'refactor the reader',
      projectName: 'proj',
      source: 'claude',
    });
  });

  it('does not touch the network unless peers were asked for', async () => {
    // The default has to be silent: a command that opens SSH connections unbidden is one people
    // stop running.
    let refreshed = false;
    const reader: RemoteReader = {
      refresh: async () => { refreshed = true; },
      getSessions: () => [],
      getPeerStatuses: () => [],
    };
    await collectSessions({ paths });
    expect(refreshed).toBe(false);
    await collectSessions({ paths, remote: reader });
    expect(refreshed).toBe(true);
  });

  it('merges peer sessions and reports each peer', async () => {
    const peerSession: ClaudeSession = {
      sessionId: 'p-1', projectName: 'proj', projectPath: '/p', title: 'over there',
      updatedAt: new Date(), status: 'finished', source: 'claude', peer: 'u@buildbox',
    };
    const worklist = await collectSessions({ paths, remote: remote([peerSession]) });
    expect(worklist.sessions.map(s => s.sessionId)).toEqual(['p-1']);
    expect(worklist.peers[0]).toMatchObject({ peer: 'u@buildbox', reachable: true });
  });

  it('keeps the local worklist when the peer pull fails outright', async () => {
    await writeClaudeSession('22222222-2222-2222-2222-222222222222', [
      { type: 'user', cwd: '/home/u/proj', message: { content: 'local work' } },
    ]);
    const worklist = await collectSessions({ paths, remote: remote([], true) });
    expect(worklist.sessions).toHaveLength(1);
    expect(worklist.peerError).toContain('vpn down');
  });

  it('orders the merged list newest first', async () => {
    await writeClaudeSession('33333333-3333-3333-3333-333333333333', [
      { type: 'user', cwd: '/home/u/proj', message: { content: 'older local' } },
    ]);
    const newer: ClaudeSession = {
      sessionId: 'p-new', projectName: 'proj', projectPath: '/p', title: 'newer peer',
      updatedAt: new Date(Date.now() + 60_000), status: 'finished', source: 'claude', peer: 'u@buildbox',
    };
    const worklist = await collectSessions({ paths, remote: remote([newer]) });
    expect(worklist.sessions[0].sessionId).toBe('p-new');
  });
});

describe('host names', () => {
  it('shortens a peer to its first label, dropping the user', () => {
    expect(peerHost('vpcuser@buildbox.example.com')).toBe('buildbox');
    expect(peerHost('buildbox')).toBe('buildbox');
  });

  it('reports this machine by its short name too, so both columns read alike', () => {
    expect(localHost()).toBe(os.hostname().split('.')[0]);
  });
});
