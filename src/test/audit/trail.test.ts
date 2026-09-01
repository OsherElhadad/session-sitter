import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DecisionRecord,
  MAX_BYTES,
  SUMMARY_LIMIT,
  appendJsonl,
  fingerprint,
  readJsonl,
  summarizeInput,
} from '../../audit/trail';

let dir: string;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-trail-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const record = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  ts: '2026-09-01T10:00:00.000Z',
  sessionId: 'sess-1',
  cwd: '/tmp/repo',
  tool: 'Bash',
  inputSummary: 'git push --force origin main',
  light: 'yellow',
  decision: 'allow',
  clause: 'practices §force-push',
  actor: 'policy',
  latencyMs: 3,
  rewritten: true,
  ...over,
});

describe('summarizeInput', () => {
  it('shows a Bash command', () => {
    expect(summarizeInput({ command: 'ls -la', description: 'list' })).toBe('ls -la');
  });

  it('shows a file path for a file tool', () => {
    expect(summarizeInput({ file_path: '/tmp/a.ts', content: 'x'.repeat(9999) }))
      .toBe('/tmp/a.ts');
  });

  it('falls back to compact JSON for anything else', () => {
    expect(summarizeInput({ url: 'https://example.com' })).toBe('{"url":"https://example.com"}');
  });

  it('collapses whitespace so one record is one line', () => {
    expect(summarizeInput({ command: 'git\n  push\n  --force' })).toBe('git push --force');
  });

  it('bounds the summary', () => {
    const summary = summarizeInput({ command: 'x'.repeat(SUMMARY_LIMIT + 50) });
    expect(summary).toHaveLength(SUMMARY_LIMIT + 1); // + the ellipsis
    expect(summary.endsWith('…')).toBe(true);
  });

  it('is empty for a missing input', () => {
    expect(summarizeInput(null)).toBe('');
    expect(summarizeInput(undefined)).toBe('');
  });

  describe('redaction', () => {
    // Uses the same detector the corpus importer uses (src/corpus/mask.ts), so there is one
    // definition in this repository of what counts as a secret.
    it('redacts a GitHub token', () => {
      const summary = summarizeInput({ command: `git remote add o https://ghp_${'a'.repeat(36)}@h/r` });
      expect(summary).not.toContain('ghp_aaaa');
      expect(summary).toContain('redacted');
    });

    it('redacts an Anthropic key', () => {
      const summary = summarizeInput({ command: `export ANTHROPIC_AUTH_TOKEN=sk-ant-${'b'.repeat(24)}` });
      expect(summary).not.toContain('sk-ant-bbbb');
    });

    it('redacts a bearer token in a header', () => {
      const summary = summarizeInput({ command: 'curl -H "Authorization: Bearer abcdefghij0123456789xyz"' });
      expect(summary).not.toContain('abcdefghij0123456789xyz');
    });

    it('leaves an ordinary path alone', () => {
      expect(summarizeInput({ command: 'cat /home/dev/project/.eslintrc.json' }))
        .toBe('cat /home/dev/project/.eslintrc.json');
    });
  });
});

describe('fingerprint', () => {
  it('is stable for the same call', () => {
    expect(fingerprint('Bash', { command: 'ls' })).toBe(fingerprint('Bash', { command: 'ls' }));
  });
  it('differs for a different call', () => {
    expect(fingerprint('Bash', { command: 'ls' })).not.toBe(fingerprint('Bash', { command: 'pwd' }));
  });
  it('differs for a different tool', () => {
    expect(fingerprint('Bash', { command: 'ls' })).not.toBe(fingerprint('Read', { command: 'ls' }));
  });
  it('handles a missing input', () => {
    expect(fingerprint('Bash', null)).toHaveLength(12);
  });
  it('never leaks the input itself', () => {
    expect(fingerprint('Bash', { command: 'secret-value' })).not.toContain('secret');
  });
});

describe('appendJsonl / readJsonl', () => {
  it('writes one line per record and reads them back in order', () => {
    const file = path.join(dir, 'decisions.jsonl');
    appendJsonl(file, record({ tool: 'A' }));
    appendJsonl(file, record({ tool: 'B' }));
    expect(readJsonl<DecisionRecord>(file).map(r => r.tool)).toEqual(['A', 'B']);
  });

  it('creates the directory it needs', () => {
    const file = path.join(dir, 'nested', 'deep', 'decisions.jsonl');
    appendJsonl(file, record());
    expect(readJsonl(file)).toHaveLength(1);
  });

  it('keeps the whole record shape', () => {
    const file = path.join(dir, 'decisions.jsonl');
    appendJsonl(file, record());
    expect(readJsonl<DecisionRecord>(file)[0]).toEqual(record());
  });

  it('returns nothing for a file that does not exist', () => {
    expect(readJsonl(path.join(dir, 'missing.jsonl'))).toEqual([]);
  });

  it('skips a malformed line rather than throwing', () => {
    const file = path.join(dir, 'decisions.jsonl');
    appendJsonl(file, record({ tool: 'A' }));
    fs.appendFileSync(file, '{ this is not json\n');
    appendJsonl(file, record({ tool: 'B' }));
    expect(readJsonl<DecisionRecord>(file).map(r => r.tool)).toEqual(['A', 'B']);
  });

  it('never throws when the path cannot be written', () => {
    // A path whose parent is a regular file can never be created.
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    expect(() => appendJsonl(path.join(blocker, 'decisions.jsonl'), record())).not.toThrow();
  });

  it('rotates at the cap and still reads the rotated generation', () => {
    const file = path.join(dir, 'decisions.jsonl');
    fs.writeFileSync(file, `${JSON.stringify(record({ tool: 'OLD' }))}\n${'#'.repeat(MAX_BYTES)}\n`);
    appendJsonl(file, record({ tool: 'NEW' }));
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    // The fresh file holds only the new record; the reader still sees both generations.
    expect(readJsonl<DecisionRecord>(file).map(r => r.tool)).toEqual(['OLD', 'NEW']);
  });
});
