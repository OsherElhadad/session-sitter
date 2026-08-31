import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, SshRunner } from '../remote/SshRunner';
import type { PeerAddress } from '../remote/PeerDiscovery';

const peer: PeerAddress = {
  user: 'vpcuser',
  host: 'olapevolve.vpc.cloud9.ibm.com',
  raw: 'vpcuser@olapevolve.vpc.cloud9.ibm.com',
};
const other: PeerAddress = { user: 'eranra', host: '192.168.50.16', raw: 'eranra@192.168.50.16' };

function runnerWith(exec: ReturnType<typeof vi.fn>, now = () => 0) {
  return new SshRunner({ exec: exec as never, now, controlDir: '/tmp/ss-ctl' });
}

describe('SshRunner argument construction', () => {
  let exec: ReturnType<typeof vi.fn>;

  beforeEach(() => { exec = vi.fn().mockResolvedValue({ stdout: 'ok' }); });

  it('always runs ssh in batch mode so it can never block on a prompt', async () => {
    // This is the safety property that makes automatic discovery shippable: a peer that would
    // ask for a password or key passphrase must fail fast, not hang a background timer forever.
    await runnerWith(exec).run(peer, ['echo', 'hi']);
    expect(exec.mock.calls[0][1]).toContain('BatchMode=yes');
  });

  it('sets a connect timeout', async () => {
    await runnerWith(exec).run(peer, ['echo', 'hi']);
    const args: string[] = exec.mock.calls[0][1];
    expect(args.some(a => a.startsWith('ConnectTimeout='))).toBe(true);
  });

  it('reuses one connection per peer via ControlMaster', async () => {
    await runnerWith(exec).run(peer, ['echo', 'hi']);
    const args: string[] = exec.mock.calls[0][1];
    expect(args).toContain('ControlMaster=auto');
    expect(args.some(a => a.startsWith('ControlPath=/tmp/ss-ctl/'))).toBe(true);
    expect(args.some(a => a.startsWith('ControlPersist='))).toBe(true);
  });

  it('invokes ssh, targets user@host, and passes the command as separate argv', async () => {
    // Never a shell string: a joined command would make any remote path or title a shell
    // injection point.
    await runnerWith(exec).run(peer, ['python3', '-c', 'print(1)']);
    const [file, args] = exec.mock.calls[0];
    expect(file).toBe('ssh');
    const target = args.indexOf(peer.raw);
    expect(target).toBeGreaterThan(-1);
    expect(args.slice(target + 1)).toEqual(['python3', '-c', 'print(1)']);
  });

  it('returns stdout on success', async () => {
    exec.mockResolvedValue({ stdout: '{"ok":true}' });
    await expect(runnerWith(exec).run(peer, ['true'])).resolves.toBe('{"ok":true}');
  });

  it('passes a payload on stdin rather than as an argument', async () => {
    // Regression: `ssh host cmd a b` gives its words to a shell on the far side, which re-splits
    // and expands them. A multi-line script sent as an argument arrives shredded, so anything
    // substantial must travel on stdin.
    const script = 'import os\nprint(os.getuid())\n';
    await runnerWith(exec).run(peer, ['python3', '-'], { stdin: script });

    const [, args, opts] = exec.mock.calls[0];
    expect(opts.stdin).toBe(script);
    expect(args.join(' ')).not.toContain('import os');
  });

  it('honours a caller timeout', async () => {
    await runnerWith(exec).run(peer, ['true'], { timeoutMs: 1234 });
    expect(exec.mock.calls[0][2].timeout).toBe(1234);
  });
});

describe('SshRunner negative cache', () => {
  it('does not call ssh again while a failed peer is backed off', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('Connection refused'));
    let t = 0;
    const runner = new SshRunner({ exec, now: () => t, controlDir: '/tmp/ss-ctl' });

    await expect(runner.run(peer, ['true'])).rejects.toThrow('Connection refused');
    expect(exec).toHaveBeenCalledTimes(1);

    t += 1000; // still inside the first backoff window
    await expect(runner.run(peer, ['true'])).rejects.toThrow(/backed off/i);
    expect(exec).toHaveBeenCalledTimes(1); // no second connection attempt
  });

  it('retries once the backoff window has passed', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('nope'));
    let t = 0;
    const runner = new SshRunner({ exec, now: () => t, controlDir: '/tmp/ss-ctl' });

    await expect(runner.run(peer, ['true'])).rejects.toThrow('nope');
    t += BACKOFF_BASE_MS + 1;
    await expect(runner.run(peer, ['true'])).rejects.toThrow('nope');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('grows the backoff window exponentially', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('nope'));
    let t = 0;
    const runner = new SshRunner({ exec, now: () => t, controlDir: '/tmp/ss-ctl' });

    await expect(runner.run(peer, ['true'])).rejects.toThrow('nope');
    expect(runner.backoffMs(peer)).toBe(BACKOFF_BASE_MS);

    t += BACKOFF_BASE_MS + 1;
    await expect(runner.run(peer, ['true'])).rejects.toThrow('nope');
    expect(runner.backoffMs(peer)).toBe(BACKOFF_BASE_MS * 2);
  });

  it('caps the backoff window', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('nope'));
    let t = 0;
    const runner = new SshRunner({ exec, now: () => t, controlDir: '/tmp/ss-ctl' });
    for (let i = 0; i < 20; i++) {
      await runner.run(peer, ['true']).catch(() => { /* expected */ });
      t += BACKOFF_CAP_MS + 1;
    }
    expect(runner.backoffMs(peer)).toBe(BACKOFF_CAP_MS);
  });

  it('clears the backoff after a success', async () => {
    const exec = vi.fn()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValue({ stdout: 'ok' });
    let t = 0;
    const runner = new SshRunner({ exec, now: () => t, controlDir: '/tmp/ss-ctl' });

    await expect(runner.run(peer, ['true'])).rejects.toThrow('nope');
    t += BACKOFF_BASE_MS + 1;
    await expect(runner.run(peer, ['true'])).resolves.toBe('ok');
    expect(runner.backoffMs(peer)).toBe(0);
  });

  it('backs off each peer independently', async () => {
    const exec = vi.fn().mockImplementation((_f: string, args: string[]) =>
      args.includes(peer.raw) ? Promise.reject(new Error('nope')) : Promise.resolve({ stdout: 'ok' }));
    const runner = runnerWith(exec);

    await expect(runner.run(peer, ['true'])).rejects.toThrow('nope');
    await expect(runner.run(other, ['true'])).resolves.toBe('ok');
    expect(runner.backoffMs(peer)).toBe(BACKOFF_BASE_MS);
    expect(runner.backoffMs(other)).toBe(0);
  });

  it('reports the last failure reason for the UI', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('Permission denied (publickey)'));
    const runner = runnerWith(exec);
    await runner.run(peer, ['true']).catch(() => { /* expected */ });
    expect(runner.lastError(peer)).toMatch(/Permission denied/);
  });
});
