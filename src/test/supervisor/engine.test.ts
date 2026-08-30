/**
 * The classifier engines: the Claude Code envelope, Bob's prose-retry, timeouts, and the rule
 * that the prompt always rides on stdin and never on argv.
 *
 * Ports `supervisor/tests/test_engine.py`.
 */

import { describe, it, expect } from 'vitest';
import {
  BobCliEngine,
  ClaudeCodeEngine,
  EngineError,
  EngineTimeout,
  FakeEngine,
  SpawnOutcome,
  hasAssessment,
  runWithStdin,
} from '../../supervisor/engine';
import { assessment } from './fixtures';

const ok = (stdout: string): SpawnOutcome => ({ code: 0, stdout, stderr: '', timedOut: false });

/** A recording stand-in for `runWithStdin`, so no process is ever spawned. */
function recorder(outcomes: SpawnOutcome[]) {
  const calls: Array<{ cmd: string; args: string[]; input: string; env?: NodeJS.ProcessEnv }> = [];
  let i = 0;
  const run: typeof runWithStdin = async (cmd, args, input, opts) => {
    calls.push({ cmd, args, input, env: opts.env });
    return outcomes[Math.min(i++, outcomes.length - 1)];
  };
  return { run, calls };
}

describe('ClaudeCodeEngine', () => {
  const green = JSON.stringify(assessment('green'));

  it('unwraps the JSON envelope to the assistant text', async () => {
    const { run } = recorder([ok(JSON.stringify({ type: 'result', result: green }))]);
    const res = await new ClaudeCodeEngine({ run }).classify('prompt');
    expect(res.raw).toBe(green);
    expect(res.invocationId).toMatch(/^inv-/);
  });

  it('passes stdout straight through when it is not an envelope', async () => {
    const { run } = recorder([ok(green)]);
    expect((await new ClaudeCodeEngine({ run }).classify('p')).raw).toBe(green);
  });

  it('takes the last result from an event list', async () => {
    const raw = JSON.stringify([{ type: 'system' }, { type: 'result', result: green }]);
    const { run } = recorder([ok(raw)]);
    expect((await new ClaudeCodeEngine({ run }).classify('p')).raw).toBe(green);
  });

  it('sends the prompt on stdin, never as an argument', async () => {
    // A supervision prompt embeds the transcript + BDI and blows past MAX_ARG_STRLEN, so passing
    // it in argv fails with E2BIG. This is the regression guard for that.
    const bigPrompt = 'x'.repeat(300_000);
    const { run, calls } = recorder([ok(green)]);
    await new ClaudeCodeEngine({ run }).classify(bigPrompt);

    expect(calls[0].input).toBe(bigPrompt);
    expect(calls[0].args).toEqual(['-p', '--output-format', 'json']);
    expect(calls[0].args.join(' ')).not.toContain('xxx');
  });

  it('layers the configured gateway into the child environment', async () => {
    const { run, calls } = recorder([ok(green)]);
    await new ClaudeCodeEngine({
      run, anthropicBaseUrl: 'https://gw.example', anthropicAuthToken: 'tok',
    }).classify('p');
    expect(calls[0].env?.ANTHROPIC_BASE_URL).toBe('https://gw.example');
    expect(calls[0].env?.ANTHROPIC_AUTH_TOKEN).toBe('tok');
  });

  it('leaves the environment alone when no gateway is configured', async () => {
    const { run, calls } = recorder([ok(green)]);
    await new ClaudeCodeEngine({ run }).classify('p');
    expect(calls[0].env?.ANTHROPIC_BASE_URL).toBe(process.env.ANTHROPIC_BASE_URL);
  });

  it('raises on a non-zero exit, quoting stderr', async () => {
    const run: typeof runWithStdin = async () => ({
      code: 1, stdout: '', stderr: 'auth failed', timedOut: false,
    });
    await expect(new ClaudeCodeEngine({ run }).classify('p'))
      .rejects.toThrow(/claude exited 1: auth failed/);
  });

  it('raises on empty output', async () => {
    const { run } = recorder([ok('   ')]);
    await expect(new ClaudeCodeEngine({ run }).classify('p'))
      .rejects.toThrow(/produced no output/);
  });

  it('raises a timeout as its own error type', async () => {
    const run: typeof runWithStdin = async () => ({
      code: null, stdout: '', stderr: '', timedOut: true,
    });
    const engine = new ClaudeCodeEngine({ run, timeoutSeconds: 12 });
    await expect(engine.classify('p')).rejects.toThrow(EngineTimeout);
    await expect(engine.classify('p')).rejects.toThrow(/timed out after 12s/);
  });
});

describe('BobCliEngine', () => {
  const green = JSON.stringify(assessment('green'));

  it('returns the first response that contains an assessment', async () => {
    const { run, calls } = recorder([ok(green)]);
    const res = await new BobCliEngine({ run }).classify('prompt');
    expect(res.raw).toBe(green);
    expect(calls).toHaveLength(1); // no retry needed
  });

  it('retries once with a hardened instruction when the first reply is prose', async () => {
    const { run, calls } = recorder([ok('I think this is fine, go ahead.'), ok(green)]);
    const res = await new BobCliEngine({ run }).classify('prompt');

    expect(calls).toHaveLength(2);
    expect(calls[0].input).toBe('prompt');
    expect(calls[1].input).toContain('CRITICAL OUTPUT REQUIREMENT');
    expect(res.raw).toBe(green);
  });

  it('gives up after two attempts and returns the last output', async () => {
    // The orchestrator salvages prose and, failing that, escalates to the human — so returning
    // the raw text here is what lets that recovery happen instead of a hard failure.
    const { run, calls } = recorder([ok('prose one'), ok('prose two')]);
    const res = await new BobCliEngine({ run }).classify('prompt');
    expect(calls).toHaveLength(2);
    expect(res.raw).toBe('prose two');
  });

  it('sends the prompt on stdin with only a short constant trigger in argv', async () => {
    const { run, calls } = recorder([ok(green)]);
    await new BobCliEngine({ run }).classify('y'.repeat(200_000));

    expect(calls[0].input.length).toBe(200_000);
    expect(calls[0].args).toContain('-p');
    expect(calls[0].args.join(' ').length).toBeLessThan(200);
  });

  it('passes the API key through the child environment', async () => {
    const { run, calls } = recorder([ok(green)]);
    await new BobCliEngine({ run, apiKey: 'secret' }).classify('p');
    expect(calls[0].env?.BOBSHELL_API_KEY).toBe('secret');
  });

  it('runs in an isolated directory, never the workspace', async () => {
    // Bob's context gathering scans its cwd and can crash on knowledge markdown; the prompt is
    // self-contained, so an empty temp dir is both safe and sufficient.
    const { run } = recorder([ok(green)]);
    const engine = new BobCliEngine({ run });
    await engine.classify('p');
    const cwdUsed = (engine as unknown as { cwd: string }).cwd;
    expect(cwdUsed).toContain('supervisor-bob-');
  });

  it('raises on a non-zero exit and on empty output', async () => {
    await expect(new BobCliEngine({
      run: async () => ({ code: 2, stdout: '', stderr: 'no key', timedOut: false }),
    }).classify('p')).rejects.toThrow(/bob exited 2: no key/);

    await expect(new BobCliEngine({ run: async () => ok('') }).classify('p'))
      .rejects.toThrow(/produced no output/);
  });
});

describe('hasAssessment', () => {
  it('is true only for output carrying a traffic_light object', () => {
    expect(hasAssessment('{"traffic_light":"green"}')).toBe(true);
    expect(hasAssessment('prose ```json\n{"traffic_light":"red"}\n```')).toBe(true);
    expect(hasAssessment('{"other":1}')).toBe(false);
    expect(hasAssessment('just prose')).toBe(false);
    expect(hasAssessment('')).toBe(false);
  });
});

describe('runWithStdin', () => {
  it('feeds stdin and captures both streams', async () => {
    const res = await runWithStdin(
      'node', ['-e', 'process.stdin.on("data",d=>{process.stdout.write("got:"+d);process.stderr.write("err")})'],
      'hello', { timeoutMs: 10_000 });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('got:hello');
    expect(res.stderr).toBe('err');
    expect(res.timedOut).toBe(false);
  });

  it('kills a command that overruns its timeout', async () => {
    const res = await runWithStdin('node', ['-e', 'setTimeout(()=>{},60000)'], '', { timeoutMs: 250 });
    expect(res.timedOut).toBe(true);
  });

  it('reports a missing binary as an engine error', async () => {
    await expect(runWithStdin('definitely-not-a-real-binary-xyz', [], '', { timeoutMs: 5000 }))
      .rejects.toThrow(EngineError);
  });
});

describe('FakeEngine', () => {
  it('returns scripted responses in order and records the prompts', async () => {
    const engine = new FakeEngine(['a', (p: string) => `saw:${p}`]);
    expect((await engine.classify('one')).raw).toBe('a');
    expect((await engine.classify('two')).raw).toBe('saw:two');
    expect(engine.prompts).toEqual(['one', 'two']);
    expect(engine.callCount).toBe(2);
  });

  it('throws a scripted error, and when it runs out', async () => {
    const engine = new FakeEngine([new EngineError('boom')]);
    await expect(engine.classify('p')).rejects.toThrow('boom');
    await expect(engine.classify('p')).rejects.toThrow(/ran out of scripted responses/);
  });
});
