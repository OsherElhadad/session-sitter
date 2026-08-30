/**
 * Deterministic rule decisions must be as visible as the supervisor's: a record on disk (what the
 * panel's activity feed reads) plus a one-way update on the human channel.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  RuleDecisionRecorder,
  ruleActionLabel,
  ruleAssessment,
  ruleLight,
  ruleOutcomeLabel,
  ruleTrace,
  type RuleDecision,
} from '../../supervisor/ruleDecisions';
import { FakeChannel } from '../../supervisor/messaging';
import { StateStore } from '../../supervisor/store';
import { SupervisionState } from '../../supervisor/models';
import { makeTmpDir } from './fixtures';

let tmp: string;
let store: StateStore;

beforeEach(() => {
  tmp = makeTmpDir('rule-decisions-');
  store = new StateStore(path.join(tmp, 'records'));
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const approval = (overrides: Partial<RuleDecision> = {}): RuleDecision => ({
  sessionId: 'task-1',
  source: 'bob',
  kind: 'approval',
  pattern: 'read_*|glob',
  decision: 'approveOnce',
  toolName: 'read_file',
  argsText: '{"path":"src/app.ts"}',
  requestId: 'r1',
  ...overrides,
});

function recorder(channel: FakeChannel, notifyRuleDecisions = true): RuleDecisionRecorder {
  return new RuleDecisionRecorder({
    store, channel, config: { notifyRuleDecisions },
  });
}

describe('ruleLight', () => {
  it('maps an approve to green, a reject to red, and a canned reply to yellow', () => {
    expect(ruleLight(approval({ decision: 'approveOnce' }))).toBe('green');
    expect(ruleLight(approval({ decision: 'approveForTask' }))).toBe('green');
    expect(ruleLight(approval({ decision: 'reject' }))).toBe('red');
    expect(ruleLight({
      sessionId: 's', source: 'bob', kind: 'text', pattern: 'continue', response: 'yes',
    })).toBe('yellow');
  });
});

describe('labels', () => {
  it('names the outcome in plain words', () => {
    expect(ruleOutcomeLabel(approval())).toBe('auto-approved');
    expect(ruleOutcomeLabel(approval({ decision: 'reject' }))).toBe('auto-rejected');
    expect(ruleOutcomeLabel(approval({ decision: 'approveForTask' })))
      .toContain('for the rest of the task');
  });

  it('shows the tool with its arguments for an approval', () => {
    expect(ruleActionLabel(approval())).toBe('read_file({"path":"src/app.ts"})');
  });

  it('drops empty arguments rather than rendering `tool({})`', () => {
    expect(ruleActionLabel(approval({ argsText: '{}' }))).toBe('read_file');
  });

  it('shows the sent text for a text rule', () => {
    expect(ruleActionLabel({
      sessionId: 's', source: 'bob', kind: 'text', pattern: 'continue', response: 'yes',
    })).toBe('reply: yes');
  });

  it('truncates a very long argument blob', () => {
    const label = ruleActionLabel(approval({ argsText: 'x'.repeat(500) }));
    expect(label.length).toBeLessThan(200);
    expect(label.endsWith('…)')).toBe(true);
  });
});

describe('ruleAssessment', () => {
  it('is schema-shaped, deterministic, and names the rule that fired', () => {
    const a = ruleAssessment(approval({ argumentPattern: 'src/' }));
    expect(a.traffic_light).toBe('green');
    expect(a.confidence).toBe(1.0);
    expect(String(a.summary)).toContain('auto-approved');
    expect(String(a.recommended_action)).toContain("'read_*|glob'");
    expect(String(a.recommended_action)).toContain('/src//');
    // The notification points the user at the setting that caused it.
    expect(String(a.human_notification)).toContain('sessionSitter.autoRespond');
    expect(a.human_options).toEqual([]);      // never a decision card — the decision is made
    expect(a.should_block_agent).toBe(false);
  });

  it('marks a rejected action as blocked', () => {
    const a = ruleAssessment(approval({ decision: 'reject' }));
    expect(a.traffic_light).toBe('red');
    expect(a.should_block_original_action).toBe(true);
    expect(a.blocked_actions).toEqual(['read_file({"path":"src/app.ts"})']);
  });
});

describe('ruleTrace', () => {
  it('persists the rule in snake_case with nulls for the absent halves', () => {
    expect(ruleTrace(approval())).toEqual({
      kind: 'approval',
      pattern: 'read_*|glob',
      argument_pattern: null,
      decision: 'approveOnce',
      response: null,
      tool_name: 'read_file',
    });
  });
});

describe('RuleDecisionRecorder', () => {
  it('writes a record the activity feed can read, tagged as rule-decided', async () => {
    const channel = new FakeChannel();
    const record = await recorder(channel).report(approval());
    expect(record?.state).toBe(SupervisionState.RULE_APPLIED);
    expect(record?.decided_by).toBe('rule');
    expect(record?.rule?.pattern).toBe('read_*|glob');
    expect(record?.session_id).toBe('task-1');
    expect(record?.pending_request_id).toBe('r1');
    expect(record?.events.some(e => e.type === 'rule_applied')).toBe(true);

    // On disk, at the path the panel polls.
    const files = fs.readdirSync(path.join(tmp, 'records')).filter(f => f.startsWith('req-'));
    expect(files).toHaveLength(1);
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'records', files[0]), 'utf8'));
    expect(onDisk.decided_by).toBe('rule');
    expect(onDisk.assessment.traffic_light).toBe('green');
  });

  it('sends a ONE-WAY update — never an interactive decision card', async () => {
    const channel = new FakeChannel();
    const record = await recorder(channel).report(approval());
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0].interactive).toBe(false);
    expect(channel.sent[0].notification).toContain('auto-approved');
    expect(record?.notification_id).toBe('fake-1');
    expect(record?.notified_at).toBeTruthy();
  });

  it('still records but does not notify when notifyRuleDecisions is off', async () => {
    const channel = new FakeChannel();
    const record = await recorder(channel, false).report(approval());
    expect(record?.state).toBe(SupervisionState.RULE_APPLIED);
    expect(channel.sent).toHaveLength(0);
  });

  it('keeps the record when the notification fails, and says why', async () => {
    const channel = new FakeChannel(true); // every send throws DeliveryError
    const logs: string[] = [];
    const rec = new RuleDecisionRecorder({
      store, channel, config: { notifyRuleDecisions: true }, log: m => logs.push(m),
    });
    const record = await rec.report(approval());
    expect(record?.state).toBe(SupervisionState.RULE_APPLIED);
    expect(record?.events.some(e => e.type === 'rule_notify_failed')).toBe(true);
    expect(logs.join('\n')).toContain('notify failed');
    // A delivery failure is a DeliveryError, not a bug — no unexpected-error log line.
    expect(logs.join('\n')).not.toContain('unexpected notify error');
    expect(channel.sent).toHaveLength(0);
  });

  it('reports the same requestId only once', async () => {
    const channel = new FakeChannel();
    const rec = recorder(channel);
    expect(await rec.report(approval())).toBeDefined();
    expect(await rec.report(approval())).toBeUndefined();
    expect(channel.sent).toHaveLength(1);
  });

  it('dedupes a text rule by session + pattern + response (it has no requestId)', async () => {
    const channel = new FakeChannel();
    const rec = recorder(channel);
    const text: RuleDecision = {
      sessionId: 's1', source: 'claude', kind: 'text', pattern: 'continue\\?', response: 'yes',
    };
    expect(await rec.report(text)).toBeDefined();
    expect(await rec.report(text)).toBeUndefined();
    // A different reply on the same session is a new decision.
    expect(await rec.report({ ...text, response: 'no' })).toBeDefined();
    expect(channel.sent).toHaveLength(2);
  });

  it('never throws when the record cannot be written', async () => {
    const broken = new StateStore(path.join(tmp, 'records'));
    // Make the write fail by replacing the records dir with a file.
    fs.rmSync(path.join(tmp, 'records'), { recursive: true, force: true });
    fs.writeFileSync(path.join(tmp, 'records'), 'not a directory', 'utf8');
    const logs: string[] = [];
    const channel = new FakeChannel();
    const rec = new RuleDecisionRecorder({
      store: broken, channel, config: { notifyRuleDecisions: true }, log: m => logs.push(m),
    });
    expect(await rec.report(approval())).toBeUndefined();
    expect(logs.join('\n')).toContain('failed to record');
    expect(channel.sent).toHaveLength(0);
  });
});
