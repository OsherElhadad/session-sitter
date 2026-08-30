/**
 * Strict validation of classifier output, and the two recovery paths that keep a flaky model
 * from stranding a blocked agent.
 *
 * Ports `supervisor/tests/test_schema.py`.
 */

import { describe, it, expect } from 'vitest';
import {
  SchemaError,
  extractJsonObject,
  iterTopLevelObjects,
  parseAndValidate,
  salvageAssessmentFromText,
  unclassifiedOrangeAssessment,
  validate,
} from '../../supervisor/schema';
import { assessment } from './fixtures';

describe('validate: required shape', () => {
  it('accepts a complete green assessment', () => {
    const a = validate(assessment('green'));
    expect(a.traffic_light).toBe('green');
    expect(a.confidence).toBe(0.85);
    expect(a.issues).toEqual([]);
  });

  it.each([
    'traffic_light', 'confidence', 'summary', 'agent_intent', 'user_intent',
    'waiting_reason', 'issues', 'recommended_action',
  ])('rejects output missing %s', (field) => {
    const a = assessment('green');
    delete a[field];
    expect(() => validate(a)).toThrow(new RegExp(`missing required field: ${field}`));
  });

  it('rejects a non-object', () => {
    expect(() => validate('nope')).toThrow(SchemaError);
    expect(() => validate([assessment('green')])).toThrow(/must be a JSON object/);
  });

  it('rejects an unsupported traffic light', () => {
    expect(() => validate(assessment('purple'))).toThrow(/unsupported traffic_light/);
  });

  it('rejects a non-numeric confidence, booleans included', () => {
    expect(() => validate(assessment('green', { confidence: 'high' }))).toThrow(/must be a number/);
    expect(() => validate(assessment('green', { confidence: true }))).toThrow(/must be a number/);
  });

  it('rejects a confidence outside [0, 1]', () => {
    expect(() => validate(assessment('green', { confidence: 1.5 }))).toThrow(/\[0\.0, 1\.0\]/);
    expect(() => validate(assessment('green', { confidence: -0.1 }))).toThrow(/\[0\.0, 1\.0\]/);
  });

  it('accepts the boundary confidences', () => {
    expect(validate(assessment('green', { confidence: 0 })).confidence).toBe(0);
    expect(validate(assessment('green', { confidence: 1 })).confidence).toBe(1);
  });

  it('rejects a non-string in a string field', () => {
    expect(() => validate(assessment('green', { summary: 42 }))).toThrow(/summary must be a string/);
  });

  it('rejects wrongly-typed optional fields', () => {
    expect(() => validate(assessment('green', { blocked_actions: 'x' })))
      .toThrow(/blocked_actions must be a list/);
    expect(() => validate(assessment('green', { blocked_actions: [1] })))
      .toThrow(/blocked_actions\[0\] must be a string/);
    expect(() => validate(assessment('green', { should_block_agent: 'yes' })))
      .toThrow(/should_block_agent must be a boolean/);
    expect(() => validate(assessment('green', { human_notification: 5 })))
      .toThrow(/human_notification must be a string or null/);
  });
});

describe('validate: issues', () => {
  const issue = (overrides: Record<string, unknown> = {}) => ({
    description: 'Pushing to main bypasses review',
    severity: 'high',
    reasoning: 'The team convention requires a PR',
    evidence_from_session: [{ reference: 'turn 1', description: 'proposed git push' }],
    relevant_knowledge: [{ scope: 'team', entry: 'team-b1', confidence: 0.9 }],
    ...overrides,
  });

  it('accepts a fully-populated issue', () => {
    const a = validate(assessment('green', { issues: [issue()] }));
    expect(a.issues[0].evidence_from_session[0].reference).toBe('turn 1');
    expect(a.issues[0].relevant_knowledge[0].scope).toBe('team');
  });

  it('rejects a malformed issue', () => {
    expect(() => validate(assessment('green', { issues: ['x'] })))
      .toThrow(/issues\[0\] must be an object/);
    const noSeverity = issue();
    delete (noSeverity as Record<string, unknown>).severity;
    expect(() => validate(assessment('green', { issues: [noSeverity] })))
      .toThrow(/issues\[0\] missing severity/);
    expect(() => validate(assessment('green', { issues: [issue({ severity: 3 })] })))
      .toThrow(/issues\[0\].severity must be a string/);
    expect(() => validate(assessment('green', { issues: [issue({ evidence_from_session: 'x' })] })))
      .toThrow(/evidence_from_session must be a list/);
  });

  it('tolerates an off-enum severity or scope', () => {
    // Both are DESCRIPTIVE metadata for humans and audit, not control flow. A good decision must
    // never be discarded over a label the model got slightly wrong.
    const a = validate(assessment('green', {
      issues: [issue({ severity: 'catastrophic', relevant_knowledge: [{ scope: 'org', entry: 'x' }] })],
    }));
    expect(a.issues[0].severity).toBe('catastrophic');
  });
});

describe('validate: per-light intervention fields', () => {
  it('requires a supervisor message for yellow', () => {
    expect(() => validate(assessment('yellow', { supervisor_message_to_agent: null })))
      .toThrow(/yellow requires a non-empty supervisor_message_to_agent/);
    expect(() => validate(assessment('yellow', { supervisor_message_to_agent: '   ' })))
      .toThrow(/yellow requires a non-empty/);
  });

  it('requires a human notification, a blocked action, and an allowed list for orange', () => {
    expect(() => validate(assessment('orange', { human_notification: null })))
      .toThrow(/orange requires a non-empty human_notification/);
    expect(() => validate(assessment('orange', { blocked_actions: [] })))
      .toThrow(/orange requires at least one blocked_action/);
    const noAllowed = assessment('orange');
    delete noAllowed.allowed_actions_while_waiting;
    expect(() => validate(noAllowed)).toThrow(/orange requires allowed_actions_while_waiting/);
  });

  it('accepts an empty allowed list for orange', () => {
    expect(validate(assessment('orange', { allowed_actions_while_waiting: [] })).traffic_light)
      .toBe('orange');
  });

  it('requires a hard block and a human notification for red', () => {
    expect(() => validate(assessment('red', { should_block_agent: false })))
      .toThrow(/red requires should_block_agent=true/);
    expect(() => validate(assessment('red', { human_notification: null })))
      .toThrow(/red requires a non-empty human_notification/);
  });

  it('leaves green free of intervention fields', () => {
    const a = validate(assessment('green'));
    expect(a.supervisor_message_to_agent).toBeNull();
    expect(a.human_notification).toBeNull();
    expect(a.blocked_actions).toEqual([]);
  });
});

describe('validate: the Orange to Yellow fallback shape', () => {
  const fallback = (overrides: Record<string, unknown> = {}) => assessment('yellow', {
    transitioned_from: 'orange',
    transition_reason: 'user_response_timeout',
    supervisor_message_to_agent: 'Hold the push; prepare a PR draft instead.',
    ...overrides,
  });

  it('accepts a well-formed fallback', () => {
    const a = validate(fallback());
    expect(a.transitioned_from).toBe('orange');
    expect(a.transition_reason).toBe('user_response_timeout');
  });

  it('rejects a transition from anything but orange', () => {
    expect(() => validate(fallback({ transitioned_from: 'red' })))
      .toThrow(/transitioned_from must be 'orange'/);
  });

  it('rejects a fallback that is not yellow', () => {
    expect(() => validate(assessment('orange', {
      transitioned_from: 'orange', transition_reason: 'x',
      supervisor_message_to_agent: 'y',
    }))).toThrow(/must have traffic_light=yellow/);
  });

  it('requires a transition reason and a message', () => {
    expect(() => validate(fallback({ transition_reason: null })))
      .toThrow(/transition_reason is required/);
    // The yellow rule catches an empty message first; either way it never passes.
    expect(() => validate(fallback({ supervisor_message_to_agent: '' })))
      .toThrow(/non-empty supervisor_message_to_agent/);
  });
});

describe('extractJsonObject', () => {
  it('returns a bare object unchanged', () => {
    expect(JSON.parse(extractJsonObject('{"traffic_light":"green"}')).traffic_light).toBe('green');
  });

  it('strips a markdown fence', () => {
    const raw = '```json\n{"traffic_light":"yellow"}\n```';
    expect(JSON.parse(extractJsonObject(raw)).traffic_light).toBe('yellow');
  });

  it('skips prose before and after the object', () => {
    const raw = 'Here is my assessment:\n{"traffic_light":"red"}\nHope that helps!';
    expect(JSON.parse(extractJsonObject(raw)).traffic_light).toBe('red');
  });

  it('picks the assessment out of several top-level objects', () => {
    // Bob's `--output-format json` prints the assistant message, then a stats object.
    const raw = '{"note":"thinking"}\n{"traffic_light":"green"}\n{"usage":{"tokens":9}}';
    expect(JSON.parse(extractJsonObject(raw)).traffic_light).toBe('green');
  });

  it('ignores braces inside strings', () => {
    const raw = '{"traffic_light":"green","summary":"weird } brace {"}';
    expect(JSON.parse(extractJsonObject(raw)).summary).toBe('weird } brace {');
  });

  it('throws on empty or object-free output', () => {
    expect(() => extractJsonObject('')).toThrow(/no JSON object found/);
    expect(() => extractJsonObject(null)).toThrow(/output is empty/);
    expect(() => extractJsonObject('just prose')).toThrow(/no JSON object found/);
  });

  it('returns the first balanced object when none looks like an assessment', () => {
    // So the resulting validation error names a real missing field instead of "no JSON".
    expect(extractJsonObject('{"a":1}{"b":2}')).toBe('{"a":1}');
  });
});

describe('iterTopLevelObjects', () => {
  it('finds each balanced object and stops at an unterminated one', () => {
    expect(iterTopLevelObjects('{"a":{"b":1}} {"c":2}')).toEqual(['{"a":{"b":1}}', '{"c":2}']);
    expect(iterTopLevelObjects('{"a":1} {"b":')).toEqual(['{"a":1}']);
  });

  it('handles escaped quotes', () => {
    expect(iterTopLevelObjects('{"a":"x\\"}"}')).toEqual(['{"a":"x\\"}"}']);
  });
});

describe('parseAndValidate', () => {
  it('parses and validates in one step', () => {
    expect(parseAndValidate(JSON.stringify(assessment('green'))).traffic_light).toBe('green');
  });

  it('reports invalid JSON as a schema error', () => {
    expect(() => parseAndValidate('{not json}')).toThrow(SchemaError);
  });
});

describe('salvageAssessmentFromText', () => {
  it('recovers the light from "X light" phrasing', () => {
    const a = salvageAssessmentFromText('This is a yellow light: prefer a PR.', 'git push');
    expect(a?.traffic_light).toBe('yellow');
    expect(a?.supervisor_message_to_agent).toContain('prefer a PR');
    // The salvaged shape must itself be valid, or the recovery is worthless.
    expect(validate(a!).traffic_light).toBe('yellow');
  });

  it('recovers the light from "classified as X" phrasing', () => {
    const a = salvageAssessmentFromText('I classified this as orange because it needs your call.');
    expect(a?.traffic_light).toBe('orange');
    expect(a?.blocked_actions).toHaveLength(1);
    expect(a?.should_block_original_action).toBe(true);
    expect(validate(a!).traffic_light).toBe('orange');
  });

  it('falls back to the most severe light word present', () => {
    const a = salvageAssessmentFromText('Not green, and not merely yellow — this is red.');
    expect(a?.traffic_light).toBe('red');
    expect(a?.should_block_agent).toBe(true);
    expect(validate(a!).traffic_light).toBe('red');
  });

  it('returns null when no light can be found', () => {
    expect(salvageAssessmentFromText('I could not decide.')).toBeNull();
    expect(salvageAssessmentFromText('')).toBeNull();
  });

  it('refuses to salvage structured output', () => {
    // A structured-but-invalid assessment must fail loudly, not be silently patched.
    expect(salvageAssessmentFromText('{"traffic_light":"green"}')).toBeNull();
  });
});

describe('unclassifiedOrangeAssessment', () => {
  it('escalates to the human with a valid, blocking assessment', () => {
    const a = unclassifiedOrangeAssessment('execute_command: rm x', 'garbage output');
    const validated = validate(a);
    expect(validated.traffic_light).toBe('orange');
    expect(validated.should_block_original_action).toBe(true);
    expect(validated.blocked_actions).toEqual(['execute_command: rm x']);
    expect(validated.human_options).toEqual(['Approve', 'Reject']);
    expect(validated.human_notification).toContain('garbage output');
  });

  it('works without any raw text', () => {
    expect(validate(unclassifiedOrangeAssessment('an action')).traffic_light).toBe('orange');
  });
});
