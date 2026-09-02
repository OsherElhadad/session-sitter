import { describe, it, expect } from 'vitest';
import type { Decision } from '../../cli/audit';
import { renderJson, renderText, run, summarise } from '../../cli/digest';
import { fakeIo } from './fakeIo';

const NOW = new Date(2026, 8, 1, 9, 0, 0); // local, so the rendered stamps are predictable
const SINCE = new Date(2026, 7, 31, 18, 0, 0);

function decision(over: Partial<Decision> = {}): Decision {
  return {
    from: 'audit',
    id: 'x',
    at: new Date(2026, 7, 31, 21, 0, 0),
    sessionId: 's-1',
    sessionName: 'nightly bump',
    host: 'buildbox',
    agent: 'claude',
    tool: 'Bash',
    light: 'green',
    outcome: 'allow',
    actor: 'rule',
    clauseId: '',
    clauseText: '',
    rewritten: false,
    reason: '',
    ask: '',
    latencyMs: null,
    costUsd: null,
    ...over,
  };
}

describe('summarise', () => {
  it('counts each lane separately, per session', () => {
    const [page] = summarise([
      decision({ id: '1' }),
      decision({ id: '2', outcome: 'correct' }),
      decision({ id: '3', outcome: 'deny' }),
      decision({ id: '4', outcome: 'timeout' }),
      decision({ id: '5', outcome: 'escalate' }),
      decision({ id: '6', outcome: 'resolved' }),
    ]);
    expect(page).toMatchObject({
      sessionId: 's-1', decisions: 6, corrected: 1, denied: 2, escalated: 2,
    });
  });

  it('takes the ask from the FIRST record that carries one', () => {
    // A session is asked something once; later records restate it as the agent understood it by then.
    const [page] = summarise([
      decision({ id: '1', at: new Date(2026, 7, 31, 20, 0, 0), ask: '' }),
      decision({ id: '2', at: new Date(2026, 7, 31, 21, 0, 0), ask: 'bump the deps' }),
      decision({ id: '3', at: new Date(2026, 7, 31, 22, 0, 0), ask: 'also fix the lint' }),
    ]);
    expect(page.ask).toBe('bump the deps');
  });

  it('leaves the ask empty rather than guessing at one', () => {
    expect(summarise([decision()])[0].ask).toBe('');
  });

  it('sums a recorded cost, and reports null when nothing recorded one', () => {
    // Null is a different fact from zero, and the renderer says "not recorded" for it.
    expect(summarise([decision({ costUsd: 0.001 }), decision({ costUsd: 0.002 })])[0].costUsd)
      .toBeCloseTo(0.003);
    expect(summarise([decision(), decision()])[0].costUsd).toBeNull();
    // One record with a real zero is still a recorded cost.
    expect(summarise([decision({ costUsd: 0 })])[0].costUsd).toBe(0);
  });

  it('tallies clauses, most-cited first', () => {
    const [page] = summarise([
      decision({ clauseId: 'practices§9', clauseText: 'ci needs a human' }),
      decision({ clauseId: 'practices§9', clauseText: 'ci needs a human' }),
      decision({ clauseId: 'practices§4', clauseText: 'no force-push' }),
    ]);
    expect(page.clauses).toEqual([
      { clause: 'practices§9: ci needs a human', count: 2 },
      { clause: 'practices§4: no force-push', count: 1 },
    ]);
  });

  it('records no clauses for decisions that cited none', () => {
    expect(summarise([decision()])[0].clauses).toEqual([]);
  });

  it('reports the window each session actually spanned', () => {
    const [page] = summarise([
      decision({ at: new Date(2026, 7, 31, 23, 0, 0) }),
      decision({ at: new Date(2026, 7, 31, 20, 0, 0) }),
    ]);
    expect(page.firstAt).toEqual(new Date(2026, 7, 31, 20, 0, 0));
    expect(page.lastAt).toEqual(new Date(2026, 7, 31, 23, 0, 0));
  });

  it('puts the busiest session first — the one to check on a morning read', () => {
    const pages = summarise([
      decision({ sessionId: 'quiet' }),
      decision({ sessionId: 'busy' }),
      decision({ sessionId: 'busy', id: '2' }),
    ]);
    expect(pages.map(p => p.sessionId)).toEqual(['busy', 'quiet']);
  });

  it('falls back to the session id when no record named the session', () => {
    expect(summarise([decision({ sessionName: '' })])[0].sessionName).toBe('s-1');
  });
});

describe('renderText', () => {
  const pages = summarise([
    decision({ ask: 'bump the deps', costUsd: 0.0012, clauseId: 'practices§4', clauseText: 'no force-push' }),
    decision({ id: '2', sessionId: 's-2', sessionName: 'triage', outcome: 'deny', agent: 'codex' }),
  ]);

  it('lays out one aligned page per session', () => {
    const out = renderText(pages, SINCE, fakeIo({ now: NOW }));
    expect(out).toContain('nightly bump');
    expect(out).toContain('triage');
    expect(out).toContain('decisions 1');
    expect(out).toContain('asked     bump the deps');
    expect(out).toContain('$0.0012');
  });

  it('says "not recorded" for an absent cost and an absent ask — never a zero', () => {
    const out = renderText(pages, SINCE, fakeIo({ now: NOW }));
    expect(out).toContain('not recorded');
    expect(out).not.toContain('$0.0000');
    expect(out).not.toContain('undefined');
  });

  it('says "none cited" rather than leaving the clause line blank', () => {
    const out = renderText(summarise([decision()]), SINCE, fakeIo({ now: NOW }));
    expect(out).toContain('none cited');
  });

  it('names the window and says plainly when nothing happened in it', () => {
    const out = renderText([], SINCE, fakeIo({ now: NOW }));
    expect(out).toContain('08-31 18:00 → 09-01 09:00');
    expect(out).toContain('Nothing was decided in this window.');
  });

  it('emits no escapes into a pipe', () => {
    // eslint-disable-next-line no-control-regex
    expect(renderText(pages, SINCE, fakeIo({ now: NOW }))).not.toMatch(/\[/);
  });

  it('paints on a terminal', () => {
    // eslint-disable-next-line no-control-regex
    expect(renderText(pages, SINCE, fakeIo({ now: NOW, isTty: true }))).toMatch(/\[[0-9;]*m/);
  });
});

describe('renderJson', () => {
  it('matches the documented version 1 contract', () => {
    const pages = summarise([decision({ costUsd: 0.5, outcome: 'deny' })]);
    const json = renderJson(pages, SINCE, NOW, '/state', true);
    expect(json.version).toBe(1);
    expect(json.window).toEqual({ since: SINCE.toISOString(), until: NOW.toISOString() });
    expect(json.stateDir).toBe('/state');
    expect(json.populated).toBe(true);
    expect(json.totals).toEqual({
      sessions: 1, decisions: 1, corrected: 0, escalated: 0, denied: 1, costUsd: 0.5,
    });
    expect(json.sessions[0].firstAt).toBe(pages[0].firstAt.toISOString());
  });

  it('totals a cost as null when no session recorded one', () => {
    const json = renderJson(summarise([decision()]), SINCE, NOW, '/state', true);
    expect(json.totals.costUsd).toBeNull();
    expect(json.sessions[0].costUsd).toBeNull();
  });

  it('is a valid, empty report when nothing was decided', () => {
    const json = renderJson([], SINCE, NOW, '/state', false);
    expect(json.totals).toEqual({
      sessions: 0, decisions: 0, corrected: 0, escalated: 0, denied: 0, costUsd: null,
    });
    expect(json.sessions).toEqual([]);
  });
});

describe('run', () => {
  const read = async (): Promise<Decision[]> => [
    decision({ id: 'in-window', at: new Date(2026, 7, 31, 20, 0, 0) }),
    decision({ id: 'too-early', at: new Date(2026, 7, 30, 9, 0, 0), sessionId: 's-old' }),
  ];

  it('defaults the window to 18:00 yesterday', async () => {
    const io = fakeIo({ now: NOW });
    expect(await run(['--json'], io, read)).toBe(0);
    const json = JSON.parse(io.text());
    expect(json.window.since).toBe(new Date(2026, 7, 31, 18, 0, 0).toISOString());
    expect(json.totals.decisions).toBe(1);
  });

  it('honours an explicit --since', async () => {
    const io = fakeIo({ now: NOW });
    await run(['--since', '3d', '--json'], io, read);
    expect(JSON.parse(io.text()).totals.decisions).toBe(2);
  });

  it('honours --session', async () => {
    const io = fakeIo({ now: NOW });
    await run(['--since', '3d', '--session', 's-old', '--json'], io, read);
    expect(JSON.parse(io.text()).totals.sessions).toBe(1);
  });

  it('prints help and rejects a positional', async () => {
    const io = fakeIo({ now: NOW });
    expect(await run(['-h'], io, read)).toBe(0);
    expect(io.text()).toContain('session-sitter digest');
    await expect(run(['yesterday'], io, read)).rejects.toThrow(/takes no arguments/);
  });
});
