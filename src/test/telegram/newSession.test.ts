import { describe, expect, it } from 'vitest';
import {
  chooseLaunchTarget, classifyAppearance, firstMessage, targetCaveat, type LaunchCandidate,
} from '../../telegram/newSession';

function candidate(pid: number, folders: string[]): LaunchCandidate {
  return { pid, workspaceFolders: folders };
}

describe('classifyAppearance', () => {
  it('names the one session that appeared', () => {
    expect(classifyAppearance(['a'], ['a', 'b'])).toEqual({ kind: 'started', sessionId: 'b' });
  });

  it('names it when nothing was open before', () => {
    expect(classifyAppearance([], ['b'])).toEqual({ kind: 'started', sessionId: 'b' });
  });

  /**
   * Kept apart from `ambiguous` because they need different words: nothing appearing means the open
   * failed or the manager has not caught up, and neither is "could not start" — the panel is open.
   */
  it('reports nothing appearing as its own outcome', () => {
    expect(classifyAppearance(['a'], ['a'])).toEqual({ kind: 'no-session' });
    expect(classifyAppearance(['a'], [])).toEqual({ kind: 'no-session' });
  });

  /**
   * Refusing to guess is the point. A first message sent into the wrong conversation is worse than no
   * message at all, and this layer never acts on a session it cannot positively identify.
   */
  it('refuses to choose when two sessions appear at once', () => {
    expect(classifyAppearance(['a'], ['a', 'b', 'c'])).toEqual({ kind: 'ambiguous', count: 2 });
  });

  it('ignores a repeated id and an empty one', () => {
    expect(classifyAppearance(['a'], ['a', 'b', 'b'])).toEqual({ kind: 'started', sessionId: 'b' });
    expect(classifyAppearance(['a'], ['a', ''])).toEqual({ kind: 'no-session' });
  });

  it('ignores a session that closed while opening another', () => {
    // `panels` is self-pruning, so a disappearance is normal and is not a new session.
    expect(classifyAppearance(['a', 'b'], ['b', 'c']))
      .toEqual({ kind: 'started', sessionId: 'c' });
  });
});

describe('chooseLaunchTarget', () => {
  /**
   * The fix for a session opening somewhere the user did not pick. Nothing in Claude's API takes a
   * folder, so the only way to be sure is to open in a window that has no other folder to choose from.
   */
  it('prefers a window that has only the chosen folder', () => {
    const target = chooseLaunchTarget(
      [candidate(1, ['/work/app', '/work/other']), candidate(2, ['/work/app'])], '/work/app');
    expect(target).toEqual({ certainty: 'exact', pid: 2, workspace: '/work/app' });
  });

  it('falls back to a multi-root window, and says which folders it also has', () => {
    const target = chooseLaunchTarget(
      [candidate(7, ['/work/app', '/work/other'])], '/work/app');
    expect(target).toEqual({
      certainty: 'contains', pid: 7, workspace: '/work/app',
      folders: ['/work/app', '/work/other'],
    });
  });

  it('has no target when no window has the folder open', () => {
    expect(chooseLaunchTarget([candidate(1, ['/elsewhere'])], '/work/app'))
      .toEqual({ certainty: 'none' });
    expect(chooseLaunchTarget([], '/work/app')).toEqual({ certainty: 'none' });
  });

  it('breaks a tie on lowest pid, so every window reaches the same answer', () => {
    expect(chooseLaunchTarget(
      [candidate(9, ['/work/app']), candidate(4, ['/work/app'])], '/work/app'))
      .toMatchObject({ pid: 4 });
    expect(chooseLaunchTarget(
      [candidate(9, ['/work/app', '/x']), candidate(4, ['/work/app', '/y'])], '/work/app'))
      .toMatchObject({ pid: 4, certainty: 'contains' });
  });

  it('matches a folder exactly, never as a prefix', () => {
    // `/work/app` must not claim a window open on `/work/app-legacy`.
    expect(chooseLaunchTarget([candidate(1, ['/work/app-legacy'])], '/work/app'))
      .toEqual({ certainty: 'none' });
  });
});

describe('targetCaveat', () => {
  it('says nothing when the folder is guaranteed', () => {
    expect(targetCaveat({ certainty: 'exact', pid: 1, workspace: '/work/app' })).toBeNull();
    expect(targetCaveat({ certainty: 'none' })).toBeNull();
  });

  it('names the other folders the session could land in', () => {
    const why = targetCaveat({
      certainty: 'contains', pid: 7, workspace: '/work/app',
      folders: ['/work/app', '/work/other', '/work/third'],
    }) ?? '';
    expect(why).toContain('other');
    expect(why).toContain('third');
    // The chosen folder is not one of the surprises.
    expect(why).not.toContain('app,');
    expect(why).toContain('Claude picks the folder');
  });
});

describe('firstMessage', () => {
  /**
   * Its job is to make the CLI write a transcript record — that is what turns an open panel into a
   * session the worklist can see and a topic can mirror.
   */
  it('records where the session came from, which the transcript then keeps', () => {
    const text = firstMessage('buildbox');
    expect(text).toContain('Telegram');
    expect(text).toContain('buildbox');
  });

  it('leaves the agent waiting rather than inventing work', () => {
    // A question here would have the agent answer a pleasantry before the real prompt arrives.
    expect(firstMessage('h')).not.toContain('?');
    expect(firstMessage('h')).toContain('Nothing to do yet');
  });
});

/**
 * The reported symptom, as a regression test: "/new opens the session in a workspace I did not pick".
 *
 * The old menu paired each folder with *whichever window listed it first*. A multi-root window listed
 * early therefore captured every folder it happened to contain — including folders that had a window of
 * their own — and opening a panel there produced a session in one of that window's *other* folders,
 * with nothing said about it.
 */
describe('the menu pairing that used to open the wrong workspace', () => {
  const windows = [
    // Listed first, and holds two folders.
    candidate(100, ['/work/app', '/work/other']),
    // Dedicated to one of them.
    candidate(200, ['/work/other']),
  ];

  it('sends a folder to the window dedicated to it, not the one that listed it first', () => {
    // What the old pairing did:
    expect(windows.find(w => w.workspaceFolders.includes('/work/other'))?.pid).toBe(100);
    // What it does now:
    expect(chooseLaunchTarget(windows, '/work/other'))
      .toEqual({ certainty: 'exact', pid: 200, workspace: '/work/other' });
  });

  it('still offers a folder that only a multi-root window has, with the caveat said', () => {
    const target = chooseLaunchTarget(windows, '/work/app');
    expect(target.certainty).toBe('contains');
    // Offered rather than hidden — it is startable, just not guaranteed — and the caveat is what makes
    // that honest instead of a surprise.
    expect(targetCaveat(target)).toContain('other');
  });

  it('gives every folder a target, so nothing becomes unstartable', () => {
    for (const folder of [...new Set(windows.flatMap(w => w.workspaceFolders))]) {
      expect(chooseLaunchTarget(windows, folder).certainty, folder).not.toBe('none');
    }
  });
});
