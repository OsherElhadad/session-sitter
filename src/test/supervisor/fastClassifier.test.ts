/**
 * The fast supervisor tier: the request shape that makes the caching work, the model derivation,
 * the verdict contract, and the guarantee that every failure mode falls BACK rather than approves.
 *
 * No network: the transport is injected, so these tests assert the exact bytes the tier would put
 * on the wire.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { FakeEngine } from '../../supervisor/engine';
import {
  FastClassifier,
  FastClassifierError,
  FastRequestBody,
  FastResult,
  HttpFastClassifier,
  MIN_FAST_CONFIDENCE,
  PostJson,
  assessmentFromVerdict,
  buildRequestBody,
  conversationMessages,
  parseVerdict,
  supervisorModel,
} from '../../supervisor/fastClassifier';
import { KnowledgeBundle } from '../../supervisor/knowledge';
import { SupervisionState } from '../../supervisor/models';
import { NormalizedSession, sessionFromDict } from '../../supervisor/transcript';
import {
  SESSION_ID,
  assessment,
  buildTestOrchestrator,
  makeExport,
  makeTmpDir,
} from './fixtures';

let tmp: string;
beforeEach(() => { tmp = makeTmpDir(); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const BUNDLE: KnowledgeBundle = {
  user: 'alice', project: 'demo', team: 'platform',
  entries: [], loadedFiles: [], missingFiles: [],
};

/** A pending action the deterministic tier leaves alone, so the fast tier is the one that runs. */
const ambiguous = (overrides: Parameters<typeof makeExport>[0] = {}) => makeExport({
  pendingName: 'write_to_file',
  pendingArgs: { path: 'src/app.ts', content: 'x' },
  pendingDescription: 'Write src/app.ts',
  ...overrides,
});

const session = (overrides: Parameters<typeof makeExport>[0] = {}): NormalizedSession =>
  sessionFromDict(ambiguous(overrides));

const verdict = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  light: 'green', confidence: 0.9, clause: 'none', reason: 'reversible local write',
  rewrite: null, message: null, ...overrides,
});

/** A Messages API response envelope carrying `text` and a usage block. */
const envelope = (text: string, usage: Record<string, number> = {}): string => JSON.stringify({
  content: [{ type: 'text', text }],
  usage: {
    input_tokens: 42, cache_creation_input_tokens: 177, cache_read_input_tokens: 11089,
    output_tokens: 31, ...usage,
  },
});

/** A transport that records what it was called with and replies with a canned response. */
function fakePost(reply: { status?: number; body: string } | Error): {
  post: PostJson; calls: Array<{ url: string; headers: Record<string, string>; body: string; timeoutMs: number }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string; timeoutMs: number }> = [];
  const post: PostJson = async (url, headers, body, timeoutMs) => {
    calls.push({ url, headers, body, timeoutMs });
    if (reply instanceof Error) { throw reply; }
    return { status: reply.status ?? 200, body: reply.body };
  };
  return { post, calls };
}

const classifier = (post: PostJson, model = 'aws/claude-opus-5'): HttpFastClassifier =>
  new HttpFastClassifier({
    baseUrl: 'https://gateway.example/', authToken: 'sk-secret-token', model, post,
  });

describe('the model the supervisor judges with', () => {
  it("defaults to the agent's own model", () => {
    expect(supervisorModel('aws/claude-sonnet-5')).toBe('aws/claude-sonnet-5');
  });

  it('strips a trailing context-window suffix, which a Messages endpoint rejects', () => {
    expect(supervisorModel('aws/claude-opus-5[1m]')).toBe('aws/claude-opus-5');
    expect(supervisorModel('aws/claude-opus-5[200k]')).toBe('aws/claude-opus-5');
  });

  it('strips the suffix from an override too, so a copy-pasted id still works', () => {
    expect(supervisorModel('aws/claude-opus-5[1m]', 'aws/claude-haiku-4-5[1m]'))
      .toBe('aws/claude-haiku-4-5');
  });

  it('leaves a suffix that is not a context window alone', () => {
    expect(supervisorModel('some/model[preview]')).toBe('some/model[preview]');
  });

  it('is null when nothing is configured, so the tier simply does not run', () => {
    expect(supervisorModel(null)).toBeNull();
    expect(supervisorModel('', '  ')).toBeNull();
  });
});

describe('the request shape', () => {
  const body = (): FastRequestBody => buildRequestBody(session(), BUNDLE, 'aws/claude-opus-5');

  it('breaks the cache on the last system block, covering the rubric and the practices', () => {
    const system = body().system;
    expect(system).toHaveLength(2);
    expect(system[0].cache_control).toBeUndefined();
    expect(system[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(system[1].text).toContain('WRITTEN PRACTICES');
  });

  it('carries the rewrite-over-red instruction that a plain rubric got wrong', () => {
    expect(body().system[0].text).toContain('PREFER yellow+rewrite over red');
  });

  it('breaks the cache on the last block of the CONVERSATION, not the judging turn', () => {
    const messages = body().messages;
    const judging = messages[messages.length - 1];
    expect(judging.role).toBe('user');
    expect(judging.content[0].text).toContain('SUPERVISOR CHECK');
    // Nothing after the last breakpoint is cached, and that is where the per-decision content
    // belongs — so the judging turn must never carry a marker.
    expect(judging.content.every(b => b.cache_control === undefined)).toBe(true);

    const conversation = messages.slice(0, -1).flatMap(m => m.content);
    const marked = conversation.filter(b => b.cache_control !== undefined);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toBe(conversation[conversation.length - 1]);
  });

  it('asks the model to judge the pending call specifically', () => {
    const judging = body().messages.slice(-1)[0].content[0].text;
    expect(judging).toContain('write_to_file');
    expect(judging).toContain('src/app.ts');
  });

  it('adds a second breakpoint further back, so a >20-block interval still finds the cache', () => {
    // A breakpoint walks back at most 20 content blocks; with 40 the marker on the last block
    // alone could miss the previous decision's entry.
    const turns = Array.from({ length: 40 }, (_, i) => ({
      index: i, role: i % 2 === 0 ? 'user' : 'assistant', text: `step ${i}`,
    }));
    const long = sessionFromDict({ ...ambiguous(), turns });
    const messages = buildRequestBody(long, BUNDLE, 'm').messages;
    const conversation = messages.slice(0, -1).flatMap(m => m.content);
    const markedAt = conversation
      .map((b, i) => (b.cache_control ? i : -1)).filter(i => i >= 0);
    expect(markedAt).toEqual([conversation.length - 16, conversation.length - 1]);
    // Both are within the 4-breakpoint budget, together with the system one.
    expect(markedAt.length + 1).toBeLessThanOrEqual(4);
  });

  it('gives each turn its own content block, so appending a turn cannot move the prefix', () => {
    const first = conversationMessages(sessionFromDict({
      ...ambiguous(),
      turns: [
        { index: 0, role: 'user', text: 'a' },
        { index: 1, role: 'assistant', text: 'b' },
        { index: 2, role: 'assistant', text: 'c' },
      ],
    }));
    // Consecutive same-role turns are grouped into one message (the API alternates roles) but
    // stay separate blocks.
    expect(first.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(first[1].content.map(b => b.text)).toEqual(['b', 'c']);

    const grown = conversationMessages(sessionFromDict({
      ...ambiguous(),
      turns: [
        { index: 0, role: 'user', text: 'a' },
        { index: 1, role: 'assistant', text: 'b' },
        { index: 2, role: 'assistant', text: 'c' },
        { index: 3, role: 'user', text: 'd' },
      ],
    }));
    // Every block the first request sent reappears, in order, unchanged — that identity is what
    // the cache is keyed on.
    const blocks = (ms: ReturnType<typeof conversationMessages>): string[] =>
      ms.flatMap(m => m.content.map(b => `${m.role}:${b.text}`));
    expect(blocks(grown).slice(0, blocks(first).length)).toEqual(blocks(first));
  });

  it('drops empty turns rather than sending an empty block', () => {
    const messages = conversationMessages(sessionFromDict({
      ...ambiguous(),
      turns: [
        { index: 0, role: 'user', text: 'a' },
        { index: 1, role: 'assistant', text: '   ' },
      ],
    }));
    expect(messages).toHaveLength(1);
  });

  it('starts at a user turn, as the API requires', () => {
    const messages = conversationMessages(sessionFromDict({
      ...ambiguous(),
      turns: [
        { index: 0, role: 'assistant', text: 'I was resumed mid-thought' },
        { index: 1, role: 'user', text: 'carry on' },
      ],
    }));
    expect(messages[0].role).toBe('user');
  });

  it('posts to /v1/messages with both auth headers and the anthropic version', async () => {
    const { post, calls } = fakePost({ body: envelope(verdict()) });
    await classifier(post).judge(session(), BUNDLE);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://gateway.example/v1/messages');
    expect(calls[0].headers.authorization).toBe('Bearer sk-secret-token');
    expect(calls[0].headers['x-api-key']).toBe('sk-secret-token');
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0].timeoutMs).toBe(10_000);
  });
});

describe('prefix stability — the property the whole tier rests on', () => {
  /**
   * The cached region of a request: the system blocks plus the conversation blocks, in render
   * order, with `cache_control` stripped. The marker MOVES between requests by design and is not
   * part of what the cache is keyed on, so it has to come off before comparing.
   */
  const cachedRegion = (body: FastRequestBody): string[] =>
    [...body.system, ...body.messages.slice(0, -1).flatMap(m => m.content)]
      .map(b => JSON.stringify({ type: b.type, text: b.text }));

  const grownTo = (pairs: number): FastRequestBody => buildRequestBody(
    sessionFromDict({
      ...ambiguous(),
      turns: Array.from({ length: pairs * 2 }, (_, i) => ({
        index: i, role: i % 2 === 0 ? 'user' : 'assistant',
        text: `turn ${i} of the conversation, long enough to be a realistic block of text`,
      })),
    }), BUNDLE, 'aws/claude-opus-5');

  it('renders request N as a byte-exact prefix of request N+1, over successive growth', () => {
    // The regression test for the bug the latency audit found in the SLOW prompt builder: a
    // sliding window plus absolute turn indices left consecutive calls sharing only ~207 tokens
    // of a ~5300-token prompt — under the minimum cacheable prefix, so nothing could ever cache.
    // If this fails, the fast tier has inherited that bug and its cache is gone.
    let previous = cachedRegion(grownTo(3));
    for (const pairs of [4, 5, 8, 20]) {
      const next = cachedRegion(grownTo(pairs));
      expect(next.slice(0, previous.length)).toEqual(previous);
      expect(next.length).toBeGreaterThan(previous.length);
      previous = next;
    }
  });

  it('keeps every constant ahead of the conversation, never trailing it', () => {
    // The slow builder appends a 1776-token constant footer AFTER the variable transcript, which
    // is exactly backwards — constant content has to precede variable content to be cacheable.
    const body = grownTo(4);
    expect(body.system[0].text).toContain('You are the Session Sitter supervisor');
    expect(body.system[1].text).toContain('WRITTEN PRACTICES');
    expect(body.messages.slice(-1)[0].content).toHaveLength(1); // only the judging turn trails
  });

  it('leaks no index, timestamp or session id into the cached region', () => {
    // Deliberately the DEFAULT fixture, whose turns carry both absolute indices and ISO
    // timestamps — proving `renderTurn` drops them rather than that the fixture lacked them.
    const region = cachedRegion(buildRequestBody(session(), BUNDLE, 'm')).join('\n');
    expect(region).not.toContain(SESSION_ID);
    expect(region).not.toMatch(/\[\d+\]\s+(user|assistant|tool)/); // absolute turn indices
    expect(region).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);   // ISO timestamps
  });
});

describe('the verdict contract', () => {
  it('expands a green verdict into a schema-valid assessment', async () => {
    const { post } = fakePost({ body: envelope(verdict()) });
    const res = await classifier(post).judge(session(), BUNDLE);
    expect(res.assessment.traffic_light).toBe('green');
    expect(res.assessment.summary).toContain('reversible local write');
  });

  it('turns a yellow rewrite into guidance addressed from the supervisor', () => {
    const a = assessmentFromVerdict(parseVerdict(verdict({
      light: 'yellow', clause: '§1', message: 'A shared branch needs a lease.',
      rewrite: 'git push --force-with-lease origin main',
    })), session());
    expect(a.traffic_light).toBe('yellow');
    expect(a.supervisor_message_to_agent).toContain('Supervisor:');
    expect(a.supervisor_message_to_agent).toContain('--force-with-lease');
  });

  it('blocks the pending action on red, and the agent with it', () => {
    const a = assessmentFromVerdict(
      parseVerdict(verdict({ light: 'red', reason: 'deletes published history' })), session());
    expect(a.should_block_agent).toBe(true);
    expect(a.should_block_original_action).toBe(true);
    expect(a.blocked_actions).toHaveLength(1);
    expect(a.human_notification).toContain('deletes published history');
  });

  it('asks the human on orange without blocking the agent outright', () => {
    const a = assessmentFromVerdict(parseVerdict(verdict({ light: 'orange' })), session());
    expect(a.should_block_agent).toBe(false);
    expect(a.should_block_original_action).toBe(true);
    expect(a.human_options).toEqual(['Approve', 'Reject']);
  });

  it.each([
    ['prose instead of json', 'Looks fine to me, go ahead.'],
    ['an unsupported light', verdict({ light: 'chartreuse' })],
    ['a missing light', '{"confidence":0.9,"reason":"ok"}'],
    ['confidence out of range', verdict({ confidence: 4 })],
    ['confidence as a string', verdict({ confidence: '0.9' })],
    ['no reason at all', verdict({ reason: '   ' })],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseVerdict(raw)).toThrow(FastClassifierError);
  });

  it('still speaks on a yellow that named no message, since the reason is always there', () => {
    // Yellow requires a non-empty supervisor_message_to_agent or the assessment schema rejects
    // it. The reason is mandatory, so it is always available to stand in.
    const a = assessmentFromVerdict(
      parseVerdict(verdict({ light: 'yellow', message: null, rewrite: null })), session());
    expect(a.supervisor_message_to_agent).toBe('Supervisor: reversible local write');
  });
});

describe('every failure falls back, and none of them approves', () => {
  const cases: Array<[string, { status?: number; body: string } | Error]> = [
    ['a malformed verdict', { body: envelope('not json at all') }],
    ['a verdict with a bogus light', { body: envelope(verdict({ light: 'blue' })) }],
    ['low confidence', { body: envelope(verdict({ confidence: MIN_FAST_CONFIDENCE - 0.1 })) }],
    ['a rejected model', { status: 403, body: '{"error":"model not allowed"}' }],
    ['a gateway error', { status: 500, body: 'upstream unavailable' }],
    ['a non-JSON response', { body: '<html>502</html>' }],
    ['a transport failure', new Error('ECONNRESET')],
  ];

  it.each(cases)('%s raises FastClassifierError', async (_label, reply) => {
    const { post } = fakePost(reply);
    await expect(classifier(post).judge(session(), BUNDLE))
      .rejects.toThrow(FastClassifierError);
  });

  it('never leaks the auth token into the error, even when a gateway echoes it', async () => {
    const { post } = fakePost({ status: 401, body: 'bad key: sk-secret-token' });
    await expect(classifier(post).judge(session(), BUNDLE))
      .rejects.toThrow(/\*\*\*/);
    await expect(classifier(post).judge(session(), BUNDLE))
      .rejects.not.toThrow(/sk-secret-token/);
  });

  it('carries the telemetry on the error, so a fallback is still accounted for', async () => {
    const { post } = fakePost({ body: envelope('not json at all') });
    const err = await classifier(post).judge(session(), BUNDLE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FastClassifierError);
    expect((err as FastClassifierError).telemetry?.cache_read_input_tokens).toBe(11089);
  });
});

describe('telemetry', () => {
  it('records the latency, the token counts and which tier answered', async () => {
    const { post } = fakePost({ body: envelope(verdict()) });
    const res = await classifier(post, 'aws/claude-sonnet-5').judge(session(), BUNDLE);

    expect(res.telemetry.tier).toBe('fast_llm');
    expect(res.telemetry.model).toBe('aws/claude-sonnet-5');
    expect(res.telemetry.latency_ms).toBeGreaterThanOrEqual(0);
    expect(res.telemetry.input_tokens).toBe(42);
    expect(res.telemetry.cache_creation_input_tokens).toBe(177);
    expect(res.telemetry.cache_read_input_tokens).toBe(11089);
    expect(res.telemetry.output_tokens).toBe(31);
  });

  it('reports zeros rather than NaN when a gateway omits the usage block', async () => {
    const { post } = fakePost({ body: JSON.stringify({ content: [{ type: 'text', text: verdict() }] }) });
    const res = await classifier(post).judge(session(), BUNDLE);
    expect(res.telemetry.cache_read_input_tokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------- the tier ladder

/** A fast tier under test control: answer, or fail the way the real one fails. */
class StubFast implements FastClassifier {
  calls = 0;

  constructor(private readonly outcome: FastResult | FastClassifierError) {}

  async judge(): Promise<FastResult> {
    this.calls++;
    if (this.outcome instanceof FastClassifierError) { throw this.outcome; }
    return this.outcome;
  }
}

const fastResult = (light: string): FastResult => ({
  assessment: assessment(light) as unknown as FastResult['assessment'],
  telemetry: {
    tier: 'fast_llm', model: 'aws/claude-opus-5', latency_ms: 3412,
    input_tokens: 40, cache_creation_input_tokens: 177, cache_read_input_tokens: 11089,
    output_tokens: 28,
  },
});

describe('the tier ladder in the orchestrator', () => {
  it('answers from the fast tier without ever spending an agent-CLI call', async () => {
    const engine = new FakeEngine([]); // any CLI call would throw "out of scripted responses"
    const fast = new StubFast(fastResult('green'));
    const rig = buildTestOrchestrator(tmp, engine, { exported: ambiguous(), fastClassifier: fast });

    const rec = await rig.orch.supervise(SESSION_ID);
    expect(fast.calls).toBe(1);
    expect(engine.callCount).toBe(0);
    expect(rec.state).toBe(SupervisionState.GREEN_COMPLETED);
  });

  it('records the fast tier telemetry on the decision, so the audit can prove the speedup', async () => {
    const rig = buildTestOrchestrator(tmp, new FakeEngine([]), {
      exported: ambiguous(), fastClassifier: new StubFast(fastResult('green')),
    });
    const rec = await rig.orch.supervise(SESSION_ID);

    const ev = rec.events.find(e => e.type === 'tier_fast_llm');
    expect(ev).toBeDefined();
    expect(ev?.latency_ms).toBe(3412);
    expect(ev?.cache_read_input_tokens).toBe(11089);
    expect(ev?.model).toBe('aws/claude-opus-5');
  });

  it('runs the deterministic tier FIRST, so an obvious red never reaches the network', async () => {
    const fast = new StubFast(fastResult('green'));
    const rig = buildTestOrchestrator(tmp, new FakeEngine([]), {
      exported: makeExport({ pendingArgs: { command: 'rm -rf /tmp/x' } }),
      fastClassifier: fast,
    });
    const rec = await rig.orch.supervise(SESSION_ID);

    expect(fast.calls).toBe(0);
    expect(rec.events.some(e => e.type === 'tier_red_no_model')).toBe(true);
    expect(rec.await_light).toBe('red');
  });

  it('falls back to the agent classifier on a timeout, and does NOT approve', async () => {
    const engine = new FakeEngine([JSON.stringify(assessment('orange'))]);
    const fast = new StubFast(new FastClassifierError('fast classifier timed out after 10000ms'));
    const rig = buildTestOrchestrator(tmp, engine, { exported: ambiguous(), fastClassifier: fast });

    const rec = await rig.orch.supervise(SESSION_ID);
    expect(fast.calls).toBe(1);
    expect(engine.callCount).toBe(1);           // the slow tier took the decision
    expect(rec.assessment?.traffic_light).toBe('orange');
    expect(rec.state).toBe(SupervisionState.ORANGE_AWAITING_USER);
    expect(rig.deliveries()).toHaveLength(0);   // nothing was approved on the way through
    expect(rec.events.some(e => e.type === 'fast_llm_fell_back')).toBe(true);
  });

  it('falls back on a malformed verdict, recording what the attempt cost', async () => {
    const failed = new FastClassifierError('verdict is not usable JSON', fastResult('green').telemetry);
    const rig = buildTestOrchestrator(tmp, new FakeEngine([JSON.stringify(assessment('green'))]), {
      exported: ambiguous(), fastClassifier: new StubFast(failed),
    });
    const rec = await rig.orch.supervise(SESSION_ID);

    const ev = rec.events.find(e => e.type === 'fast_llm_fell_back');
    expect(ev?.error).toContain('not usable JSON');
    expect(ev?.cache_read_input_tokens).toBe(11089);
    expect(rec.state).toBe(SupervisionState.GREEN_COMPLETED); // the slow tier's green, not the fast one's
  });

  it('leaves the two existing tiers exactly as they were when it is off', async () => {
    const engine = new FakeEngine([JSON.stringify(assessment('yellow'))]);
    const rig = buildTestOrchestrator(tmp, engine, { exported: ambiguous() }); // no fastClassifier
    const rec = await rig.orch.supervise(SESSION_ID);

    expect(engine.callCount).toBe(1);
    expect(rec.state).toBe(SupervisionState.YELLOW_DELIVERED);
    expect(rec.events.some(e => e.type === 'tier_fast_llm')).toBe(false);
  });
});
