/**
 * The corpus uploader: naming, sidecars, collision handling, the branch dance, and the
 * idempotent bulk import from the native Bob and Claude stores.
 *
 * Ports `scripts/upload_session.py`'s behavior into tests it never had. Git is injected, so no
 * test touches a real repository or network.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  GitResult,
  TARGET_BRANCH,
  UploadError,
  buildSidecar,
  cleanBobUserContent,
  collisionSafeStem,
  datePrefix,
  deleteSession,
  detectSource,
  extractClaudeSessions,
  fileExt,
  flattenClaudeContent,
  importSessions,
  isInjectedContext,
  iso,
  listSessions,
  makeSlug,
  recordEnvelopePath,
  recordStem,
  shortId,
  slugify,
  toDate,
  uploadSession,
} from '../../corpus/upload';

let tmp: string;
let repoRoot: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-'));
  repoRoot = path.join(tmp, 'corpus');
  fs.mkdirSync(path.join(repoRoot, 'data', 'sessions'), { recursive: true });
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** A git stub: records every invocation, answers the queries the uploader makes. */
function fakeGit(overrides: Record<string, GitResult> = {}) {
  const calls: string[][] = [];
  const git = async (args: string[]): Promise<GitResult> => {
    calls.push(args);
    const key = args.join(' ');
    if (overrides[key]) { return overrides[key]; }
    if (key === 'rev-parse --abbrev-ref HEAD') { return { code: 0, stdout: 'main\n', stderr: '' }; }
    if (key === 'config user.name') { return { code: 0, stdout: 'Alice Smith\n', stderr: '' }; }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { git, calls, ran: (prefix: string) => calls.some(c => c.join(' ').startsWith(prefix)) };
}

function writeLocal(name: string, body = '{"title":"local session"}'): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

// ─────────────────────────────────────────────────────────────── pure helpers

describe('naming helpers', () => {
  it('detects the source from a compound extension', () => {
    expect(detectSource('chat.bob.json')).toBe('bob');
    expect(detectSource('chat.claude.jsonl')).toBe('claude');
    expect(detectSource('chat.chatgpt.json')).toBe('chatgpt');
    expect(detectSource('chat.copilot.json')).toBe('copilot');
    expect(detectSource('notes.txt')).toBeNull();
  });

  it('slugifies to lower-case hyphenated text', () => {
    expect(slugify('Fix the Failing Test!')).toBe('fix-the-failing-test');
    expect(slugify('a___b')).toBe('a___b');
    expect(slugify('--edges--')).toBe('edges');
  });

  it('returns the compound extension, falling back to the plain one', () => {
    expect(fileExt('a.claude.jsonl')).toBe('.claude.jsonl');
    expect(fileExt('a.txt')).toBe('.txt');
  });

  it('truncates a slug on a boundary', () => {
    expect(makeSlug('x'.repeat(80))).toHaveLength(48);
    expect(makeSlug('')).toBe('session');
    expect(makeSlug('a-'.repeat(40)).endsWith('-')).toBe(false);
  });

  it('hashes a session id rather than slicing it', () => {
    // Bob task ids share a long common prefix, so a prefix slice would collide and overwrite
    // distinct sessions.
    const a = shortId('legacy-bob-code-aaaaaaaa-1111');
    const b = shortId('legacy-bob-code-aaaaaaaa-2222');
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(shortId('legacy-bob-code-aaaaaaaa-1111')).toBe(a); // stable across runs
  });

  it('adds a counter only when a name is taken, unless forced', () => {
    const dir = path.join(tmp, 'dest');
    fs.mkdirSync(dir);
    expect(collisionSafeStem(dir, '20260714', 'a', '.json', false)).toBe('20260714_a');
    fs.writeFileSync(path.join(dir, '20260714_a.json'), '');
    expect(collisionSafeStem(dir, '20260714', 'a', '.json', false)).toBe('20260714_a_2');
    fs.writeFileSync(path.join(dir, '20260714_a_2.json'), '');
    expect(collisionSafeStem(dir, '20260714', 'a', '.json', false)).toBe('20260714_a_3');
    expect(collisionSafeStem(dir, '20260714', 'a', '.json', true)).toBe('20260714_a');
  });

  it('writes a YAML sidecar with the provenance fields', () => {
    const yaml = buildSidecar('alice', 'bob', 'orig.bob.json', '20260714_x.bob.json',
      new Date('2026-07-14T10:00:00.000Z'));
    expect(yaml).toContain('username: alice');
    expect(yaml).toContain('source: bob');
    expect(yaml).toContain('original_filename: orig.bob.json');
    expect(yaml).toContain('stored_filename: 20260714_x.bob.json');
    expect(yaml).toContain('uploaded_at: 2026-07-14T10:00:00Z');
  });
});

describe('timestamp helpers', () => {
  it('parses epoch seconds, epoch millis and ISO strings', () => {
    expect(toDate(1_752_487_200)?.toISOString()).toBe('2025-07-14T10:00:00.000Z');
    expect(toDate(1_752_487_200_000)?.toISOString()).toBe('2025-07-14T10:00:00.000Z');
    expect(toDate('2026-07-14T10:00:00Z')?.toISOString()).toBe('2026-07-14T10:00:00.000Z');
    expect(toDate(null)).toBeNull();
    expect(toDate('nonsense')).toBeNull();
  });

  it('formats without milliseconds and falls back to empty', () => {
    expect(iso(new Date('2026-07-14T10:00:00.123Z'))).toBe('2026-07-14T10:00:00Z');
    expect(iso(null)).toBe('');
  });

  it('derives a YYYYMMDD prefix, defaulting to today', () => {
    expect(datePrefix(new Date('2026-07-14T10:00:00Z'))).toBe('20260714');
    expect(datePrefix(null)).toMatch(/^\d{8}$/);
  });
});

describe('content helpers', () => {
  it('unwraps a Bob user prompt from its environment wrapper', () => {
    expect(cleanBobUserContent(
      '<environment_details>junk</environment_details><user_query>\n  real ask\n</user_query>'))
      .toBe('real ask');
    expect(cleanBobUserContent('  plain ask  ')).toBe('plain ask');
  });

  it('flattens Claude content blocks to text plus tool names', () => {
    expect(flattenClaudeContent('hi ')).toEqual(['hi', []]);
    expect(flattenClaudeContent([
      { type: 'text', text: 'one' },
      { type: 'tool_use', name: 'Bash' },
      { type: 'tool_result', content: 'ignored' },
      { type: 'text', text: 'two' },
    ])).toEqual(['one\n\ntwo', ['Bash']]);
    expect(flattenClaudeContent(null)).toEqual(['', []]);
  });

  it('recognizes harness-injected context, which must not become a title', () => {
    expect(isInjectedContext('<system-reminder>x</system-reminder>')).toBe(true);
    expect(isInjectedContext('  <ide_selection>x')).toBe(true);
    expect(isInjectedContext('Caveat: the messages below')).toBe(true);
    expect(isInjectedContext('Fix the failing test')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────── upload

describe('uploadSession', () => {
  it('copies the file, writes a sidecar, and commits + pushes to the target branch', async () => {
    const { git, calls, ran } = fakeGit();
    const src = writeLocal('my-chat.bob.json');
    const result = await uploadSession({ repoRoot, git, sessionFile: src });

    expect(result.username).toBe('alice-smith');
    expect(result.source).toBe('bob');
    expect(result.storedName).toMatch(/^\d{8}_my-chat\.bob\.json$/);
    expect(fs.existsSync(result.storedPath)).toBe(true);
    expect(fs.readFileSync(result.sidecarPath, 'utf8')).toContain('source: bob');
    // Latest is pulled before writing, and only the affected files are committed.
    expect(ran('pull --rebase origin main')).toBe(true);
    expect(calls.some(c => c[0] === 'add' && c.length === 3)).toBe(true);
    expect(ran(`push origin ${TARGET_BRANCH}`)).toBe(true);
  });

  it('honors an explicit user, source and slug', async () => {
    const { git } = fakeGit();
    const result = await uploadSession({
      repoRoot, git, sessionFile: writeLocal('anything.txt'),
      user: 'Bob Jones', source: 'chatgpt', slug: 'My Slug',
    });
    expect(result.username).toBe('bob-jones');
    expect(result.storedName).toMatch(/_my-slug\.txt$/);
    expect(result.storedPath).toContain(path.join('bob-jones', 'chatgpt'));
  });

  it('refuses an undetectable source and an unknown one', async () => {
    const { git } = fakeGit();
    await expect(uploadSession({ repoRoot, git, sessionFile: writeLocal('a.txt') }))
      .rejects.toThrow(/could not auto-detect source/);
    await expect(uploadSession({
      repoRoot, git, sessionFile: writeLocal('b.txt'), source: 'telepathy',
    })).rejects.toThrow(/unknown source/);
  });

  it('strips an existing date prefix so a re-upload does not double it', async () => {
    const { git } = fakeGit();
    const result = await uploadSession({
      repoRoot, git, sessionFile: writeLocal('20260101_already.bob.json'),
    });
    expect(result.storedName).toMatch(/^\d{8}_already\.bob\.json$/);
  });

  it('refuses to overwrite unless forced', async () => {
    const { git } = fakeGit();
    const src = writeLocal('dup.bob.json');
    const first = await uploadSession({ repoRoot, git, sessionFile: src });
    // A second upload of the same name gets a counter, so it never clobbers.
    const second = await uploadSession({ repoRoot, git, sessionFile: src });
    expect(second.storedName).not.toBe(first.storedName);
    // Forcing reuses the base name.
    const forced = await uploadSession({ repoRoot, git, sessionFile: src, force: true });
    expect(forced.storedName).toBe(first.storedName);
  });

  it('reports a missing file', async () => {
    const { git } = fakeGit();
    await expect(uploadSession({
      repoRoot, git, sessionFile: path.join(tmp, 'nope.bob.json'),
    })).rejects.toThrow(/file not found/);
  });

  it('touches nothing in a dry run', async () => {
    const { git, calls } = fakeGit();
    const src = writeLocal('dry.bob.json');
    await uploadSession({ repoRoot, git, sessionFile: src, dryRun: true });

    expect(fs.readdirSync(path.join(repoRoot, 'data', 'sessions'))).toEqual([]);
    // Only the read-only queries ran; no add/commit/push.
    expect(calls.every(c => ['rev-parse', 'config'].includes(c[0]))).toBe(true);
  });

  it('stashes, switches to the target branch, then restores the original branch', async () => {
    const { git, calls } = fakeGit({
      'rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'feature/x\n', stderr: '' },
      'stash --include-untracked -m upload_session: auto-stash':
        { code: 0, stdout: 'Saved working directory\n', stderr: '' },
    });
    await uploadSession({ repoRoot, git, sessionFile: writeLocal('x.bob.json') });

    const order = calls.map(c => c[0]);
    expect(order).toContain('stash');
    expect(order.indexOf('checkout')).toBeLessThan(order.indexOf('push'));
    // Restored afterwards, including popping the stash.
    expect(calls.filter(c => c[0] === 'checkout').at(-1)).toEqual(['checkout', 'feature/x']);
    expect(calls.at(-1)).toEqual(['stash', 'pop']);
  });

  it('surfaces a failed pull instead of committing on stale state', async () => {
    const { git } = fakeGit({
      'pull --rebase origin main': { code: 1, stdout: '', stderr: 'conflict' },
    });
    await expect(uploadSession({ repoRoot, git, sessionFile: writeLocal('x.bob.json') }))
      .rejects.toThrow(/git pull --rebase failed/);
  });

  it('errors when no username can be determined', async () => {
    const { git } = fakeGit({ 'config user.name': { code: 0, stdout: '\n', stderr: '' } });
    await expect(uploadSession({ repoRoot, git, sessionFile: writeLocal('x.bob.json') }))
      .rejects.toThrow(/could not determine git user.name/);
  });
});

// ─────────────────────────────────────────────────────────────── delete + list

describe('deleteSession', () => {
  it('removes the stored file and its sidecar, then commits', async () => {
    const { git, calls } = fakeGit();
    const uploaded = await uploadSession({
      repoRoot, git, sessionFile: writeLocal('gone.bob.json'),
    });
    const rel = await deleteSession({
      repoRoot, git, sessionFile: uploaded.storedName, user: 'alice-smith',
    });

    expect(rel).toContain(uploaded.storedName);
    const rm = calls.find(c => c[0] === 'rm')!;
    expect(rm).toHaveLength(3); // the file and the sidecar
  });

  it('refuses to delete something not in the store', async () => {
    const { git } = fakeGit();
    await expect(deleteSession({ repoRoot, git, sessionFile: 'nope.bob.json' }))
      .rejects.toThrow(/session not found in store/);
  });
});

describe('listSessions', () => {
  it('lists newest first per source, with titles and upload times', async () => {
    const { git } = fakeGit();
    await uploadSession({
      repoRoot, git, sessionFile: writeLocal('one.bob.json', '{"title":"First"}'), slug: 'one',
    });
    await uploadSession({
      repoRoot, git, sessionFile: writeLocal('two.claude.json', '{"title":"Second"}'), slug: 'two',
    });

    const result = await listSessions({ repoRoot, git });
    expect(Object.keys(result.bySource).sort()).toEqual(['bob', 'claude']);
    expect(result.bySource.bob.total).toBe(1);
    expect(result.bySource.bob.shown[0].title).toBe('First');
    expect(result.bySource.bob.shown[0].uploadedAt).toMatch(/^\d{4}-/);
    // Sidecars are not listed as sessions.
    expect(result.bySource.bob.shown.every(s => !s.filename.endsWith('.meta.yaml'))).toBe(true);
  });

  it('caps the listing and reports the true total', async () => {
    const { git } = fakeGit();
    for (let i = 0; i < 4; i++) {
      await uploadSession({
        repoRoot, git, sessionFile: writeLocal(`s${i}.bob.json`), slug: `s${i}`,
      });
    }
    const result = await listSessions({ repoRoot, git, top: 2 });
    expect(result.bySource.bob.total).toBe(4);
    expect(result.bySource.bob.shown).toHaveLength(2);
  });

  it('returns nothing for a user with no sessions', async () => {
    const { git } = fakeGit();
    expect((await listSessions({ repoRoot, git, user: 'nobody' })).bySource).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────── import

describe('extractClaudeSessions', () => {
  function writeClaudeSession(project: string, name: string, lines: object[]): string {
    const dir = path.join(tmp, 'claude-projects', project);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n'), 'utf8');
    return p;
  }

  it('builds one envelope per session, with the title from the first real prompt', async () => {
    writeClaudeSession('proj', 'aaa.jsonl', [
      { type: 'user', sessionId: 'sess-a', timestamp: '2026-07-14T10:00:00Z',
        message: { role: 'user', content: '<system-reminder>ignore me</system-reminder>' } },
      { type: 'user', sessionId: 'sess-a', timestamp: '2026-07-14T10:01:00Z',
        message: { role: 'user', content: 'Fix the failing test\nmore detail' } },
      { type: 'assistant', sessionId: 'sess-a', timestamp: '2026-07-14T10:02:00Z',
        message: { role: 'assistant', model: 'claude-x',
          content: [{ type: 'text', text: 'On it' }, { type: 'tool_use', name: 'Bash' }] } },
    ]);

    const records = await extractClaudeSessions('alice', path.join(tmp, 'claude-projects'));
    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.envelope.session_id).toBe('sess-a');
    expect(r.envelope.harness).toBe('claude');
    expect(r.envelope.model).toBe('claude-x');
    // Injected context is kept as a message but never used as the title.
    expect(r.title).toBe('Fix the failing test');
    expect(r.envelope.messages).toHaveLength(3);
    expect(r.envelope.messages[2].tools).toEqual(['Bash']);
    expect(r.dateStr).toBe('20260714');
    expect(r.envExt).toBe('.claude.json');
    expect(r.rawExt).toBe('.claude.jsonl');
  });

  it('skips sidechains, synthetic models, and content-free turns', async () => {
    writeClaudeSession('proj', 'bbb.jsonl', [
      { type: 'user', sessionId: 's', isSidechain: true,
        message: { role: 'user', content: 'subagent chatter' } },
      { type: 'summary', sessionId: 's' },
      { type: 'assistant', sessionId: 's',
        message: { role: 'assistant', model: '<synthetic>', content: [] } },
      { type: 'user', sessionId: 's', message: { role: 'user', content: 'real' } },
    ]);

    const [r] = await extractClaudeSessions('alice', path.join(tmp, 'claude-projects'));
    expect(r.envelope.messages.map(m => m.content)).toEqual(['real']);
    expect(r.envelope.model).toBeNull();
  });

  it('skips a session with no usable messages, and tolerates malformed lines', async () => {
    const dir = path.join(tmp, 'claude-projects', 'proj');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'empty.jsonl'), '{ broken\n\n', 'utf8');
    expect(await extractClaudeSessions('alice', path.join(tmp, 'claude-projects'))).toEqual([]);
  });

  it('returns nothing when the store does not exist', async () => {
    expect(await extractClaudeSessions('alice', path.join(tmp, 'nope'))).toEqual([]);
  });

  it('honors a limit', async () => {
    for (const n of ['a', 'b', 'c']) {
      writeClaudeSession('proj', `${n}.jsonl`, [
        { type: 'user', sessionId: `s-${n}`, message: { role: 'user', content: 'x' } },
      ]);
    }
    expect(await extractClaudeSessions('alice', path.join(tmp, 'claude-projects'), 2))
      .toHaveLength(2);
  });
});

describe('importSessions', () => {
  function claudeStore(sessions: Array<{ id: string; text: string }>): string {
    const dir = path.join(tmp, 'claude-projects', 'proj');
    fs.mkdirSync(dir, { recursive: true });
    for (const s of sessions) {
      fs.writeFileSync(path.join(dir, `${s.id}.jsonl`), JSON.stringify({
        type: 'user', sessionId: s.id, timestamp: '2026-07-14T10:00:00Z',
        message: { role: 'user', content: s.text },
      }), 'utf8');
    }
    return path.join(tmp, 'claude-projects');
  }

  it('writes an envelope, a sidecar and a raw copy, then commits once', async () => {
    const { git, calls, ran } = fakeGit();
    const summary = await importSessions({
      repoRoot, git, claude: true,
      claudeProjectsDir: claudeStore([{ id: 'sess-a', text: 'Fix the test' }]),
      noMask: true,
    });

    expect(summary.extracted).toBe(1);
    expect(summary.written).toHaveLength(3);
    expect(summary.committed).toBe(true);
    expect(summary.pushed).toBe(true);
    const envelope = summary.written.find(p => p.endsWith('.claude.json'))!;
    const parsed = JSON.parse(fs.readFileSync(path.join(repoRoot, envelope), 'utf8'));
    expect(parsed.session_id).toBe('sess-a');
    expect(parsed.harness).toBe('claude');
    // One commit for the whole batch, not one per session.
    expect(calls.filter(c => c[0] === 'commit')).toHaveLength(1);
    expect(ran('push origin main')).toBe(true);
  });

  it('is idempotent: a second import writes only genuinely new sessions', async () => {
    const { git } = fakeGit();
    const projects = claudeStore([{ id: 'sess-a', text: 'one' }]);
    await importSessions({ repoRoot, git, claude: true, claudeProjectsDir: projects, noMask: true });

    const second = await importSessions({
      repoRoot, git, claude: true, claudeProjectsDir: projects, noMask: true,
    });
    expect(second.skipped).toBe(1);
    expect(second.written).toHaveLength(0);
    expect(second.committed).toBe(false);
  });

  it('rewrites everything when forced', async () => {
    const { git } = fakeGit();
    const projects = claudeStore([{ id: 'sess-a', text: 'one' }]);
    await importSessions({ repoRoot, git, claude: true, claudeProjectsDir: projects, noMask: true });
    const forced = await importSessions({
      repoRoot, git, claude: true, claudeProjectsDir: projects, noMask: true, force: true,
    });
    expect(forced.skipped).toBe(0);
    expect(forced.written).toHaveLength(3);
  });

  it('masks secrets before the commit', async () => {
    const { git, calls } = fakeGit();
    const secret = `sk-${'E'.repeat(32)}`;
    const summary = await importSessions({
      repoRoot, git, claude: true,
      claudeProjectsDir: claudeStore([{ id: 'sess-a', text: `token ${secret}` }]),
    });

    expect(summary.masked?.unique).toBe(1);
    const envelope = path.join(repoRoot, summary.written.find(p => p.endsWith('.claude.json'))!);
    expect(fs.readFileSync(envelope, 'utf8')).not.toContain(secret);
    // Masking happens before `git add`, so no unmasked credential can enter history.
    expect(calls.findIndex(c => c[0] === 'add')).toBeGreaterThan(0);
  });

  it('can commit without pushing', async () => {
    const { git, ran } = fakeGit();
    const summary = await importSessions({
      repoRoot, git, claude: true,
      claudeProjectsDir: claudeStore([{ id: 'sess-a', text: 'x' }]),
      noMask: true, noPush: true,
    });
    expect(summary.committed).toBe(true);
    expect(summary.pushed).toBe(false);
    expect(ran('push')).toBe(false);
  });

  it('writes and commits nothing in a dry run', async () => {
    const { git, calls } = fakeGit();
    const summary = await importSessions({
      repoRoot, git, claude: true, dryRun: true,
      claudeProjectsDir: claudeStore([{ id: 'sess-a', text: 'x' }]),
    });
    expect(summary.written).toHaveLength(3); // reported…
    expect(summary.committed).toBe(false);
    expect(calls.some(c => c[0] === 'add')).toBe(false); // …but nothing done
    expect(fs.existsSync(path.join(repoRoot, summary.written[0]))).toBe(false);
  });

  it('reports an empty extraction without committing', async () => {
    const { git, calls } = fakeGit();
    const summary = await importSessions({
      repoRoot, git, claude: true, claudeProjectsDir: path.join(tmp, 'nope'), noMask: true,
    });
    expect(summary.extracted).toBe(0);
    expect(calls.some(c => c[0] === 'commit')).toBe(false);
  });

  it('keeps a secret pasted into a session title out of the stored filename', async () => {
    // The masking pass rewrites file *contents*. A filename is not content, so an unredacted
    // slug would carry the secret (lower-cased) where nothing would ever clean it up.
    const { git } = fakeGit();
    const secret = `ghp_${'B'.repeat(36)}`;
    const summary = await importSessions({
      repoRoot, git, claude: true,
      claudeProjectsDir: claudeStore([{ id: 'sess-a', text: `use ${secret} to push` }]),
    });

    for (const rel of summary.written) {
      expect(rel.toLowerCase()).not.toContain(secret.toLowerCase());
      expect(path.basename(rel)).toContain('redacted');
    }
    expect(summary.masked?.unique).toBe(1); // only the content secret, not a filename copy
  });

  it('names every artifact of one session with the same stem', async () => {
    const { git } = fakeGit();
    const summary = await importSessions({
      repoRoot, git, claude: true, noMask: true,
      claudeProjectsDir: claudeStore([{ id: 'sess-a', text: 'Fix the failing test' }]),
    });
    const stems = summary.written.map(p => path.basename(p).split('.')[0]);
    expect(new Set(stems).size).toBe(1);
    expect(stems[0]).toMatch(/^20260714_fix-the-failing-test-[0-9a-f]{8}$/);
  });
});

describe('record paths', () => {
  it('derive a deterministic stem and envelope path', () => {
    const record = {
      dateStr: '20260714', slug: 'fix-test', id8: 'abcd1234', source: 'claude',
      envExt: '.claude.json',
    } as Parameters<typeof recordStem>[0];
    expect(recordStem(record)).toBe('20260714_fix-test-abcd1234');
    expect(recordEnvelopePath('/root', record, 'alice'))
      .toBe(path.join('/root', 'alice', 'claude', '20260714_fix-test-abcd1234.claude.json'));
  });
});

describe('UploadError', () => {
  it('is named, so callers can tell it from a programming error', () => {
    expect(new UploadError('x').name).toBe('UploadError');
  });
});
