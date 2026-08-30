import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// SupervisorOutbox → BobApprover → BobInspector imports 'vscode' at load; stub it.
vi.mock('vscode', () => ({ extensions: { getExtension: vi.fn() } }));
import { SupervisorOutbox, parseDelivery } from '../SupervisorOutbox';
import { BobSender } from '../agents/BobSender';
import { BobApprover, PendingApproval } from '../agents/BobApprover';

class FakeSender implements BobSender {
  sent: Array<{ taskId: string; text: string }> = [];
  failNext = false;
  async isAvailable(): Promise<boolean> { return true; }
  async send(taskId: string, text: string): Promise<void> {
    if (this.failNext) { this.failNext = false; throw new Error('send failed'); }
    this.sent.push({ taskId, text });
  }
}

class FakeApprover implements BobApprover {
  resolved: Array<{ requestId: string; payload: Record<string, unknown> }> = [];
  outcome = 'ok';
  async listAllPending(): Promise<PendingApproval[]> { return []; }
  async resolve(requestId: string, payload: Record<string, unknown>): Promise<string> {
    this.resolved.push({ requestId, payload });
    return this.outcome;
  }
}

function writeDelivery(dir: string, delivery: object): void {
  fs.mkdirSync(dir, { recursive: true });
  const d = delivery as { deliveryId: string };
  fs.writeFileSync(path.join(dir, `${d.deliveryId}.json`), JSON.stringify(delivery), 'utf8');
}

describe('parseDelivery', () => {
  it('parses a valid delivery', () => {
    const d = parseDelivery(JSON.stringify({ deliveryId: 'd1', sessionId: 's1', text: 'hi', kind: 'yellow_guidance' }));
    expect(d?.sessionId).toBe('s1');
  });
  it('rejects malformed / missing fields', () => {
    expect(parseDelivery('{bad')).toBeNull();
    expect(parseDelivery(JSON.stringify({ deliveryId: 'd1' }))).toBeNull();
  });
});

describe('SupervisorOutbox.poll', () => {
  let tmp: string;
  let outbox: string;
  let sender: FakeSender;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-'));
    outbox = path.join(tmp, 'outbox');
    sender = new FakeSender();
  });

  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('injects a delivery once and moves it to done/', async () => {
    writeDelivery(outbox, { deliveryId: 'd1', sessionId: 's1', source: 'bob', text: '[SessionSitter Supervisor] hold', kind: 'orange_hold' });
    const box = new SupervisorOutbox(outbox, sender);
    const n = await box.poll();
    expect(n).toBe(1);
    expect(sender.sent).toEqual([{ taskId: 's1', text: '[SessionSitter Supervisor] hold' }]);
    expect(fs.existsSync(path.join(outbox, 'd1.json'))).toBe(false);
    expect(fs.existsSync(path.join(outbox, 'done', 'd1.json'))).toBe(true);
  });

  it('does not re-inject a delivery already moved to done/', async () => {
    writeDelivery(outbox, { deliveryId: 'd1', sessionId: 's1', source: 'bob', text: 'x' });
    const box = new SupervisorOutbox(outbox, sender);
    await box.poll();
    await box.poll(); // second pass — file is in done/, not re-sent
    expect(sender.sent).toHaveLength(1);
  });

  it('leaves the file for retry when send fails', async () => {
    writeDelivery(outbox, { deliveryId: 'd1', sessionId: 's1', source: 'bob', text: 'x' });
    sender.failNext = true;
    const box = new SupervisorOutbox(outbox, sender);
    await box.poll();
    expect(fs.existsSync(path.join(outbox, 'd1.json'))).toBe(true); // still there
    const n = await box.poll(); // retry succeeds
    expect(n).toBe(1);
  });

  it('archives unknown-source deliveries without injecting', async () => {
    writeDelivery(outbox, { deliveryId: 'd1', sessionId: 's1', source: 'gemini', text: 'x' });
    const box = new SupervisorOutbox(outbox, sender);
    const n = await box.poll();
    expect(n).toBe(0);
    expect(sender.sent).toHaveLength(0);
    expect(fs.existsSync(path.join(outbox, 'done', 'd1.json'))).toBe(true);
  });

  it('applies a question-channel delivery via resolveQuestion', async () => {
    const resolveQuestion = vi.fn(async () => 'ok');
    const claudeApprover = { listAllPending: async () => [], resolve: async () => 'ok', resolveQuestion } as unknown as BobApprover;
    const claudeSender = new FakeSender();
    writeDelivery(outbox, {
      deliveryId: 'd1', sessionId: 'claude-active', source: 'claude', text: '(answers)',
      kind: 'answer_question', requestId: 'req-1', channel: 'question', answers: { Pick: ['A', 'B'] },
    });
    const box = new SupervisorOutbox(outbox, sender, () => {}, new FakeApprover(), undefined, claudeSender, claudeApprover);
    const n = await box.poll();
    expect(resolveQuestion).toHaveBeenCalledWith('req-1', { Pick: ['A', 'B'] });
    expect(n).toBe(1);
    expect(fs.existsSync(path.join(outbox, 'done', 'd1.json'))).toBe(true);
  });

  it('routes a claude message delivery to the claude sender', async () => {
    writeDelivery(outbox, { deliveryId: 'd1', sessionId: 's1', source: 'claude', text: 'hi claude' });
    const claudeSender = new FakeSender();
    const box = new SupervisorOutbox(outbox, sender, undefined, undefined, undefined, claudeSender);
    const n = await box.poll();
    expect(n).toBe(1);
    expect(sender.sent).toHaveLength(0);          // not the bob sender
    expect(claudeSender.sent).toHaveLength(1);
    expect(fs.existsSync(path.join(outbox, 'done', 'd1.json'))).toBe(true);
  });

  it('leaves a claude delivery for retry when no claude sender is wired', async () => {
    writeDelivery(outbox, { deliveryId: 'd1', sessionId: 's1', source: 'claude', text: 'x' });
    const box = new SupervisorOutbox(outbox, sender);
    const n = await box.poll();
    expect(n).toBe(0);
    expect(fs.existsSync(path.join(outbox, 'd1.json'))).toBe(true); // still pending, not archived
  });

  it('returns 0 when the outbox dir does not exist', async () => {
    const box = new SupervisorOutbox(path.join(tmp, 'nope'), sender);
    expect(await box.poll()).toBe(0);
  });
});

describe('SupervisorOutbox approval channel (requestId → emitter)', () => {
  let tmp: string;
  let outbox: string;
  let sender: FakeSender;
  let approver: FakeApprover;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-appr-'));
    outbox = path.join(tmp, 'outbox');
    sender = new FakeSender();
    approver = new FakeApprover();
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('routes a requestId delivery to approver.resolve(reject), not sender.send', async () => {
    writeDelivery(outbox, {
      deliveryId: 'd1', sessionId: 's1', source: 'bob', text: '[SessionSitter Supervisor] BLOCKED (red)',
      kind: 'reject_approval', requestId: 'req-1', channel: 'approval',
    });
    const box = new SupervisorOutbox(outbox, sender, () => { /* noop */ }, approver);
    const n = await box.poll();
    expect(n).toBe(1);
    expect(approver.resolved).toEqual([{ requestId: 'req-1', payload: { allowOnce: false } }]);
    expect(sender.sent).toHaveLength(0);
    expect(fs.existsSync(path.join(outbox, 'done', 'd1.json'))).toBe(true);
  });

  it('routes an approve_approval (decision=allow) delivery to approver.resolve(approveOnce)', async () => {
    writeDelivery(outbox, {
      deliveryId: 'd1', sessionId: 's1', source: 'bob', text: '[SessionSitter Supervisor] Approved by user',
      kind: 'approve_approval', requestId: 'req-1', channel: 'approval', decision: 'allow',
    });
    const box = new SupervisorOutbox(outbox, sender, () => { /* noop */ }, approver);
    expect(await box.poll()).toBe(1);
    expect(approver.resolved).toEqual([{ requestId: 'req-1', payload: { allowOnce: true } }]);
    expect(fs.existsSync(path.join(outbox, 'done', 'd1.json'))).toBe(true);
  });

  it('defaults an approval delivery with no decision to reject', async () => {
    writeDelivery(outbox, {
      deliveryId: 'd1', sessionId: 's1', source: 'bob', text: 'x',
      kind: 'reject_approval', requestId: 'req-1', channel: 'approval',
    });
    const box = new SupervisorOutbox(outbox, sender, () => { /* noop */ }, approver);
    await box.poll();
    expect(approver.resolved[0].payload).toEqual({ allowOnce: false });
  });

  it('does NOT archive when resolve returns notfound (fail loud, retry next pass)', async () => {
    approver.outcome = 'notfound';
    writeDelivery(outbox, {
      deliveryId: 'd1', sessionId: 's1', source: 'bob', text: 'x',
      kind: 'reject_approval', requestId: 'req-1', channel: 'approval',
    });
    const box = new SupervisorOutbox(outbox, sender, () => { /* noop */ }, approver);
    const n = await box.poll();
    expect(n).toBe(0);
    expect(fs.existsSync(path.join(outbox, 'd1.json'))).toBe(true); // left for retry
    // Next pass with the request now resolvable succeeds.
    approver.outcome = 'ok';
    expect(await box.poll()).toBe(1);
    expect(fs.existsSync(path.join(outbox, 'done', 'd1.json'))).toBe(true);
  });

  it('leaves a requestId delivery for retry when no approver is wired', async () => {
    writeDelivery(outbox, {
      deliveryId: 'd1', sessionId: 's1', source: 'bob', text: 'x', requestId: 'req-1', channel: 'approval',
    });
    const box = new SupervisorOutbox(outbox, sender); // no approver
    const n = await box.poll();
    expect(n).toBe(0);
    expect(fs.existsSync(path.join(outbox, 'd1.json'))).toBe(true);
  });

  it('still routes a message delivery (no requestId) to sender.send', async () => {
    writeDelivery(outbox, { deliveryId: 'd2', sessionId: 's1', source: 'bob', text: 'guidance', kind: 'yellow_guidance' });
    const box = new SupervisorOutbox(outbox, sender, () => { /* noop */ }, approver);
    await box.poll();
    expect(sender.sent).toEqual([{ taskId: 's1', text: 'guidance' }]);
    expect(approver.resolved).toHaveLength(0);
  });
});
