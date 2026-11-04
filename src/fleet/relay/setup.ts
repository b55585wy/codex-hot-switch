import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import type { AppConfig, TenantBrand } from '../../config/schema';
import { isComplete } from '../../config/schema';
import { paths, useBotDir } from '../../config/paths';
import { currentBot, ensureRegistry, findBot } from '../../config/bots';
import { loadConfig, saveConfig } from '../../config/store';
import { removeSecret, setSecret } from '../../config/keystore';
import { resolveAppSecret } from '../../config/secret-resolver';
import { acquireSingleInstanceLock } from '../../core/single-instance';
import { isServiceRunning } from '../../service/adapter';
import { BitableFleetStorage } from '../bitable';
import { createFleetApiClient } from '../transport';
import {
  SignedFleetStore, canonical, digest, isOnline, validateFleetApiProxyUrl, validateFleetConfig,
  type FleetConfig, type FleetNode,
} from '../model';
import { FleetRelayClient, normalizeRelayUrl, sanitizeRelayUrl } from './client';

const NODE_ID_RE = /^[a-f0-9-]{36}$/i;
const PENDING_FILE = 'relay-setup-pending.json';

export interface RelaySetupOptions {
  url: string;
  name?: string;
  appId?: string;
  tokenStdin?: boolean;
  proxyUrl?: string;
  importFromBitable?: boolean;
  /** Internal test seam for postcommit pending-identity cleanup failures. */
  clearPending?: (file: string) => Promise<void>;
}

export interface RelaySetupResult {
  enabled: true;
  transport: 'relay';
  nodeId: string;
  name: string;
  url: string;
  imported?: { nodes: number; routes: number };
}

interface PendingIdentity { nodeId: string; name: string; createdAt: number }

export function validateRelayToken(value: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error('中继令牌无效：不能为空或包含首尾空白');
  }
  if (Buffer.byteLength(value, 'utf8') < 32 || value.length > 512) {
    throw new Error('中继令牌至少需要 32 字节，且不能超过 512 个字符');
  }
  if (/[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error('中继令牌不能包含空白或控制字符');
  }
  if (new Set(value).size < 8) throw new Error('中继令牌熵过低，请使用服务器生成的高熵令牌');
  return value;
}

/** Relay token input is stdin-only, bounded, and never echoed back. */
export async function readRelayToken(
  input: AsyncIterable<unknown> & { isTTY?: boolean } = process.stdin,
): Promise<string> {
  if (input.isTTY) throw new Error('请通过标准输入传入中继令牌（--token-stdin），不要写入命令参数');
  let token = '';
  for await (const chunk of input) {
    token += String(chunk);
    if (Buffer.byteLength(token, 'utf8') > 1024) throw new Error('中继令牌输入超长');
  }
  if (!token.trim()) throw new Error('标准输入没有中继令牌');
  return validateRelayToken(token.trim());
}

const APP_ID_RE = /^cli_[a-zA-Z0-9]+$/;

/** Validate the caller-supplied id BEFORE touching any bot directory. */
function assertAppId(appId: string | undefined): void {
  if (appId !== undefined && !APP_ID_RE.test(appId)) {
    throw new Error('应用 ID 无效：应为 cli_ 开头的机器人 App ID');
  }
}

async function selectedConfig(appId?: string): Promise<Partial<AppConfig>> {
  assertAppId(appId);
  const registry = await ensureRegistry();
  const bot = appId ? findBot(registry, appId) : currentBot(registry);
  if (bot) useBotDir(bot.appId);
  else if (appId) useBotDir(appId);
  return loadConfig();
}

function defaultName(cfg: Partial<AppConfig>, pending?: PendingIdentity): string {
  const existing = cfg.fleet?.name?.trim();
  if (existing) return existing.slice(0, 32);
  if (pending?.name) return pending.name.slice(0, 32);
  const host = hostname().trim().replace(/[^\w.-]+/g, '-').slice(0, 32);
  return host || 'codex-bridge';
}

function pendingPath(): string {
  return join(paths.fleetDir, PENDING_FILE);
}

async function readPendingIdentity(file: string): Promise<PendingIdentity | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<PendingIdentity>;
    if (typeof parsed.nodeId !== 'string' || !NODE_ID_RE.test(parsed.nodeId)
      || typeof parsed.name !== 'string' || !parsed.name.trim()) {
      throw new Error('待提交身份文件已损坏；请核对后手动移除');
    }
    return { nodeId: parsed.nodeId, name: parsed.name.trim().slice(0, 32),
      createdAt: Number(parsed.createdAt) || Date.now() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Exclusive create; an existing valid pending identity is preserved verbatim. */
async function writePendingIdentity(file: string, identity: PendingIdentity): Promise<PendingIdentity> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(identity)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return identity;
}

async function clearPendingIdentity(file: string): Promise<void> {
  try { await unlink(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function homeNodeId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const nodeId = (value as { nodeId?: unknown }).nodeId;
  return typeof nodeId === 'string' && NODE_ID_RE.test(nodeId) ? nodeId : undefined;
}

interface DecodedRow<T> { key: string; value: T }

async function decodedRows<T>(store: SignedFleetStore, table: 'nodes' | 'routes'): Promise<DecodedRow<T>[]> {
  const rows = await store.storage.list(table);
  return rows.map(row => ({ key: row.key, value: store.decode<T>(table, row) }));
}

async function importBitableMetadata(options: {
  source: SignedFleetStore;
  destination: SignedFleetStore;
  destinationRows: { nodes: DecodedRow<FleetNode>[]; routes: DecodedRow<{ nodeId?: string }>[] };
}): Promise<{ nodes: number; routes: number }> {
  // Verify every source row signature before changing the destination.
  const sourceNodes = await decodedRows<FleetNode>(options.source, 'nodes');
  const sourceRoutes = await decodedRows<{ nodeId?: string }>(options.source, 'routes');
  const destNodeMap = new Map(options.destinationRows.nodes.map(row => [row.key, row.value]));
  const destRouteMap = new Map(options.destinationRows.routes.map(row => [row.key, row.value]));

  const assertCompatible = (table: 'nodes' | 'routes', key: string,
    sourceValue: unknown, destinationValue: unknown): void => {
    if (canonical(sourceValue) === canonical(destinationValue)) return;
    if (table === 'nodes') {
      const sourceKind = (sourceValue as FleetNode | undefined)?.kind;
      const destinationKind = (destinationValue as FleetNode | undefined)?.kind;
      if (sourceKind === 'gateway' || destinationKind === 'gateway') return;
    }
    throw new Error(`中继导入冲突：${table}/${key} 在共享目录中已有不同值，未写入任何导入记录`);
  };

  // Preflight every conflict before the first destination write.
  for (const table of ['nodes', 'routes'] as const) {
    const rows = table === 'nodes' ? sourceNodes : sourceRoutes;
    const destination = table === 'nodes' ? destNodeMap : destRouteMap;
    for (const row of rows) {
      const existing = destination.get(row.key);
      if (existing !== undefined) assertCompatible(table, row.key, row.value, existing);
    }
  }

  let nodes = 0; let routes = 0;
  for (const row of sourceNodes) {
    if (destNodeMap.get(row.key) !== undefined) continue;
    if (!await options.destination.putIfUnchanged('nodes', row.key, undefined, row.value)) {
      const current = await options.destination.get<FleetNode>('nodes', row.key);
      assertCompatible('nodes', row.key, row.value, current);
      continue;
    }
    nodes += 1;
  }
  for (const row of sourceRoutes) {
    if (destRouteMap.get(row.key) !== undefined) continue;
    if (!await options.destination.putIfUnchanged('routes', row.key, undefined, row.value)) {
      const current = await options.destination.get<{ nodeId?: string }>('routes', row.key);
      assertCompatible('routes', row.key, row.value, current);
      continue;
    }
    routes += 1;
  }
  return { nodes, routes };
}

/**
 * Transactional opt-in relay setup. Existing bot credentials, preferences,
 * stable identity and legacy Bitable references are preserved. The relay token
 * is stored only in the native keystore and the config is enabled only after a
 * real inactive WS session validated the shared metadata.
 */
export async function runFleetRelaySetup(
  options: RelaySetupOptions,
  input: AsyncIterable<unknown> & { isTTY?: boolean } = process.stdin,
): Promise<RelaySetupResult> {
  if (!options.tokenStdin) throw new Error('必须使用 --token-stdin 从标准输入提供中继令牌');
  // Reject a malformed/traversal id before any bot directory selection.
  assertAppId(options.appId);
  const url = normalizeRelayUrl(options.url);
  if (options.proxyUrl !== undefined) validateFleetApiProxyUrl(options.proxyUrl);
  const token = await readRelayToken(input);

  let cfg = await selectedConfig(options.appId);
  const appId = options.appId ?? cfg.accounts?.app?.id;
  if (!appId || !APP_ID_RE.test(appId)) {
    throw new Error('请先配置本机机器人；中继设置复用现有完整机器人凭据，不需要重新创建机器人');
  }
  if (!isComplete(cfg) || cfg.accounts?.app?.id !== appId) {
    throw new Error('本机机器人配置不完整；请先完成 bot init，再运行 fleet relay setup');
  }
  const app = cfg.accounts.app;
  const tenant = app.tenant as TenantBrand;
  const appSecret = await resolveAppSecret(cfg as AppConfig);

  let release: (() => void) | undefined;
  try {
    // Refuse while any foreground/background bridge owns this bot's lock. A
    // service PID check alone cannot see a foreground `run`.
    release = acquireSingleInstanceLock(appId);
    if (isServiceRunning()) throw new Error('请先停止本机 Bridge 后台服务，完成中继设置后再 start');

    const pendingFile = pendingPath();
    const pending = await readPendingIdentity(pendingFile);
    const existingNodeId = cfg.fleet?.nodeId && NODE_ID_RE.test(cfg.fleet.nodeId)
      ? cfg.fleet.nodeId : undefined;
    const nodeId = existingNodeId ?? pending?.nodeId ?? randomUUID();
    const name = options.name?.trim() ? options.name.trim() : defaultName(cfg, pending);
    if (!name || name.length > 32) throw new Error('电脑名应为 1–32 个字符');
    const identity = { nodeId, name, createdAt: Date.now() };
    if (!pending) await writePendingIdentity(pendingFile, identity);
    else if (pending.nodeId !== nodeId) {
      throw new Error('待提交的电脑身份与当前配置不一致，请先核对后手动清理设置文件');
    }

    const host = digest({ host: hostname(), home: paths.appDir });
    const legacyFleet = cfg.fleet;
    const legacyConfig = legacyFleet && (legacyFleet.appToken || legacyFleet.tables?.nodes)
      ? { enabled: true, nodeId, name, appToken: legacyFleet.appToken,
        tables: legacyFleet.tables, pollMs: legacyFleet.pollMs,
        ...(legacyFleet.apiProxyUrl ? { apiProxyUrl: legacyFleet.apiProxyUrl } : {}) } as FleetConfig
      : undefined;

    // Every commit uses a NEW versioned token secret id. The old key/token is
    // never overwritten, so a failed save (ENOSPC/EACCES) leaves the prior
    // usable config/token intact; the new secret is at worst an orphan.
    const tokenSecretId = `fleet-relay-${appId.slice(0, 64)}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

    const client = new FleetRelayClient({
      url, token, appId, role: 'worker', nodeId, host,
      ...(options.proxyUrl ? { proxyUrl: options.proxyUrl } : {}),
      autoReconnect: false,
    });
    let imported: { nodes: number; routes: number } | undefined;
    try {
      await client.connect();
      const destination = new SignedFleetStore(client, appId, appSecret);
      // Verify existing destination signatures before any metadata decision.
      const destinationRows = {
        nodes: await decodedRows<FleetNode>(destination, 'nodes'),
        routes: await decodedRows<{ nodeId?: string }>(destination, 'routes'),
      };
      const existingHome = destinationRows.routes.find(row => row.key === 'home');
      if (existingHome && !homeNodeId(existingHome.value)) {
        throw new Error('共享目录 home 记录无效；未启用中继配置');
      }
      const existingNode = destinationRows.nodes.find(row => row.key === nodeId)?.value;
      if (existingNode && existingNode.kind === 'gateway') {
        throw new Error('设备 ID 与中继网关身份冲突，未启用中继配置');
      }
      if (existingNode && existingNode.host !== host && isOnline(existingNode)) {
        throw new Error('设备 ID 正被另一台在线电脑使用，未启用中继配置');
      }

      if (options.importFromBitable) {
        if (!legacyConfig) throw new Error('没有可导入的有效 Bitable 配置；请先恢复原 Bitable 字段后重试');
        validateFleetConfig(legacyConfig);
        const bitableClient = createFleetApiClient({ appId, appSecret, tenant,
          apiProxyUrl: legacyConfig.apiProxyUrl });
        const source = new SignedFleetStore(new BitableFleetStorage(bitableClient, legacyConfig), appId, appSecret);
        // Source signatures are verified inside import() before writes.
        imported = await importBitableMetadata({ source, destination, destinationRows });
      }

      // Initialize absent home only after import preflight. A concurrent valid
      // home is accepted instead of overwritten.
      if (!existingHome) {
        const created = await destination.putIfUnchanged('routes', 'home', undefined, { nodeId });
        if (!created) {
          const current = await destination.get<{ nodeId?: string }>('routes', 'home');
          if (!homeNodeId(current)) throw new Error('共享目录初始化发生并发冲突；未启用中继配置');
        }
      }
    } finally {
      await client.close().catch(() => undefined);
    }

    const fleet: FleetConfig = {
      enabled: true,
      nodeId,
      name,
      appToken: legacyFleet?.appToken ?? '',
      tables: legacyFleet?.tables ?? { nodes: '', routes: '', commands: '' },
      ...(legacyFleet?.pollMs !== undefined ? { pollMs: legacyFleet.pollMs } : {}),
      ...(legacyFleet?.apiProxyUrl !== undefined ? { apiProxyUrl: legacyFleet.apiProxyUrl } : {}),
      transport: 'relay',
      relay: { url, tokenSecretId, ...(options.proxyUrl ? { proxyUrl: options.proxyUrl } : {}) },
    };
    validateFleetConfig(fleet);
    try {
      await setSecret(tokenSecretId, token);
      cfg = { ...cfg, fleet };
      // Existing saveConfig performs the atomic config replacement.
      await saveConfig(cfg as AppConfig);
    } catch (error) {
      // Only the new token can be removed; the previous config/token were never
      // touched. Cleanup failure leaves an orphan secret, never a broken config.
      await removeSecret(tokenSecretId).catch(() => undefined);
      throw error;
    }
    // The config/token commit succeeded. Pending-identity cleanup is postcommit;
    // its failure must not be reported as a failed transaction.
    await (options.clearPending ?? clearPendingIdentity)(pendingFile).catch(() => undefined);
    return { enabled: true, transport: 'relay', nodeId, name, url: sanitizeRelayUrl(url),
      ...(imported ? { imported } : {}) };
  } finally {
    release?.();
  }
}

export interface RelayStatus {
  enabled: boolean;
  transport: 'bitable' | 'relay';
  name?: string;
  nodeId?: string;
  relayUrl?: string;
  configFile: string;
}

export async function runFleetRelayStatus(appId?: string): Promise<RelayStatus> {
  const cfg = await selectedConfig(appId);
  const fleet = cfg.fleet;
  if (!fleet) return { enabled: false, transport: 'bitable', configFile: paths.configFile };
  return {
    enabled: Boolean(fleet.enabled),
    transport: fleet.transport === 'relay' ? 'relay' : 'bitable',
    name: fleet.name,
    nodeId: fleet.nodeId,
    ...(fleet.relay ? { relayUrl: sanitizeRelayUrl(fleet.relay.url) } : {}),
    configFile: paths.configFile,
  };
}

export const relaySetupPendingFile = PENDING_FILE;
