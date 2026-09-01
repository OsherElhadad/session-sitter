#!/usr/bin/env node
/**
 * Measure the `PermissionRequest` hook's wall-clock latency, as a real process.
 *
 * The hook sits in front of a human-visible prompt, so its budget is milliseconds rather than the
 * 60 s the contract allows. That claim needs a number a reviewer can reproduce, not an estimate —
 * hence this script rather than a paragraph.
 *
 * It spawns `plugin/lib/hooks/permissionRequest.js` as a separate process per sample, so the figure
 * includes Node startup, module loading, the decision, and the audit append: exactly what Claude
 * Code pays. Each scenario writes to a fresh temp data dir so one run cannot bias the next.
 *
 *     node scripts/time-permission-hook.js [--samples 50]
 *
 * Exits non-zero when a scenario's verdict is not the expected one, so the timing run doubles as an
 * assertion that the deterministic path still decides deterministically. The classifier is pointed
 * at a path that does not exist: any scenario that reached for a model would come back as a
 * fail-closed deny with actor `timeout`, and the verdict check would fail.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const hook = path.join(repoRoot, 'plugin', 'lib', 'hooks', 'permissionRequest.js');

const samplesArg = process.argv.indexOf('--samples');
const SAMPLES = samplesArg >= 0 ? Number.parseInt(process.argv[samplesArg + 1], 10) || 50 : 50;

/** A practices file with one matchable green clause, so the written-clause rung can be timed too. */
const PRACTICES = `### Intention: Running the test suite needs no approval

| Field | Value |
|---|---|
| id | tests-are-free |
| level | green |

Match: npm test

The suite writes only inside the working tree.
`;

const SCENARIOS = [
  {
    name: 'rung 1  deterministic green (Read)',
    event: { tool_name: 'Read', tool_input: { file_path: '/tmp/x.ts' } },
    expect: { behavior: 'allow', actor: 'deterministic', rewritten: false },
  },
  {
    name: 'rung 2  correction lane (git push --force)',
    event: { tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } },
    expect: { behavior: 'allow', actor: 'policy', rewritten: true },
  },
  {
    name: 'rung 4  written green clause (npm test)',
    event: { tool_name: 'Bash', tool_input: { command: 'npm test' } },
    expect: { behavior: 'allow', actor: 'policy', rewritten: false },
  },
  {
    name: 'rung 5  built-in red table (rm -rf)',
    event: { tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/anything' } },
    expect: { behavior: 'deny', actor: 'deterministic', rewritten: false },
  },
  {
    name: 'rung 7  fail closed (Write, no classifier)',
    event: { tool_name: 'Write', tool_input: { file_path: '/tmp/a.ts', content: 'x' } },
    expect: { behavior: 'deny', actor: 'timeout', rewritten: false },
  },
];

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function run(scenario, dataDir, practicesFile) {
  const payload = JSON.stringify({
    session_id: 'timing', cwd: '/tmp', hook_event_name: 'PermissionRequest', ...scenario.event,
  });
  const env = {
    ...process.env,
    SESSION_SITTER_DATA_DIR: dataDir,
    SESSION_SITTER_PRACTICES: practicesFile,
    // Any rung that reached for a model would fail here and surface as a `timeout` deny.
    SUPERVISOR_ENGINE: 'bob',
    BOB_CLI_PATH: '/nonexistent/classifier',
  };

  const timings = [];
  let lastOutput = null;
  for (let i = 0; i < SAMPLES; i++) {
    const started = process.hrtime.bigint();
    const proc = spawnSync(process.execPath, [hook], { input: payload, env, encoding: 'utf8' });
    timings.push(Number(process.hrtime.bigint() - started) / 1e6);
    if (proc.status !== 0) {
      throw new Error(`${scenario.name}: hook exited ${proc.status}: ${proc.stderr}`);
    }
    lastOutput = proc.stdout;
  }
  return { timings, lastOutput };
}

function main() {
  if (!fs.existsSync(hook)) {
    process.stderr.write(`missing ${hook} — run \`make plugin\` first\n`);
    return 1;
  }

  const practicesFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-timing-')), 'practices.md');
  fs.writeFileSync(practicesFile, PRACTICES, 'utf8');

  process.stdout.write(`PermissionRequest latency — ${SAMPLES} process spawns per scenario\n`);
  process.stdout.write(`node ${process.version} · ${os.platform()} ${os.release()} · ${os.cpus()[0].model}\n\n`);
  process.stdout.write('scenario                                     min     p50     p95     max   verdict\n');
  process.stdout.write('-'.repeat(96) + '\n');

  let failures = 0;
  for (const scenario of SCENARIOS) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-timing-data-'));
    const { timings, lastOutput } = run(scenario, dataDir, practicesFile);
    const sorted = [...timings].sort((a, b) => a - b);

    const decision = JSON.parse(lastOutput).hookSpecificOutput?.decision ?? {};
    const records = fs.readFileSync(path.join(dataDir, 'decisions.jsonl'), 'utf8')
      .trim().split('\n').map(l => JSON.parse(l));
    const record = records[records.length - 1];

    const actual = {
      behavior: decision.behavior,
      actor: record.actor,
      rewritten: record.rewritten,
    };
    const ok = Object.entries(scenario.expect).every(([k, v]) => actual[k] === v);
    if (!ok) { failures++; }

    const ms = (n) => n.toFixed(1).padStart(6);
    process.stdout.write(
      `${scenario.name.padEnd(44)}${ms(sorted[0])}  ${ms(percentile(sorted, 0.5))}  `
      + `${ms(percentile(sorted, 0.95))}  ${ms(sorted[sorted.length - 1])}   `
      + `${ok ? '✓' : '✗'} ${actual.behavior}/${actual.actor}`
      + `${actual.rewritten ? '/rewritten' : ''}\n`);
    if (!ok) {
      process.stdout.write(`    expected ${JSON.stringify(scenario.expect)}\n`);
      process.stdout.write(`    got      ${JSON.stringify(actual)}\n`);
    }
    // Every scenario wrote exactly `SAMPLES` records, which is also a check that the audit append
    // is on the measured path rather than being skipped.
    if (records.length !== SAMPLES) {
      process.stdout.write(`    ✗ expected ${SAMPLES} audit records, found ${records.length}\n`);
      failures++;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  process.stdout.write('\nEvery figure is a whole OS process: Node startup, module load, decision, '
    + 'and one audit append.\n');
  process.stdout.write('The classifier was pointed at /nonexistent/classifier throughout, so any '
    + 'scenario that\nreached for a model would show actor=timeout and fail its verdict check.\n');
  return failures === 0 ? 0 : 1;
}

process.exit(main());
