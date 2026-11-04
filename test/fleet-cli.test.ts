import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setup = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>, saves: [] as Array<Record<string, unknown>>,
  rows: new Map<string, unknown>(), live: false, storageFailure: false, tablesFailure: false,
}));
vi.mock('../src/config/paths', () => ({ paths: { configFile: '/test/bot/config.json' }, useBotDir: vi.fn() }));
vi.mock('../src/config/store', () => ({
  loadConfig: async () => structuredClone(setup.cfg),
  saveConfig: async (cfg: Record<string, unknown>) => { setup.cfg = structuredClone(cfg); setup.saves.push(structuredClone(cfg)); },
  buildEncryptedAccountConfig: vi.fn(),
}));
vi.mock('../src/config/bots', () => ({
  ensureRegistry: async () => ({ current: 'cli_test', bots: [{ appId: 'cli_test', name: 'test' }] }),
  currentBot: (reg: { bots: unknown[] }) => reg.bots[0],
  findBot: (reg: { bots: Array<{ appId: string }> }, id: string) => reg.bots.find(b => b.appId === id),
  addBot: vi.fn(), uniqueName: () => 'test',
}));
vi.mock('../src/config/secret-resolver', () => ({ resolveAppSecret: async () => 'fixture-secret' }));
vi.mock('../src/config/keystore', () => ({ setSecret: vi.fn() }));
vi.mock('../src/utils/feishu-auth', () => ({ validateAppCredentials: async () => ({ ok: true, botName: 'test' }) }));
vi.mock('../src/service/adapter', () => ({ isServiceRunning: () => setup.live }));
vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {}, Domain: { Lark: 'lark', Feishu: 'feishu' } }));
vi.mock('../src/fleet/bitable', () => ({
  ensureFleetTables: async () => {
    if (setup.tablesFailure) throw new Error('table initialization failed');
    return { nodes: 'tblNodes', routes: 'tblRoutes', commands: 'tblCommands' };
  },
  BitableFleetStorage: class {
    async get(table: string, key: string) {
      if (setup.storageFailure) throw new Error('control plane unavailable');
      return setup.rows.get(`${table}:${key}`);
    }
    async put(table: string, row: { key: string }) { setup.rows.set(`${table}:${row.key}`, row); }
  },
}));
import { readFleetSecret, runFleetDisable, runFleetSetup } from '../src/cli/commands/fleet';

beforeEach(() => {
  setup.cfg = { accounts: { app: { id: 'cli_test', tenant: 'feishu', secret: 'fixture-secret' } },
    preferences: { access: { ownerOpenId: 'ou_owner' }, maxConcurrentRuns: 3 } };
  setup.saves = []; setup.rows.clear(); setup.live = false;
  setup.storageFailure = false; setup.tablesFailure = false;
});

describe('fleet setup lifecycle', () => {
  it('preserves existing preferences and commits disabled identity before activation', async () => {
    await runFleetSetup({ name: 'wangyidemacbookair', base: 'appToken12345' });
    expect(setup.saves).toHaveLength(2);
    expect(setup.saves[0]).toMatchObject({ fleet: { enabled: false, name: 'wangyidemacbookair' } });
    expect(setup.saves[1]).toMatchObject({ fleet: { enabled: true, name: 'wangyidemacbookair' },
      preferences: { access: { ownerOpenId: 'ou_owner' }, maxConcurrentRuns: 3 } });
    expect(JSON.stringify(setup.saves)).not.toContain('app_secret');
  });
  it('retains a disabled stable identity after failure and reuses it on recovery', async () => {
    setup.storageFailure = true;
    await expect(runFleetSetup({ name: 'mac', base: 'appToken12345' })).rejects.toThrow('unavailable');
    const identity = (setup.cfg.fleet as { nodeId: string }).nodeId;
    expect(setup.cfg).toMatchObject({ fleet: { enabled: false } });
    setup.storageFailure = false;
    await runFleetSetup({ name: 'mac', base: 'appToken12345' });
    expect(setup.cfg).toMatchObject({ fleet: { enabled: true, nodeId: identity } });
  });
  it('persists a disabled stable identity before shared table initialization fails', async () => {
    setup.tablesFailure = true;
    await expect(runFleetSetup({ name: 'mac', base: 'appToken12345' })).rejects.toThrow('initialization failed');
    expect(setup.saves).toHaveLength(1);
    const identity = (setup.cfg.fleet as { nodeId: string }).nodeId;
    expect(setup.cfg).toMatchObject({ fleet: { enabled: false, name: 'mac' },
      preferences: { access: { ownerOpenId: 'ou_owner' }, maxConcurrentRuns: 3 } });
    setup.tablesFailure = false;
    await runFleetSetup({ name: 'mac', base: 'appToken12345' });
    expect(setup.cfg).toMatchObject({ fleet: { enabled: true, nodeId: identity } });
  });
  it('preserves the optional local API transport setting across setup', async () => {
    setup.cfg.fleet = { enabled: false, nodeId: '11111111-1111-4111-8111-111111111111', name: 'windows',
      appToken: 'appToken12345', tables: { nodes: 'tblNodes', routes: 'tblRoutes', commands: 'tblCommands' },
      pollMs: 15000, apiProxyUrl: 'http://127.0.0.1:7897' };
    await runFleetSetup({ name: 'windows', base: 'appToken12345' });
    expect(setup.saves).toHaveLength(2);
    expect(setup.saves[0]).toMatchObject({ fleet: { enabled: false, apiProxyUrl: 'http://127.0.0.1:7897' } });
    expect(setup.saves[1]).toMatchObject({ fleet: { enabled: true, apiProxyUrl: 'http://127.0.0.1:7897' } });
  });

  it('rejects a malformed or credential-bearing local API proxy before saving', async () => {
    for (const apiProxyUrl of ['ftp://proxy.test:7897', 'http://user:pass@127.0.0.1:7897']) {
      setup.saves = [];
      setup.cfg.fleet = { enabled: false, nodeId: '11111111-1111-4111-8111-111111111111', name: 'windows',
        appToken: 'appToken12345', tables: { nodes: 'tblNodes', routes: 'tblRoutes', commands: 'tblCommands' },
        pollMs: 15000, apiProxyUrl };
      await expect(runFleetSetup({ name: 'windows', base: 'appToken12345' })).rejects.toThrow('代理地址');
      expect(setup.saves).toHaveLength(0);
    }
  });

  it('does not modify a configuration being written by a running daemon', async () => {
    setup.live = true;
    await expect(runFleetSetup({ name: 'mac', base: 'appToken12345' })).rejects.toThrow('停止');
    await expect(runFleetDisable()).rejects.toThrow('停止');
    expect(setup.saves).toHaveLength(0);
  });
  it('disables routing without discarding the saved identity or project preferences', async () => {
    await runFleetSetup({ name: 'mac', base: 'appToken12345' });
    const identity = (setup.cfg.fleet as { nodeId: string }).nodeId;
    await runFleetDisable();
    expect(setup.cfg).toMatchObject({ fleet: { enabled: false, nodeId: identity }, preferences: { maxConcurrentRuns: 3 } });
  });
});

describe('secret standard input', () => {
  it('reads a piped secret without passing it as a command argument', async () => {
    expect(await readFleetSecret(Readable.from(['  private-fixture', '\n']))).toBe('private-fixture');
  });
  it('rejects empty, oversized and echoing terminal input', async () => {
    await expect(readFleetSecret(Readable.from([]))).rejects.toThrow('没有');
    await expect(readFleetSecret(Readable.from(['x'.repeat(1025)]))).rejects.toThrow('超长');
    const terminal = Object.assign(Readable.from(['fixture']), { isTTY: true });
    await expect(readFleetSecret(terminal)).rejects.toThrow('标准输入');
  });
});
