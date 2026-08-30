import { describe, it, expect } from 'vitest';
import { recordToItem } from '../SupervisionActivity';

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
