import { describe, it, expect } from 'vitest';
import { recordToItem, ruleLabelFor } from '../SupervisionActivity';

// recordToItem maps a supervisor record JSON into the compact feed item the webview renders.
// The `error` field is what makes a failed card debuggable, so its two sources — the record's
// top-level `error` and the last `failed` event — are covered explicitly.
describe('recordToItem', () => {
  const MTIME = 1_700_000_000_000;

  it('carries the top-level error for a failed record', () => {
    const raw = JSON.stringify({
      request_id: 'req-abc123',
      session_id: 's1',
      state: 'failed',
      error: 'classify: failed to launch claude: [Errno 7] Argument list too long',
      events: [{ type: 'failed', at: '2026-07-22T06:53:04Z', error: 'from-event' }],
    });
    const item = recordToItem(raw, MTIME);
    expect(item?.state).toBe('failed');
    // Top-level error wins over the event copy.
    expect(item?.error).toContain('Argument list too long');
  });

  it('falls back to the last failed event error when no top-level error', () => {
    const raw = JSON.stringify({
      request_id: 'req-def456',
      state: 'failed',
      events: [
        { type: 'question_asked', at: '2026-07-22T06:50:00Z' },
        { type: 'failed', at: '2026-07-22T06:53:04Z', error: 'classify: bob produced no output' },
      ],
    });
    const item = recordToItem(raw, MTIME);
    expect(item?.error).toBe('classify: bob produced no output');
  });

  it('leaves error null for a non-failed record', () => {
    const raw = JSON.stringify({
      request_id: 'req-ghi789',
      state: 'green_completed',
      assessment: { traffic_light: 'green', summary: 'safe read-only fetch' },
      events: [{ type: 'green_approved', at: '2026-07-22T06:40:00Z' }],
    });
    const item = recordToItem(raw, MTIME);
    expect(item?.light).toBe('green');
    expect(item?.error).toBeNull();
  });

  it('returns null for malformed JSON or a record without a request_id', () => {
    expect(recordToItem('{not json', MTIME)).toBeNull();
    expect(recordToItem(JSON.stringify({ state: 'failed' }), MTIME)).toBeNull();
  });
});

// A decision taken by a deterministic auto-respond rule is a real intervention, so the feed shows
// it alongside the supervisor's — tagged so the user can tell which tier decided.
describe('ruleLabelFor', () => {
  it('renders an approval rule as pattern then decision', () => {
    expect(ruleLabelFor({
      kind: 'approval', pattern: 'read_*|glob', decision: 'approveForTask',
    })).toBe("'read_*|glob' → approveForTask");
  });

  it('includes the argument pattern when the rule narrowed on it', () => {
    expect(ruleLabelFor({
      kind: 'approval', pattern: 'execute_command', argument_pattern: 'npm test',
      decision: 'approveOnce',
    })).toBe("'execute_command' + args /npm test/ → approveOnce");
  });

  it('renders a text rule as a regex then auto-reply', () => {
    expect(ruleLabelFor({ kind: 'text', pattern: 'continue\\?', response: 'yes' }))
      .toBe('/continue\\?/ → auto-reply');
  });

  it('is empty for a record no rule decided', () => {
    expect(ruleLabelFor(null)).toBe('');
    expect(ruleLabelFor(undefined)).toBe('');
    expect(ruleLabelFor({ kind: 'approval' })).toBe(''); // no pattern, nothing to show
  });
});

describe('recordToItem: rule decisions', () => {
  const MTIME = 1_700_000_000_000;

  it('carries decided_by and a rule label', () => {
    const raw = JSON.stringify({
      request_id: 'req-rule01',
      session_id: 'task-9',
      state: 'rule_applied',
      decided_by: 'rule',
      rule: { kind: 'approval', pattern: 'read_*', decision: 'approveOnce' },
      assessment: { traffic_light: 'green', summary: 'Rule auto-approved: read_file.' },
      events: [{ type: 'rule_applied', at: '2026-08-30T10:00:00Z' }],
    });
    const item = recordToItem(raw, MTIME);
    expect(item?.state).toBe('rule_applied');
    expect(item?.decidedBy).toBe('rule');
    expect(item?.light).toBe('green');
    expect(item?.ruleLabel).toBe("'read_*' → approveOnce");
  });

  it('defaults decided_by to supervisor for a record written before that field existed', () => {
    const raw = JSON.stringify({
      request_id: 'req-old01', state: 'green_completed',
      assessment: { traffic_light: 'green' },
    });
    const item = recordToItem(raw, MTIME);
    expect(item?.decidedBy).toBe('supervisor');
    expect(item?.ruleLabel).toBe('');
  });
});
