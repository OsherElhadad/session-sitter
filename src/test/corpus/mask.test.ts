/**
 * Secret masking: every rule detects, replacements keep the same shape and length, re-runs are
 * idempotent, and non-secrets are left alone.
 *
 * Ports `scripts/mask_sessions.py`'s behavior into tests it never had.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MARKER,
  RULES,
  applyMasking,
  buildReport,
  buildSecretMap,
  detBody,
  iterFiles,
  makeReplacement,
  redact,
  redactSecrets,
  run,
} from '../../corpus/mask';

let tmp: string;
let sessionsDir: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mask-'));
  sessionsDir = path.join(tmp, 'data', 'sessions', 'alice', 'claude');
  fs.mkdirSync(sessionsDir, { recursive: true });
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function writeSession(name: string, body: string): string {
  const p = path.join(sessionsDir, name);
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

// Fake-but-well-formed secrets, one per rule.
const SECRETS: Record<string, string> = {
  github_pat_fine: `github_pat_${'A'.repeat(82)}`,
  github_pat_classic: `ghp_${'B'.repeat(36)}`,
  github_oauth: `gho_${'C'.repeat(36)}`,
  anthropic_key: `sk-ant-${'D'.repeat(30)}`,
  openai_key: `sk-${'E'.repeat(32)}`,
  aws_access_key_id: `AKIA${'F'.repeat(16)}`,
  google_api_key: `AIza${'G'.repeat(35)}`,
  slack_token: `xoxb-${'1234567890'.repeat(2)}`,
  jwt: `eyJhbGciOi.${'a'.repeat(20)}.${'b'.repeat(20)}`,
};

describe('detBody', () => {
  it('is deterministic and drawn only from the charset', () => {
    const a = detBody('seed', 20, 'abc');
    expect(a).toHaveLength(20);
    expect(detBody('seed', 20, 'abc')).toBe(a);
    expect(detBody('other', 20, 'abc')).not.toBe(a);
    expect(/^[abc]+$/.test(a)).toBe(true);
  });
});

describe('makeReplacement', () => {
  it.each(Object.entries(SECRETS))('keeps %s the same length and prefix', (name, secret) => {
    const fake = makeReplacement(name, secret);
    expect(fake).toHaveLength(secret.length);
    expect(fake).not.toBe(secret);
    expect(fake).toContain(MARKER);
  });

  it('keeps the recognizable prefix of each token type', () => {
    expect(makeReplacement('github_pat_classic', SECRETS.github_pat_classic)).toMatch(/^ghp_/);
    expect(makeReplacement('github_oauth', SECRETS.github_oauth)).toMatch(/^gho_/);
    expect(makeReplacement('anthropic_key', SECRETS.anthropic_key)).toMatch(/^sk-ant-/);
    expect(makeReplacement('aws_access_key_id', SECRETS.aws_access_key_id)).toMatch(/^AKIA/);
    expect(makeReplacement('google_api_key', SECRETS.google_api_key)).toMatch(/^AIza/);
    expect(makeReplacement('openai_key', `sk-proj-${'x'.repeat(24)}`)).toMatch(/^sk-proj-/);
  });

  it('keeps a JWT\'s three-segment shape with each segment\'s length', () => {
    const fake = makeReplacement('jwt', SECRETS.jwt);
    const parts = fake.split('.');
    expect(parts).toHaveLength(3);
    SECRETS.jwt.split('.').forEach((seg, i) => expect(parts[i]).toHaveLength(seg.length));
  });

  it('replaces a PEM key with a clearly fake key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
    const fake = makeReplacement('pem_private_key', pem);
    expect(fake).toContain('BEGIN PRIVATE KEY');
    expect(fake).toContain(MARKER);
    expect(fake).not.toContain('MIIabc');
  });

  it('maps the same secret to the same fake every time', () => {
    // The envelope and its raw copy must stay consistent with each other.
    expect(makeReplacement('openai_key', SECRETS.openai_key))
      .toBe(makeReplacement('openai_key', SECRETS.openai_key));
  });
});

describe('buildSecretMap', () => {
  it('detects every rule and counts occurrences per file', async () => {
    writeSession('a.claude.json', Object.values(SECRETS).join('\n'));
    writeSession('b.claude.json', `${SECRETS.openai_key} again ${SECRETS.openai_key}`);
    const scan = await buildSecretMap(await iterFiles(sessionsDir), tmp);

    expect(scan.mapping.size).toBe(Object.keys(SECRETS).length);
    expect([...scan.meta.values()].sort()).toEqual(Object.keys(SECRETS).sort());
    const hits = scan.hits.get(SECRETS.openai_key)!;
    expect([...hits.values()].reduce((a, b) => a + b, 0)).toBe(3);
    expect(hits.size).toBe(2);
  });

  it('picks the secret out of a keyed assignment', async () => {
    writeSession('c.claude.json', `aws_secret_access_key = "${'a'.repeat(40)}"`);
    const scan = await buildSecretMap(await iterFiles(sessionsDir), tmp);
    expect([...scan.mapping.keys()]).toEqual(['a'.repeat(40)]);
  });

  it('picks the token out of a bearer header', async () => {
    writeSession('d.claude.json', 'Authorization: Bearer abcdefghij0123456789xyz');
    const scan = await buildSecretMap(await iterFiles(sessionsDir), tmp);
    expect([...scan.mapping.keys()]).toEqual(['abcdefghij0123456789xyz']);
  });

  it('leaves emails, names and paths alone', async () => {
    // Masking these is not a security win and it corrupts legitimate content.
    writeSession('e.claude.json',
      'alice@example.com wrote /home/alice/project/src/app.ts — see the Smith report');
    const scan = await buildSecretMap(await iterFiles(sessionsDir), tmp);
    expect(scan.mapping.size).toBe(0);
  });

  it('skips values that are already masked', async () => {
    writeSession('f.claude.json', makeReplacement('openai_key', SECRETS.openai_key));
    const scan = await buildSecretMap(await iterFiles(sessionsDir), tmp);
    expect(scan.mapping.size).toBe(0);
  });
});

describe('applyMasking', () => {
  it('rewrites every occurrence and reports the per-file count', async () => {
    const p = writeSession('a.claude.json', `x ${SECRETS.openai_key} y ${SECRETS.openai_key} z`);
    const files = await iterFiles(sessionsDir);
    const scan = await buildSecretMap(files, tmp);
    const perFile = await applyMasking(files, scan.mapping, tmp, false);

    const after = fs.readFileSync(p, 'utf8');
    expect(after).not.toContain(SECRETS.openai_key);
    expect(after).toContain(MARKER);
    expect(Object.values(perFile)[0]).toBe(2);
  });

  it('writes nothing in a dry run', async () => {
    const p = writeSession('a.claude.json', SECRETS.openai_key);
    const files = await iterFiles(sessionsDir);
    const scan = await buildSecretMap(files, tmp);
    const perFile = await applyMasking(files, scan.mapping, tmp, true);

    expect(fs.readFileSync(p, 'utf8')).toBe(SECRETS.openai_key); // untouched
    expect(Object.keys(perFile)).toHaveLength(1); // but still reported
  });

  it('replaces a longer secret before one contained inside it', async () => {
    const longSecret = `sk-${'E'.repeat(40)}`;
    const p = writeSession('a.claude.json', longSecret);
    const files = await iterFiles(sessionsDir);
    const scan = await buildSecretMap(files, tmp);
    await applyMasking(files, scan.mapping, tmp, false);
    const after = fs.readFileSync(p, 'utf8');
    expect(after).toHaveLength(longSecret.length);
    expect(after).not.toContain('EEEE');
  });
});

describe('run', () => {
  it('masks the store, writes a report, and summarizes', async () => {
    writeSession('a.claude.json', Object.values(SECRETS).join('\n'));
    const summary = await run({ repoRoot: tmp, user: 'alice' });

    expect(summary.filesScanned).toBeGreaterThan(0);
    expect(summary.unique).toBe(Object.keys(SECRETS).length);
    expect(summary.filesModified).toBe(1);
    expect(fs.existsSync(summary.reportPath!)).toBe(true);
    expect(fs.readFileSync(summary.reportPath!, 'utf8')).toContain('# Session masking report');
  });

  it('is idempotent: a second run finds nothing left to mask', async () => {
    writeSession('a.claude.json', Object.values(SECRETS).join('\n'));
    await run({ repoRoot: tmp, user: 'alice' });
    const second = await run({ repoRoot: tmp, user: 'alice' });

    expect(second.unique).toBe(0);
    expect(second.replacements).toBe(0);
    expect(second.filesModified).toBe(0);
  });

  it('reports an empty store without writing anything', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mask-empty-'));
    try {
      const summary = await run({ repoRoot: empty });
      expect(summary.filesScanned).toBe(0);
      expect(summary.reportPath).toBeNull();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('honors an explicit report path and a dry run', async () => {
    writeSession('a.claude.json', SECRETS.openai_key);
    const reportPath = path.join(tmp, 'report.md');
    const summary = await run({ repoRoot: tmp, user: 'alice', reportPath, dryRun: true });

    expect(summary.reportPath).toBe(reportPath);
    expect(fs.existsSync(reportPath)).toBe(false); // dry run writes no report either
    expect(summary.content).toContain('DRY-RUN');
  });
});

describe('the report', () => {
  it('shows only redacted previews, never a real secret', async () => {
    writeSession('a.claude.json', SECRETS.openai_key);
    const files = await iterFiles(sessionsDir);
    const scan = await buildSecretMap(files, tmp);
    const perFile = await applyMasking(files, scan.mapping, tmp, true);
    const report = buildReport(scan, perFile, files.length, true);

    expect(report).not.toContain(SECRETS.openai_key);
    expect(report).toContain(redact(SECRETS.openai_key));
    expect(report).toContain('### openai_key');
    expect(report).toContain('## Files modified');
  });

  it('says so when nothing was modified', () => {
    const report = buildReport(
      { mapping: new Map(), meta: new Map(), hits: new Map() }, {}, 3, false);
    expect(report).toContain('_No files modified._');
  });

  it('redacts short and long values differently', () => {
    expect(redact('abcdefghijkl')).toBe('abcd…jkl');
    expect(redact('short')).toBe('sh…');
  });
});

describe('the rule set', () => {
  it('gives every rule a global regex, so all occurrences are found', () => {
    for (const rule of RULES) {
      expect(rule.regex.flags, rule.name).toContain('g');
    }
  });

  it('names each rule uniquely', () => {
    expect(new Set(RULES.map(r => r.name)).size).toBe(RULES.length);
  });
});

describe('redactSecrets', () => {
  it('removes the value entirely, for text that is not file content', () => {
    // A filename or slug cannot carry a shape-preserving fake usefully — the value must simply
    // not appear. File contents go through applyMasking instead.
    expect(redactSecrets(`token ${SECRETS.openai_key} here`)).toBe('token redacted here');
    expect(redactSecrets(`use ${SECRETS.github_pat_classic}`)).toBe('use redacted');
  });

  it('redacts only the captured group when a rule has one', () => {
    expect(redactSecrets(`aws_secret_access_key = "${'a'.repeat(40)}"`))
      .toBe('aws_secret_access_key = "redacted"');
  });

  it('leaves ordinary text untouched', () => {
    expect(redactSecrets('Fix the failing test in auth.py')).toBe('Fix the failing test in auth.py');
  });

  it('accepts a custom placeholder', () => {
    expect(redactSecrets(SECRETS.openai_key, 'XXX')).toBe('XXX');
  });
});
