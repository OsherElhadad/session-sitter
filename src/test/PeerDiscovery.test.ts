import { describe, expect, it } from 'vitest';
import {
  discoverPeers,
  extractAuthorities,
  isSelfAddress,
  parseAuthority,
  stripWindowId,
} from '../remote/PeerDiscovery';

// The IDE records a remote window as `ssh-remote+<authority>`, where the authority is
// `user@host`. Two places carry it, and both are mined:
//
//   keys:   remote.tunnels.toRestore.ssh-remote+vpcuser@host.76044865
//   values: vscode-remote://ssh-remote%2Bvpcuser%40host/home/vpcuser/project
//
// The trailing `.76044865` is a window id, not part of the host. Stripping it is the one
// genuinely dangerous step: an IPv4 authority also ends in `.<digits>`, so a naive strip turns
// `eranra@192.168.50.16` into `eranra@192.168.50`.

describe('stripWindowId', () => {
  it('strips a long positive window id', () => {
    expect(stripWindowId('vpcuser@olapevolve.vpc.cloud9.ibm.com.76044865'))
      .toBe('vpcuser@olapevolve.vpc.cloud9.ibm.com');
  });

  it('strips a negative window id', () => {
    expect(stripWindowId('192.168.50.16.-628450726')).toBe('192.168.50.16');
  });

  it('leaves a bare IPv4 address alone', () => {
    // The regression this guards: `.16` is a final octet, not a window id.
    expect(stripWindowId('eranra@192.168.50.16')).toBe('eranra@192.168.50.16');
  });

  it('leaves an IPv4 authority with no user alone', () => {
    expect(stripWindowId('192.168.50.16')).toBe('192.168.50.16');
  });

  it('leaves a normal hostname alone', () => {
    expect(stripWindowId('vpcuser@olapevolve.vpc.cloud9.ibm.com'))
      .toBe('vpcuser@olapevolve.vpc.cloud9.ibm.com');
  });

  it('strips only one id segment', () => {
    expect(stripWindowId('user@host.example.com.428151645')).toBe('user@host.example.com');
  });
});

describe('parseAuthority', () => {
  it('splits user@host', () => {
    expect(parseAuthority('vpcuser@olapevolve.vpc.cloud9.ibm.com')).toEqual({
      user: 'vpcuser',
      host: 'olapevolve.vpc.cloud9.ibm.com',
      raw: 'vpcuser@olapevolve.vpc.cloud9.ibm.com',
    });
  });

  it('rejects a bare host, which gives us no user to connect as', () => {
    expect(parseAuthority('192.168.50.16')).toBeNull();
    expect(parseAuthority('olapevolve.vpc.cloud9.ibm.com')).toBeNull();
  });

  it('rejects empty and malformed input', () => {
    expect(parseAuthority('')).toBeNull();
    expect(parseAuthority('@host')).toBeNull();
    expect(parseAuthority('user@')).toBeNull();
    expect(parseAuthority('a@b@c')).toBeNull();
  });
});

describe('extractAuthorities', () => {
  it('mines the tunnel-restore key form', () => {
    const keys = ['remote.tunnels.toRestore.ssh-remote+vpcuser@olapevolve.vpc.cloud9.ibm.com.76044865'];
    expect(extractAuthorities(keys, [])).toEqual(['vpcuser@olapevolve.vpc.cloud9.ibm.com']);
  });

  it('mines the percent-encoded value form', () => {
    const values = ['vscode-remote://ssh-remote%2Bvpcuser%40olapevolve.vpc.cloud9.ibm.com/home/vpcuser/p'];
    expect(extractAuthorities([], values)).toEqual(['vpcuser@olapevolve.vpc.cloud9.ibm.com']);
  });

  it('mines the plain value form', () => {
    const values = ['vscode-remote://ssh-remote+eranra@192.168.50.16/home/eranra/p'];
    expect(extractAuthorities([], values)).toEqual(['eranra@192.168.50.16']);
  });

  it('dedupes the same authority found in both places and both encodings', () => {
    const keys = ['remote.tunnels.toRestore.ssh-remote+vpcuser@host.example.com.76044865'];
    const values = [
      'vscode-remote://ssh-remote%2Bvpcuser%40host.example.com/a',
      'vscode-remote://ssh-remote+vpcuser@host.example.com/b',
    ];
    expect(extractAuthorities(keys, values)).toEqual(['vpcuser@host.example.com']);
  });

  it('drops a suffixed duplicate when the clean form is also present', () => {
    // Belt-and-braces alongside stripWindowId: if both forms survive, keep the shorter.
    const values = [
      'ssh-remote+eranra@192.168.50.16',
      'ssh-remote+eranra@192.168.50.16.428151645',
    ];
    expect(extractAuthorities([], values)).toEqual(['eranra@192.168.50.16']);
  });

  it('ignores non-ssh remote authorities', () => {
    const values = ['vscode-remote://wsl+fedora/home/eranra/p', 'wsl+podman-machine-default'];
    expect(extractAuthorities([], values)).toEqual([]);
  });

  it('ignores authorities with no username', () => {
    const keys = ['remote.tunnels.toRestore.ssh-remote+192.168.50.16.-628450726'];
    expect(extractAuthorities(keys, [])).toEqual([]);
  });

  it('returns several distinct peers sorted for stable output', () => {
    const values = [
      'ssh-remote+vpcuser@olapevolve.vpc.cloud9.ibm.com',
      'ssh-remote+eranra@192.168.50.16',
    ];
    expect(extractAuthorities([], values)).toEqual([
      'eranra@192.168.50.16',
      'vpcuser@olapevolve.vpc.cloud9.ibm.com',
    ]);
  });

  it('survives junk input without throwing', () => {
    expect(extractAuthorities(['ssh-remote+'], ['ssh-remote%2B', 'ssh-remote+@'])).toEqual([]);
  });
});

describe('discoverPeers', () => {
  const dbs = ['/mnt/c/Users/u/AppData/Roaming/IBM Bob/User/globalStorage/state.vscdb'];

  // Pin the local identity for every case that is not about self-detection. Otherwise these
  // assertions quietly depend on the addresses of whatever machine runs the suite: 192.168.50.16
  // is a real interface on the development box, so an unpinned fixture using it would be dropped
  // there and kept on CI.
  const notSelf = { localAddresses: [] as string[], localHostname: 'test-runner-host' };

  it('reads every state db it is given and unions the result', async () => {
    const peers = await discoverPeers({
      ...notSelf,
      findStateDbs: async () => [...dbs, '/other/state.vscdb'],
      readItemTable: async (p) => p === dbs[0]
        ? { keys: ['remote.tunnels.toRestore.ssh-remote+vpcuser@olap.ibm.com.76044865'], values: [] }
        : { keys: [], values: ['ssh-remote+eranra@192.168.50.16'] },
    });
    expect(peers.map(p => p.raw)).toEqual([
      'eranra@192.168.50.16',
      'vpcuser@olap.ibm.com',
    ]);
  });

  it('returns nothing when no state db is reachable', async () => {
    const peers = await discoverPeers({
      findStateDbs: async () => [],
      readItemTable: async () => { throw new Error('should not be called'); },
    });
    expect(peers).toEqual([]);
  });

  it('skips a db it cannot read instead of failing the whole pass', async () => {
    // The IDE holds these files open; one unreadable db must not hide the others.
    const peers = await discoverPeers({
      ...notSelf,
      findStateDbs: async () => ['/bad/state.vscdb', ...dbs],
      readItemTable: async (p) => {
        if (p === '/bad/state.vscdb') { throw new Error('database is locked'); }
        return { keys: [], values: ['ssh-remote+vpcuser@olap.ibm.com'] };
      },
    });
    expect(peers.map(p => p.raw)).toEqual(['vpcuser@olap.ibm.com']);
  });

  it('excludes peers matching the local identity', async () => {
    const peers = await discoverPeers({
      findStateDbs: async () => dbs,
      readItemTable: async () => ({
        keys: [],
        values: ['ssh-remote+eranra@my-box', 'ssh-remote+vpcuser@olap.ibm.com'],
      }),
      isSelf: (p) => p.host === 'my-box',
    });
    expect(peers.map(p => p.raw)).toEqual(['vpcuser@olap.ibm.com']);
  });

  it('drops this machine by default, without being told to', async () => {
    // The `isSelf` seam used to default to "nothing is ever me", so a machine that had recorded
    // its own LAN address as an ssh-remote target probed itself every pass. Observed for real:
    // 192.168.50.16 is one of this host's own interfaces, and because ssh to yourself has no
    // reason to hold a key for you, it failed on publickey and the panel reported the user's own
    // machine as unreachable forever. Self-detection cannot wait for the probe's machineId — that
    // needs the ssh that is failing.
    const peers = await discoverPeers({
      findStateDbs: async () => dbs,
      readItemTable: async () => ({
        keys: [],
        values: ['ssh-remote+eranra@192.168.50.16', 'ssh-remote+vpcuser@olap.ibm.com'],
      }),
      localAddresses: ['127.0.0.1', '192.168.50.16', '172.26.89.33'],
      localHostname: 'eranra-wsl',
    });
    expect(peers.map(p => p.raw)).toEqual(['vpcuser@olap.ibm.com']);
  });
});

describe('isSelfAddress', () => {
  const local = { addresses: ['127.0.0.1', '192.168.50.16', '::1'], hostname: 'eranra-wsl.local' };

  it('matches an address bound to one of this host\'s interfaces', () => {
    expect(isSelfAddress('192.168.50.16', local)).toBe(true);
  });

  it('matches loopback by name and by address', () => {
    expect(isSelfAddress('localhost', local)).toBe(true);
    expect(isSelfAddress('127.0.0.1', local)).toBe(true);
    expect(isSelfAddress('::1', local)).toBe(true);
  });

  it('matches this host by name, full or short', () => {
    expect(isSelfAddress('eranra-wsl.local', local)).toBe(true);
    expect(isSelfAddress('eranra-wsl', local)).toBe(true);
    expect(isSelfAddress('ERANRA-WSL', local)).toBe(true);
  });

  it('does not match a real peer', () => {
    expect(isSelfAddress('olapevolve.vpc.cloud9.ibm.com', local)).toBe(false);
    expect(isSelfAddress('192.168.50.17', local)).toBe(false);
  });

  it('does not match a peer that merely shares our short name as a prefix', () => {
    // Substring matching here would silently hide a real machine, so the comparison is on
    // whole labels only.
    expect(isSelfAddress('eranra-wsl2', local)).toBe(false);
    expect(isSelfAddress('eranra-wsl.example.com', local)).toBe(false);
  });

  it('strips an IPv6 scope and zone brackets before comparing', () => {
    expect(isSelfAddress('[::1]', local)).toBe(true);
    expect(isSelfAddress('fe80::1%eth0', { addresses: ['fe80::1'], hostname: 'h' })).toBe(true);
  });
});
