import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { explainCall } from '../../policy/explain';

// Step 10 of the terminal walkthrough compares every call the run made against what `policy explain`
// says about it. Seven of nine agreed exactly. The two that did not were the calls a human answered
// at rung 7: the hook recorded `allow (human)`, `explain` said `deny (rung 7)`.
//
// `explain` is right to say deny — it must never ask a human (a hypothetical cannot hold a prompt
// open) and silence denies. What it did not do is say that escalation was configured, so its note read
// as a flat refusal for a call that, in a live session, would have been put to a person. That is the
// same class of quiet mismatch the module's own `--rev` branch refuses: an explain that describes a
// different world from the enforcement path without saying which world it described.
//
// `would` deliberately stays `deny`. Escalation adds a way for someone to say yes; it never changes
// what silence does, and an explain cannot know whether anyone will answer.
describe('explain names escalation when it is configured', () => {
  let dir: string;
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    saved = { ...process.env };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-explain-esc-'));
    process.env.SESSION_SITTER_DATA_DIR = dir;
    process.env.SESSION_SITTER_MODE = 'enforce';
    process.env.SESSION_SITTER_PRACTICES = path.join(dir, 'practices.md');
    fs.writeFileSync(process.env.SESSION_SITTER_PRACTICES, '# Bottom line\n', 'utf8');
    delete process.env.SESSION_SITTER_CLASSIFIER;
    delete process.env.SESSION_SITTER_USER;
  });

  afterEach(() => {
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const query = { tool: 'Bash', input: { command: 'echo hi > /tmp/x' } };

  it('says only "silence is not approval" when escalation is off', async () => {
    process.env.SESSION_SITTER_ESCALATE = 'off';
    const out = await explainCall(query);
    expect(out.would).toBe('deny');
    expect(out.rung).toBe(7);
    expect(out.note).toMatch(/silence is not approval/);
    // Nothing may promise a human when none would be asked.
    expect(out.note).not.toMatch(/human would be asked|escalat/i);
  });

  it('says a human would be asked first when escalation is on', async () => {
    process.env.SESSION_SITTER_ESCALATE = 'on';
    const out = await explainCall(query);
    // Still a deny: silence is never approval, and an explain cannot know if anyone answers.
    expect(out.would).toBe('deny');
    expect(out.rung).toBe(7);
    expect(out.note).toMatch(/escalat/i);
    expect(out.note).toMatch(/silence is not approval/);
  });
});
