/**
 * Piped output must not be truncated — the bug this file exists for, and why it is a subprocess test.
 *
 * `process.stdout.write` to a **pipe** is asynchronous. `process.exit()` does not wait for it, so a
 * command that writes more than the pipe buffer (~64 KiB) and then exits loses everything that has
 * not drained. Redirecting to a *file* hides it completely, because writes to a file are synchronous
 * on POSIX — which is why this went unnoticed: `export --jsonline > file.ndjson` is whole and
 * `export --jsonline | curl` is not.
 *
 * It affected every command, not just `export`: any `--json` output piped into `jq`, any `digest`
 * piped into `less`. The fix is at the one exit point every command routes through.
 *
 * It has to be a real subprocess with a real pipe. An in-process `Io` collects into a string and
 * would pass against the broken code, and a file redirect passes against it too — the only setup
 * that can fail is the one the user actually types.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appendJsonl, type DecisionRecord } from '../../audit/trail';
import { decisionsPath } from '../../hooks/paths';

let dir: string;
const CLI = path.join(__dirname, '..', '..', '..', 'out', 'cli', 'index.js');

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-flush-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** Enough records that the ndjson is comfortably past any pipe buffer. */
function writeTrail(count: number): void {
  for (let i = 0; i < count; i++) {
    appendJsonl(decisionsPath({ SESSION_SITTER_DATA_DIR: dir } as NodeJS.ProcessEnv), {
      ts: new Date(Date.UTC(2026, 8, 1, 0, 0, i % 60)).toISOString(),
      sessionId: `sess-${i % 20}`,
      cwd: '/work/example-service',
      tool: 'Bash',
      inputSummary: `npm run some-fairly-long-script-name-${i} -- --with --several --arguments`,
      light: 'green', decision: 'allow', clause: null, actor: 'deterministic',
      latencyMs: 1, rewritten: false, rev: 'sha256:aaa', policySource: 'artifact',
      call: { tool_name: 'Bash', input: {} }, telemetry: null,
    } as DecisionRecord);
  }
}

describe('output survives a pipe', () => {
  it('writes every line when stdout is a pipe, not just the first 64 KiB', () => {
    const count = 4000;
    writeTrail(count);
    // `sh -c` with a downstream `cat` gives stdout a real pipe. Without it, execFileSync's own
    // capture is a pipe too — but the assertion is written this way so the shape of the failing case
    // is the shape a user types.
    //
    // `--limit` is raised past the record count on purpose: its default is 2 000, so a test that let
    // it apply would assert the limiter and pass against a truncating exit.
    const out = execFileSync('/bin/sh', [
      '-c', `node ${JSON.stringify(CLI)} export --jsonline --limit ${count} | cat`,
    ], {
      env: { ...process.env, SESSION_SITTER_DATA_DIR: dir },
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    });
    expect(out.length).toBeGreaterThan(64 * 1024);
    const lines = out.trimEnd().split('\n');
    expect(lines).toHaveLength(count);
    // The last line whole, not a prefix: truncation lands mid-object, and a reader that aborts on
    // the first unparseable line then discards everything after it.
    expect(() => JSON.parse(lines[lines.length - 1])).not.toThrow();
    for (const line of lines) { expect(line.endsWith('}')).toBe(true); }
  });

  it('still returns the command exit code through the pipe', () => {
    // The flush must not cost the exit code — a cron that ships on a schedule depends on it. Asserted
    // on the EXPORTER's status, not the pipeline's: `sh -c 'a | b'` exits with b's, so a test that
    // read the pipeline status would pass however wrong the exporter's code was.
    const out = execFileSync('/bin/sh', [
      '-c', `node ${JSON.stringify(CLI)} export --jsonline 2>/dev/null | cat; echo "rc=\${PIPESTATUS[0]:-$?}"`,
    ], { env: { ...process.env, SESSION_SITTER_DATA_DIR: dir }, encoding: 'utf8' });
    // No trail on this machine, so the exporter exits 1 and says where it looked.
    expect(out).toContain('rc=1');
  });

  it('does not hang when the reader closes early', () => {
    writeTrail(4000);
    // `| head -1` closes the pipe after one line. The flush callback cannot complete there, and the
    // process must still exit rather than wait forever on a reader that has gone.
    const out = execFileSync('/bin/sh', [
      '-c', `node ${JSON.stringify(CLI)} export --jsonline 2>/dev/null | head -1`,
    ], { env: { ...process.env, SESSION_SITTER_DATA_DIR: dir }, encoding: 'utf8', timeout: 20000 });
    expect(out.trimEnd().split('\n')).toHaveLength(1);
  });
});
