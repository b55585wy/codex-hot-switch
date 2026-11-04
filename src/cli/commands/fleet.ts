import { randomUUID } from 'node:crypto';
import { paths, useBotDir } from '../../config/paths';
import { addBot, currentBot, ensureRegistry, findBot, uniqueName } from '../../config/bots';
import { buildEncryptedAccountConfig, loadConfig, saveConfig } from '../../config/store';
import { isComplete, secretKeyForApp, type AppConfig, type TenantBrand } from '../../config/schema';
import { resolveAppSecret } from '../../config/secret-resolver';
import { setSecret } from '../../config/keystore';
import { validateAppCredentials } from '../../utils/feishu-auth';
import { isServiceRunning } from '../../service/adapter';
import { acquireSingleInstanceLock } from '../../core/single-instance';
import { ensureFleetTables } from '../../fleet/bitable';
import { BitableFleetStorage } from '../../fleet/bitable';
import { SignedFleetStore, validateFleetApiProxyUrl, validateFleetConfig, type FleetConfig } from '../../fleet/model';
import { createFleetApiClient } from '../../fleet/transport';
import { runFleetRelaySetup, runFleetRelayStatus, type RelaySetupOptions } from '../../fleet/relay/setup';
import { sanitizeRelayUrl } from '../../fleet/relay/client';

export function parseBaseToken(input: string): string {
  if (/^[a-zA-Z0-9]{10,}$/.test(input)) return input;
  try {
    const url = new URL(input);
    const token = /^\/base\/([a-zA-Z0-9]+)/.exec(url.pathname)?.[1];
    if (url.protocol === 'https:' && /(?:^|\.)(?:feishu\.cn|larksuite\.com)$/.test(url.hostname) && token) return token;
  } catch { /* Report the same actionable error for malformed URLs and tokens. */ }
  throw new Error('请提供飞书多维表格 /base/ 链接或 app token');
}

async function selectedConfig(appId?: string): Promise<Partial<AppConfig>> {
  const registry = await ensureRegistry();
  const bot = appId ? findBot(registry, appId) : currentBot(registry);
  if (bot) useBotDir(bot.appId);
  else if (appId && /^cli_[a-zA-Z0-9]+$/.test(appId)) useBotDir(appId);
  else if (appId) throw new Error('应用 ID 无效');
  return loadConfig();
}

export async function readFleetSecret(input: AsyncIterable<unknown> & { isTTY?: boolean } = process.stdin): Promise<string> {
  if (input.isTTY) throw new Error('请通过标准输入传入 App Secret，不要写入命令参数');
  let secret = '';
  for await (const chunk of input) {
    secret += String(chunk);
    if (Buffer.byteLength(secret) > 1024) throw new Error('输入内容超长');
  }
  if (!secret.trim()) throw new Error('标准输入没有 App Secret');
  return secret.trim();
}

export async function runFleetSetup(options: {
  name: string; base: string; appId?: string; owner?: string; tenant?: string; secretStdin?: boolean; pollMs?: string;
}): Promise<void> {
  const appToken = parseBaseToken(options.base);
  if (!options.name.trim() || options.name.length > 32) throw new Error('电脑名应为 1–32 个字符');
  let cfg = await selectedConfig(options.appId);
  if (isComplete(cfg) && isServiceRunning()) throw new Error('请先停止本机 Bridge，完成配置后再 start，避免配置被运行中的进程覆盖');
  const tenant = options.tenant ?? cfg.accounts?.app?.tenant ?? 'feishu';
  if (tenant !== 'feishu' && tenant !== 'lark') throw new Error('tenant 必须是 feishu 或 lark');
  const appId = options.appId ?? cfg.accounts?.app?.id;
  if (!appId || !/^cli_[a-zA-Z0-9]+$/.test(appId)) throw new Error('请先配置机器人或提供 --app-id');
  const newSecret = options.secretStdin ? await readFleetSecret() : undefined;
  if (!isComplete(cfg) && (!newSecret || !options.owner || !/^ou_[a-zA-Z0-9]+$/.test(options.owner))) {
    throw new Error('新电脑需要 --app-id、--owner 和 --secret-stdin；不要重新扫码创建另一个机器人');
  }
  const secret = newSecret ?? await resolveAppSecret(cfg as AppConfig);
  const checked = await validateAppCredentials(appId, secret, tenant as TenantBrand);
  if (!checked.ok) throw new Error(`机器人凭据或网络校验失败：${checked.reason}`);
  // This optional local transport setting survives setup/restart; it is not a
  // remote identity and does not change global routing or OS proxy settings.
  const apiProxyUrl = cfg.fleet?.apiProxyUrl;
  if (apiProxyUrl !== undefined) validateFleetApiProxyUrl(apiProxyUrl);
  const client = createFleetApiClient({ appId, appSecret: secret, tenant: tenant as TenantBrand, apiProxyUrl });
  const nodeId = cfg.fleet?.nodeId ?? randomUUID();
  const pollMs = options.pollMs === undefined ? 15_000 : Number(options.pollMs);
  if (newSecret) {
    await setSecret(secretKeyForApp(appId), secret);
    const encrypted = await buildEncryptedAccountConfig(appId, tenant as TenantBrand, cfg.preferences);
    cfg = { ...cfg, ...encrypted, secrets: { providers: { ...cfg.secrets?.providers, ...encrypted.secrets?.providers } } };
  }
  if (!isComplete(cfg)) throw new Error('机器人配置不完整');
  cfg.preferences = { ...cfg.preferences, access: { ...cfg.preferences?.access,
    ...(options.owner ? { ownerOpenId: options.owner } : {}) } };
  // Persist a disabled stable identity before touching shared tables, so an interrupted
  // setup keeps the same device ID and local preferences/credentials.
  const identity: FleetConfig = { enabled: false, nodeId, name: options.name.trim(), appToken,
    tables: cfg.fleet?.tables ?? { nodes: '', routes: '', commands: '' }, pollMs,
    ...(apiProxyUrl !== undefined ? { apiProxyUrl } : {}) };
  const pending = 'tblPending';
  validateFleetConfig({ ...identity, tables: { nodes: pending, routes: pending, commands: pending } });
  cfg.fleet = identity;
  await saveConfig(cfg);
  const tables = await ensureFleetTables(client, appToken);
  const config: FleetConfig = { enabled: true, nodeId, name: options.name.trim(), appToken, tables, pollMs,
    ...(apiProxyUrl !== undefined ? { apiProxyUrl } : {}) };
  validateFleetConfig(config);
  const store = new SignedFleetStore(new BitableFleetStorage(client, config), appId, secret);
  if (!await store.get('routes', 'home')) await store.put('routes', 'home', { nodeId: config.nodeId });
  // Enable only after shared directory initialization succeeded.
  cfg.fleet = config;
  await saveConfig(cfg);
  const registry = await ensureRegistry();
  if (!findBot(registry, appId)) await addBot({ appId, name: uniqueName(registry, 'codex-bridge'),
    tenant: tenant as TenantBrand, botName: checked.botName, createdAt: Date.now(), active: true });
  console.log(`已配置电脑「${config.name}」（${config.nodeId}）。运行 start 启动；飞书私聊 /电脑 查看节点。`);
  console.log('各电脑使用各自的 Codex 登录和项目目录。多电脑模式不迁移会话或复制账号凭据。');
}

export async function runFleetStatus(): Promise<void> {
  const cfg = await selectedConfig();
  const fleet = cfg.fleet;
  // Relay status is transport-oriented and must not show an irrelevant Bitable
  // poll interval. The URL is sanitized to a fixed validated endpoint.
  const view = fleet?.transport === 'relay'
    ? { enabled: fleet.enabled, transport: 'relay' as const, nodeId: fleet.nodeId, name: fleet.name,
      url: fleet.relay ? sanitizeRelayUrl(fleet.relay.url) : '(invalid relay url)',
      configFile: paths.configFile }
    : fleet
      ? { enabled: fleet.enabled, transport: 'bitable' as const, nodeId: fleet.nodeId,
        name: fleet.name, pollMs: fleet.pollMs ?? 15_000, configFile: paths.configFile }
      : { enabled: false, transport: 'bitable' as const, configFile: paths.configFile };
  console.log(JSON.stringify(view, null, 2));
}

export async function runFleetDisable(): Promise<void> {
  const cfg = await selectedConfig();
  if (cfg.fleet?.transport === 'relay') { await runFleetRelayDisable(); return; }
  if (isServiceRunning()) throw new Error('请先停止本机 Bridge，修改配置后再 start');
  if (!isComplete(cfg)) throw new Error('机器人配置不完整');
  if (cfg.fleet) { cfg.fleet.enabled = false; await saveConfig(cfg); }
  console.log('多电脑配置已关闭。仅在其他节点也已停用后，才以原单机模式连接同一个机器人。');
}

export async function runFleetRelaySetupCommand(options: RelaySetupOptions): Promise<void> {
  const result = await runFleetRelaySetup(options);
  console.log(JSON.stringify(result, null, 2));
  console.log('中继配置已启用。请先确认云端网关已准备好，再运行 start；本机不会连接飞书事件长连接。');
}

export async function runFleetRelayStatusCommand(appId?: string): Promise<void> {
  console.log(JSON.stringify(await runFleetRelayStatus(appId), null, 2));
}

export async function runFleetRelayDisable(): Promise<void> {
  const cfg = await selectedConfig();
  // Refuse to touch a Bitable/no-fleet configuration: the general
  // `fleet disable` command owns that transport.
  if (!cfg.fleet) throw new Error('当前没有多电脑配置，未修改任何配置');
  if (cfg.fleet.transport !== 'relay') {
    throw new Error('当前为 Bitable/本机多电脑模式，拒绝按中继方式停用；请使用 fleet disable，未修改配置');
  }
  if (!isComplete(cfg)) throw new Error('机器人配置不完整');
  const appId = cfg.accounts!.app!.id;
  let release: (() => void) | undefined;
  try {
    release = acquireSingleInstanceLock(appId);
    if (isServiceRunning()) throw new Error('请先停止本机 Bridge 后台服务，再修改中继配置');
    cfg.fleet = { ...cfg.fleet, enabled: false };
    await saveConfig(cfg as AppConfig);
    console.log('中继模式已停用。后续 start 会失败关闭，不会回退到本机飞书长连接。');
    console.log('回滚只有在云端网关已明确停用后才能进行；当前命令不会远程停用网关，也不会改回 Bitable。');
  } finally {
    release?.();
  }
}
