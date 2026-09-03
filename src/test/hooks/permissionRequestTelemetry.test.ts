/**
 * Rung 6's cost, persisted.
 *
 * `FastTelemetry` — model, latency, and the four token counts prompt caching is judged on — was
 * measured on every classifier call and then dropped on the floor: nothing in `src/audit/trail.ts`
 * carried it, so the one number the pinning architecture exists to defend could not be read back.
 *
 * Two assertions, and the second is the load-bearing one:
 *
 *  - the model rung records the telemetry its engine reported;
 *  - a deterministic rung records `telemetry: null`, because rungs 1–5 call no model and therefore
 *    have no cache to hit. A null there is "no model ran", never "the cache missed" — any reader
 *    that averages a cache figure across all decisions reports a number nobody can interpret.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const telemetry = {
  tier: 'agent_cli' as const,
  model: 'aws/claude-opus-5',
  latency_ms: 1234,
  input_tokens: 87,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 11089,
  output_tokens: 42,
};

vi.mock('../../supervisor/factory', () => ({
  buildEngine: () => ({
    classify: async () => ({ invocationId: 'inv-test', raw: JSON.stringify(green), telemetry }),
  }),
}));

import { handle } from '../../hooks/permissionRequest';
import { assessment } from '../supervisor/fixtures';
import { DecisionRecord, readJsonl } from '../../audit/trail';
import { decisionsPath } from '../../hooks/paths';

const green = assessment('green');
const saved = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-tele-'));
  process.env.SESSION_SITTER_DATA_DIR = dir;
  process.env.SESSION_SITTER_CLASSIFIER = 'on';
  delete process.env.SESSION_SITTER_MODE;
  delete process.env.SESSION_SITTER_PRACTICES;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  process.env = { ...saved };
});

const req = (tool: string, input: Record<string, unknown>) => ({
  hook_event_name: 'PermissionRequest', session_id: 's1', cwd: '/tmp/ws',
  tool_name: tool, tool_input: input,
});

describe('DecisionRecord.telemetry', () => {
  it('persists what the classifier reported, on the rung that called it', async () => {
    await handle(req('Write', { file_path: '/tmp/a.ts', content: 'x' }));
    const [record] = readJsonl<DecisionRecord>(decisionsPath());
    expect(record.actor).toBe('model');
    expect(record.telemetry).toEqual(telemetry);
  });

  it('records null on a deterministic rung, because no model ran', async () => {
    await handle(req('Read', { file_path: '/tmp/a.ts' }));
    const [record] = readJsonl<DecisionRecord>(decisionsPath());
    expect(record.actor).toBe('deterministic');
    expect(record.telemetry).toBeNull();
  });
});
