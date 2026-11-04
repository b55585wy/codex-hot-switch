import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetStorage } from '../src/fleet/model';

const setup = vi.hoisted(() => ({
  dir: `${process.env.TEMP ?? process.env.TMP ?? '.'}\\bridge-relay-setup-test`,
  cfg: {} as Record<string, unknown>,
  saves: [] as Array<Record<string, unknown>>,
  saveFailure: false,
  locked: false,
  release: vi.fn(),
  secrets: new Map<string, string>(),
  bitableRows: { nodes: [], routes: [], commands: [] } as Record<string, Array<{ key: string; value: string; target?: string }>>,
  bitableWrites: [] as string[],
}));

vi.mock('../src/config/paths', () => ({
  paths: {
    configFile: `${setup.dir}/config.json`,
    fleetDir: `${setup.dir}/fleet`,
    appDir: setup.dir,
  },
  useBotDir: vi.fn(),
}));
vi.mock('../src/config/store', () => ({
  loadConfig: async () => structuredClone(setup.cfg),
  saveConfig: async (cfg: Record<string, unknown>) => {
    if (setup.saveFailure) throw new Error('disk full');
    setup.cfg = structuredClone(cfg); setup.saves.push(structuredClone(cfg));
  },
}));
vi.mock('../src/config/bots', () => ({
  ensureRegistry: async () => ({ current: 'cli_test', bots: [{ appId: 'cli_test', name: 'test' }] }),
  currentBot: (reg: { bots: Array<{ appId: string }> }) => reg.bots[0],
  findBot: (reg: { bots: Array<{ appId: string }> }, id: string) => reg.bots.find(bot => bot.appId === id),
}));
vi.mock('../src/config/secret-resolver', () => ({ resolveAppSecret: async () => 'app-secret-fixture' }));
vi.mock('../src/config/keystore', () => ({
  getSecret: async (id: string) => setup.secrets.get(id),
  setSecret: async (id: string, value: string) => { setup.secrets.set(id, value); },
  removeSecret: async (id: string) => { setup.secrets.delete(id); return true; },
}));
vi.mock('../src/core/single-instance', () => ({
  acquireSingleInstanceLock: () => {
    if (setup.locked) throw new Error('另一个 bridge 进程已在运行');
    return setup.release;
  },
}));
vi.mock('../src/service/adapter', () => ({ isServiceRunning: () => false }));
vi.mock('../src/fleet/transport', () => ({ createFleetApiClient: () => ({}) }));
vi.mock('../src/fleet/bitable', () => ({
  BitableFleetStorage: class {
    constructor(_client: unknown, _config: unknown) {}
    async list(table: string) { return setup.bitableRows[table] ?? []; }
    async get(table: string, key: string) {
      return (setup.bitableRows[table] ?? []).find(row => row.key === key);
    }
    async put(table: string, row: { key: string }) { setup.bitableWrites.push(`${table}:${row.key}`); }
    async remove() {}
  },
}));

import {
  readRelayToken, runFleetRelaySetup, runFleetRelayStatus, validateRelayToken,
} from '../src/fleet/relay/setup';
import { runFleetRelayDisable, runFleetStatus } from '../src/cli/commands/fleet';
import { SignedFleetStore } from '../src/fleet/model';
import { startFleetRelayServer, type FleetRelayServer } from '../src/fleet/relay/server';

const token = 'relay-setup-test-token-0123456789abcdef';
const appId = 'cli_test';
const secret = 'app-secret-fixture';
const nodeId = '11111111-1111-4111-8111-111111111111';
const otherNode = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [];
const servers: FleetRelayServer[] = [];

beforeEach(async () => {
  await rm(setup.dir, { recursive: true, force: true });
  setup.cfg = {
    accounts: { app: { id: appId, tenant: 'feishu', secret: 'fixture-secret' } },
    preferences: { access: { ownerOpenId: 'ou_owner' }, maxConcurrentRuns: 3 },
    fleet: { enabled: false, nodeId, name: 'windows', appToken: 'appToken12345',
      tables: { nodes: 'tblNodes', routes: 'tblRoutes', commands: 'tblCommands' }, pollMs: 15000 },
  };
  setup.saves = []; setup.saveFailure = false; setup.locked = false;
  setup.secrets.clear(); setup.bitableRows = { nodes: [], routes: [], commands: [] };
  setup.bitableWrites = []; setup.release.mockClear();
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close().catch(() => undefined);
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
  await rm(setup.dir, { recursive: true, force: true });
});

async function startServer(root?: string, port = 0) {
  const dir = root ?? await mkdtemp(join(tmpdir(), 'bridge-relay-setup-server-'));
  if (!root) roots.push(dir);
  const server = await startFleetRelayServer({ appId, token, dataDir: dir, port });
  servers.push(server);
  return { server, root: dir };
}

describe('relay token input contract', () => {
  it('reads a bounded stdin token and rejects empty, TTY, short and low-entropy input', async () => {
    expect(await readRelayToken(Readable.from([`  ${token}\n`]))).toBe(token);
    await expect(readRelayToken(Readable.from([]))).rejects.toThrow(/没有中继令牌/);
    await expect(readRelayToken(Object.assign(Readable.from([token]), { isTTY: true }))).rejects.toThrow(/标准输入/);
    await expect(readRelayToken(Readable.from(['short']))).rejects.toThrow(/32/);
    expect(() => validateRelayToken('a'.repeat(40))).toThrow(/熵/);
    await expect(readRelayToken(Readable.from(['x'.repeat(1025)]))).rejects.toThrow(/超长/);
  });
});

describe('transactional relay setup', () => {
  it('validates an inactive real WS session before enabling and preserves legacy fields and preferences', async () => {
    const { server } = await startServer();
    const result = await runFleetRelaySetup({ url: server.url, tokenStdin: true }, Readable.from([token]));
    expect(result).toMatchObject({ enabled: true, transport: 'relay', nodeId, name: 'windows' });
    expect(setup.saves).toHaveLength(1);
    expect(setup.saves[0]).toMatchObject({ fleet: { enabled: true, transport: 'relay', nodeId,
      name: 'windows', appToken: 'appToken12345', tables: { nodes: 'tblNodes', routes: 'tblRoutes', commands: 'tblCommands' },
      relay: { url: server.url, tokenSecretId: expect.stringMatching(new RegExp(`^fleet-relay-${appId}-[a-z0-9]+-[a-f0-9]+$`)) } },
    preferences: { access: { ownerOpenId: 'ou_owner' }, maxConcurrentRuns: 3 } });
    const secretId = (setup.saves[0]!.fleet as { relay: { tokenSecretId: string } }).relay.tokenSecretId;
    expect(setup.secrets.get(secretId)).toBe(token);
    expect(JSON.stringify(setup.saves)).not.toContain(token);
    expect(await new SignedFleetStore(server.storage, appId, secret).get('routes', 'home'))
      .toMatchObject({ nodeId });
    expect(setup.release).toHaveBeenCalled();
    // Setup never activates: a mere validation connection is not presence.
    expect(server.storage.isNodeConnected?.(nodeId)).toBe(false);
  });

  it('keeps the prior config and token and reuses a pending identity after an initial outage', async () => {
    const first = await startServer();
    const root = first.root; const port = first.server.port; const url = first.server.url;
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);
    setup.cfg = { accounts: { app: { id: appId, tenant: 'feishu', secret: 'fixture-secret' } } };
    await expect(runFleetRelaySetup({ url, tokenStdin: true }, Readable.from([token]))).rejects.toThrow();
    expect(setup.saves).toHaveLength(0);
    expect(setup.secrets.size).toBe(0);
    const pendingRaw = JSON.parse(await readFile(join(setup.dir, 'fleet', 'relay-setup-pending.json'), 'utf8'));
    expect(pendingRaw.nodeId).toMatch(/^[a-f0-9-]{36}$/);
    const restarted = await startServer(root, port);
    await runFleetRelaySetup({ url, tokenStdin: true }, Readable.from([token]));
    expect(restarted.server.port).toBe(port);
    expect((setup.saves[0]!.fleet as { nodeId: string }).nodeId).toBe(pendingRaw.nodeId);
  });

  it('refuses to write anything while the per-bot process lock is held', async () => {
    setup.locked = true;
    const { server } = await startServer();
    await expect(runFleetRelaySetup({ url: server.url, tokenStdin: true }, Readable.from([token])))
      .rejects.toThrow(/已在运行/);
    expect(setup.saves).toHaveLength(0);
    expect(setup.secrets.size).toBe(0);
    expect(server.storage.isNodeConnected?.(nodeId)).toBe(false);
  });

  it('leaves the prior config and token untouched when the final config commit fails', async () => {
    const { server } = await startServer();
    const previous = { enabled: true, nodeId, name: 'windows', appToken: '', tables: { nodes: '', routes: '', commands: '' },
      transport: 'relay', relay: { url: server.url, tokenSecretId: 'existing-relay-token' } };
    setup.cfg.fleet = structuredClone(previous);
    setup.secrets.set('existing-relay-token', 'previous-token-0123456789abcdefghijkl');
    setup.saveFailure = true;
    await expect(runFleetRelaySetup({ url: server.url, tokenStdin: true }, Readable.from([token])))
      .rejects.toThrow('disk full');
    expect(setup.saves).toHaveLength(0);
    expect(setup.secrets.get('existing-relay-token')).toBe('previous-token-0123456789abcdefghijkl');
    // The new versioned token is only an orphan at worst; old config is intact.
    expect(setup.cfg.fleet).toMatchObject(previous);
    expect([...setup.secrets.keys()].filter(id => id !== 'existing-relay-token')).toHaveLength(0);
  });

  it('returns committed success when postcommit pending-identity cleanup fails', async () => {
    const { server } = await startServer();
    const result = await runFleetRelaySetup({ url: server.url, tokenStdin: true,
      clearPending: async () => { throw new Error('EPERM'); } }, Readable.from([token]));
    expect(result).toMatchObject({ enabled: true, transport: 'relay' });
    expect(setup.saves).toHaveLength(1);
    expect((setup.saves[0]!.fleet as { enabled: boolean }).enabled).toBe(true);
  });

  it('rejects a malformed app id before selecting a bot directory or writing', async () => {
    const { useBotDir } = await import('../src/config/paths');
    vi.mocked(useBotDir).mockClear();
    await expect(runFleetRelaySetup({ url: 'ws://127.0.0.1:8787/relay/v1', tokenStdin: true,
      appId: '../evil' }, Readable.from([token]))).rejects.toThrow(/应用 ID/);
    expect(useBotDir).not.toHaveBeenCalled();
    expect(setup.saves).toHaveLength(0);
    expect(setup.secrets.size).toBe(0);
  });

  it('rejects a token longer than the server 512-character limit', () => {
    const long = (length: number): string => Array.from({ length },
      (_, index) => 'Ab3xY9Zq'[index % 8]).join('');
    expect(() => validateRelayToken(long(513))).toThrow(/512/);
    expect(() => validateRelayToken(long(512))).not.toThrow();
  });

  it('refuses fleet relay disable on a Bitable or absent config', async () => {
    setup.cfg.fleet = { enabled: true, nodeId, name: 'windows', appToken: 'appToken12345',
      tables: { nodes: 'tblNodes', routes: 'tblRoutes', commands: 'tblCommands' } };
    await expect(runFleetRelayDisable()).rejects.toThrow(/Bitable/);
    expect(setup.saves).toHaveLength(0);
    setup.cfg = { accounts: { app: { id: appId, tenant: 'feishu', secret: 'fixture-secret' } } };
    await expect(runFleetRelayDisable()).rejects.toThrow(/没有多电脑配置/);
    expect(setup.saves).toHaveLength(0);
  });

  it('disables relay mode under the process lock and keeps the identity for a fail-closed restart', async () => {
    const { server } = await startServer();
    await runFleetRelaySetup({ url: server.url, tokenStdin: true }, Readable.from([token]));
    setup.release.mockClear();
    await runFleetRelayDisable();
    expect(setup.release).toHaveBeenCalledTimes(1);
    expect(setup.saves.at(-1)).toMatchObject({ fleet: { enabled: false, transport: 'relay', nodeId } });
  });

  it('reports transport/URL/identity without token secret references', async () => {
    const { server } = await startServer();
    await runFleetRelaySetup({ url: server.url, tokenStdin: true }, Readable.from([token]));
    const status = await runFleetRelayStatus();
    expect(status).toMatchObject({ enabled: true, transport: 'relay', nodeId, name: 'windows',
      relayUrl: server.url });
    expect(JSON.stringify(status)).not.toContain('tokenSecretId');
    expect(JSON.stringify(status)).not.toContain(token);
    const output: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { output.push(String(args[0])); });
    await runFleetStatus();
    spy.mockRestore();
    const general = JSON.parse(output[0]!) as Record<string, unknown>;
    expect(general).toMatchObject({ enabled: true, transport: 'relay', nodeId, name: 'windows', url: server.url });
    expect(general).not.toHaveProperty('pollMs');
    expect(JSON.stringify(general)).not.toContain(token);
  });
});

describe('explicit Bitable metadata import', () => {
  function signRows(table: 'nodes' | 'routes', values: Array<{ key: string; value: unknown }>) {
    const signer = new SignedFleetStore({} as FleetStorage, appId, secret);
    return values.map(entry => signer.encode(table, entry.key, entry.value));
  }

  it('copies verified nodes/routes only, never commands or inbox state', async () => {
    const { server } = await startServer();
    setup.bitableRows.nodes = signRows('nodes', [
      { key: nodeId, value: { id: nodeId, name: 'windows', protocol: 1, seenAt: Date.now(), host: 'h' } },
      { key: 'gateway-1', value: { id: 'gateway-1', name: 'Relay Gateway', protocol: 1, seenAt: Date.now(),
        host: 'gw', kind: 'gateway' } },
    ]);
    setup.bitableRows.routes = signRows('routes', [
      { key: 'home', value: { nodeId } }, { key: 'project:oc_group', value: { nodeId } },
    ]);
    setup.bitableRows.commands = signRows('routes', [{ key: 'cmd-old', value: { nodeId } }]);
    const result = await runFleetRelaySetup({ url: server.url, tokenStdin: true, importFromBitable: true },
      Readable.from([token]));
    expect(result.imported).toEqual({ nodes: 2, routes: 2 });
    const store = new SignedFleetStore(server.storage, appId, secret);
    expect(await store.get('nodes', nodeId)).toMatchObject({ name: 'windows' });
    expect(await store.get('nodes', 'gateway-1')).toMatchObject({ kind: 'gateway' });
    expect(await store.get('routes', 'project:oc_group')).toMatchObject({ nodeId });
    expect(await store.list('commands')).toHaveLength(0);
  });

  it('verifies every signature and refuses conflicting destination values before writing', async () => {
    const { server } = await startServer();
    const destination = new SignedFleetStore(server.storage, appId, secret);
    await destination.put('routes', 'project:oc_group', { nodeId: otherNode });
    setup.bitableRows.nodes = signRows('nodes', [
      { key: otherNode, value: { id: otherNode, name: 'mac', protocol: 1, seenAt: Date.now(), host: 'm' } },
    ]);
    setup.bitableRows.routes = signRows('routes', [
      { key: 'project:oc_group', value: { nodeId } },
    ]);
    await expect(runFleetRelaySetup({ url: server.url, tokenStdin: true, importFromBitable: true },
      Readable.from([token]))).rejects.toThrow(/冲突/);
    expect(await destination.get('nodes', otherNode)).toBeUndefined();
    expect(await destination.get('routes', 'project:oc_group')).toMatchObject({ nodeId: otherNode });

    setup.bitableRows.nodes = [{ key: 'bad', value: 'not-a-signed-row' }];
    setup.bitableRows.routes = [];
    await expect(runFleetRelaySetup({ url: server.url, tokenStdin: true, importFromBitable: true },
      Readable.from([token]))).rejects.toThrow(/校验失败|not valid JSON|无效/);
    expect(await destination.get('nodes', 'bad')).toBeUndefined();
    expect(setup.saves).toHaveLength(0);
  });
});
