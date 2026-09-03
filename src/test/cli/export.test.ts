/**
 * `session-sitter export` — the one seam between the trail and everything downstream.
 *
 * The app never pushes. `export` writes to stdout and whatever the user chose reads it, so there is
 * no exporter, no SDK, and no coupling to a moving spec. Two shapes come out of it: ndjson for a log
 * store, and one self-contained HTML file for a human.
 *
 * The tests that matter most here are the privacy ones, and they are written as properties rather
 * than examples:
 *
 *  - the team projection **drops** keys, it does not blank them — a dashboard filter is a display
 *    choice over data that has already left the machine;
 *  - **no flag can re-add an excluded key**, checked by driving every flag the parser accepts;
 *  - the ship command is byte-identical in both scopes, which is the property that makes the design
 *    impossible to misconfigure into unsafety.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  EXPORT_SPEC, NEVER_SHIPPED, SHIP_COMMAND, TEAM_FIELDS, projectTeam, run,
} from '../../cli/export';
import { CliError } from '../../cli/args';
import { appendJsonl, type DecisionRecord } from '../../audit/trail';
import { decisionsPath } from '../../hooks/paths';
import { fakeIo } from './fakeIo';

const saved = { ...process.env };
let dir: string;

/** A record carrying every field the projection has an opinion about, including the risky ones. */
function record(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    ts: '2026-09-01T10:00:00.000Z',
    sessionId: 'sess-abc',
    cwd: '/Users/someone/work/customers/BigCo',
    tool: 'Bash',
    inputSummary: 'git push --force origin main # ship the BigCo migration',
    light: 'red',
    decision: 'deny',
    clause: 'practices §force-push',
    actor: 'policy',
    latencyMs: 12,
    rewritten: false,
    note: 'denied — practices §force-push: never force-push to a shared branch',
    rev: 'sha256:abc',
    policySource: 'artifact',
    call: { tool_name: 'Bash', input: { command: 'git push --force origin main' } },
    telemetry: null,
    ...over,
  } as DecisionRecord;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-export-'));
  process.env.SESSION_SITTER_DATA_DIR = dir;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  process.env = { ...saved };
});

const write = (...records: DecisionRecord[]) => {
  for (const r of records) { appendJsonl(decisionsPath(), r); }
};

/**
 * Drive the command the way `index.ts` does: a `CliError` carries its own exit code, so the runner
 * turns it into that code and one line on stderr rather than a stack.
 */
async function exportTo(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const io = fakeIo();
  try {
    const code = await run(argv, io);
    return { code, out: io.text(), err: io.errText() };
  } catch (err) {
    if (!(err instanceof CliError)) { throw err; }
    return { code: err.exitCode, out: io.text(), err: `${err.message}\n` };
  }
}

describe('export --jsonline', () => {
  it('emits the record unchanged at the default local scope', async () => {
    write(record());
    const { code, out } = await exportTo(['--jsonline']);
    expect(code).toBe(0);
    const lines = out.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      ts: '2026-09-01T10:00:00.000Z', cwd: '/Users/someone/work/customers/BigCo',
    });
  });

  it('is newline-delimited JSON, one object per line, so `| curl` needs no shipper', async () => {
    write(record(), record({ ts: '2026-09-01T11:00:00.000Z' }));
    const { out } = await exportTo(['--jsonline']);
    const lines = out.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) { expect(() => JSON.parse(line)).not.toThrow(); }
  });
});

describe('the team projection', () => {
  const key = Buffer.from('a'.repeat(64), 'hex');

  it('drops the excluded keys rather than blanking them', () => {
    const projected = projectTeam(record(), key) as Record<string, unknown>;
    for (const field of NEVER_SHIPPED) {
      // `in`, not a truthiness check: a present key holding null or '' has still left the machine as
      // a column a dashboard can un-hide, and a schema someone will later fill in.
      expect(field in projected, `${field} must not be a key at all`).toBe(false);
    }
  });

  it('ships only the allow-list, so a field added later is dropped by default', () => {
    const projected = projectTeam(
      { ...record(), some_future_field: 'a customer name nobody thought about' } as DecisionRecord,
      key,
    ) as Record<string, unknown>;
    expect(Object.keys(projected).sort()).toEqual([...TEAM_FIELDS].sort());
  });

  it('degrades inputSummary to a shape — the tool and its verb, never the command', () => {
    const projected = projectTeam(record(), key) as Record<string, unknown>;
    expect(projected.toolShape).toBe('Bash git push');
    expect(JSON.stringify(projected)).not.toContain('BigCo');
    expect(JSON.stringify(projected)).not.toContain('--force');
  });

  it('takes the first two tokens and then filters, never the other way round', () => {
    // Filtering first and slicing after promotes a LATER bare word into the shape, so this exact
    // command would ship the host. The order of those two operations is the whole guarantee.
    const projected = projectTeam(
      record({ inputSummary: 'curl -H "Authorization: Bearer x" payments-internal.acme.example' }),
      key,
    ) as Record<string, unknown>;
    expect(projected.toolShape).toBe('Bash curl');
    expect(JSON.stringify(projected)).not.toContain('payments-internal');
  });

  it('keeps a URL or a path out of the shape, because the verb is not always the whole prefix', () => {
    const projected = projectTeam(
      record({ inputSummary: 'curl https://payments-internal.acme.example/v2/charges' }), key,
    ) as Record<string, unknown>;
    expect(projected.toolShape).toBe('Bash curl');
    const other = projectTeam(
      record({ tool: 'Write', inputSummary: '/Users/someone/customers/BigCo/migration.md' }), key,
    ) as Record<string, unknown>;
    expect(other.toolShape).toBe('Write');
  });

  it('HMACs cwd and sessionId — stable for correlation, not reversible to a repo', () => {
    const a = projectTeam(record(), key) as Record<string, unknown>;
    const b = projectTeam(record(), key) as Record<string, unknown>;
    const elsewhere = projectTeam(record({ cwd: '/Users/someone/other' }), key) as
      Record<string, unknown>;
    expect(a.cwd).toBe(b.cwd);
    expect(a.cwd).not.toBe(elsewhere.cwd);
    expect(String(a.cwd)).not.toContain('BigCo');
    expect(String(a.sessionId)).not.toBe('sess-abc');
  });

  it('keeps the clause, the counts and the revision — the least sensitive fields in the record', () => {
    const projected = projectTeam(
      record({ telemetry: {
        tier: 'agent_cli', model: 'm', latency_ms: 9,
        input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 2,
        output_tokens: 3,
      } }), key,
    ) as Record<string, unknown>;
    expect(projected).toMatchObject({
      clause: 'practices §force-push', rev: 'sha256:abc', decision: 'deny', actor: 'policy',
    });
    expect(projected.telemetry).toMatchObject({ cache_read_input_tokens: 2 });
  });
});

describe('there is no flag that ships the excluded set', () => {
  it('holds for every flag the parser accepts, in both scopes', async () => {
    write(record());
    // Driven off the parser's own spec rather than a hand-written list: a flag added later is
    // covered the moment it is declared, which is the only version of this test that stays true.
    for (const [flag, kind] of Object.entries(EXPORT_SPEC)) {
      if (flag === '--help' || flag === '-h' || flag === '--html') { continue; }
      // A flag whose only effect is to widen the payload is the failure this guards, so the
      // assertion is on the emitted keys and not on the flag's own name.
      const value = flag === '--scope' ? 'team' : flag === '--since' ? '3650d'
        : kind === 'number' ? '5' : undefined;
      const argv = ['--jsonline', '--scope', 'team', flag];
      if (value !== undefined) { argv.push(value); }
      const { out } = await exportTo(argv);
      for (const line of out.trimEnd().split('\n').filter(Boolean)) {
        const keys = Object.keys(JSON.parse(line));
        for (const field of NEVER_SHIPPED) {
          expect(keys, `${flag} re-added ${field}`).not.toContain(field);
        }
      }
    }
  });

  it('and the ship command is byte-identical in both scopes', () => {
    // The projection decides which keys exist; the shipper never learns the scope. So there is no
    // scope-aware branch downstream and no toggle anyone can flip to leak the excluded set.
    expect(SHIP_COMMAND).not.toContain('--scope');
    expect(SHIP_COMMAND).not.toContain('redact');
  });
});

describe('export --html', () => {
  let html: string;

  beforeEach(async () => {
    write(record(), record({ ts: '2026-09-01T12:00:00.000Z', decision: 'allow', light: 'green' }));
    html = (await exportTo(['--html'])).out;
  });

  it('is self-contained — no CDN, no chart library, no remote anything', () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain('@import');
  });

  it('calls itself a snapshot, and never a dashboard', () => {
    expect(html).toMatch(/<title>[^<]*— snapshot<\/title>/);
    expect(html).toMatch(/<h1[^>]*>[^<]*— snapshot<\/h1>/);
    expect(html.toLowerCase()).not.toContain('dashboard');
  });

  it('carries the regeneration command verbatim, inside the thing that goes stale', () => {
    expect(html).toContain('session-sitter export --html');
  });

  it('states the window as two absolute instants and uses no relative time anywhere', () => {
    expect(html).not.toMatch(/\bago\b/);
    expect(html).toContain('2026-09-01T10:00:00.000Z');
    expect(html).toContain('2026-09-01T12:00:00.000Z');
  });

  it('checks its own age at view time, which is the only honest staleness signal', () => {
    expect(html).toContain('generated-at');
    expect(html).toMatch(/Date\.now\(\)/);
  });

  it('has no live affordances at all', () => {
    expect(html.toLowerCase()).not.toContain('http-equiv="refresh"');
    expect(html.toLowerCase()).not.toContain('setinterval');
    expect(html.toLowerCase()).not.toContain('last updated');
  });

  it('prints "not recorded" where nothing was recorded, never a zero', async () => {
    fs.rmSync(decisionsPath());
    write(record({ clause: null, latencyMs: null as unknown as number, telemetry: null }));
    const only = (await exportTo(['--html'])).out;
    // Three separate writers of that word, and all three matter: the latency quantiles, the cache
    // figures, and every ordinary cell. A report that fills one of them with `0` gets forwarded.
    expect(only).toContain('not recorded');
    expect(only).toContain('no decision in this window cited a clause');
    // The denial list's clause column is a plain cell over a null, which is the path a `?? 0` or a
    // `|| 0` breaks first.
    expect(only).toMatch(/<th>clause<\/th><\/tr><\/thead>\s*<tbody><tr>[\s\S]{0,400}?not recorded/);
  });

  it('says so when --limit truncated the window', async () => {
    const truncated = (await exportTo(['--html', '--limit', '1'])).out;
    expect(truncated).toMatch(/truncated/i);
  });

  it('lists the denials and rewrites, because that is what a reviewer actually reads', () => {
    expect(html).toContain('practices §force-push');
    expect(html).toMatch(/<th>what was asked<\/th>/);
  });

  it('applies the same projection, so a team snapshot is safe to forward', async () => {
    const team = (await exportTo(['--html', '--scope', 'team'])).out;
    expect(team).not.toContain('BigCo');
    expect(team).not.toContain('--force');
  });
});

describe('the arguments', () => {
  it('needs to be told which shape to produce', async () => {
    write(record());
    const { code, err } = await exportTo([]);
    expect(code).toBe(2);
    expect(err).toMatch(/--jsonline|--html/);
  });

  it('refuses a scope it does not know rather than guessing the safe one', async () => {
    const { code, err } = await exportTo(['--jsonline', '--scope', 'world']);
    expect(code).toBe(2);
    expect(err).toContain('world');
  });

  it('exits 1 when there is no trail to read, and says where it looked', async () => {
    const { code, err } = await exportTo(['--jsonline']);
    expect(code).toBe(1);
    expect(err).toContain(dir);
  });
});
