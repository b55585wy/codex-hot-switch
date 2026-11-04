import { randomUUID } from 'node:crypto';
import { Client, Domain } from '@larksuiteoapi/node-sdk';
import { paths, useBotDir } from '../../config/paths';
import { addBot, currentBot, ensureRegistry, findBot, uniqueName } from '../../config/bots';
import { buildEncryptedAccountConfig, loadConfig, saveConfig } from '../../config/store';
import { isComplete, secretKeyForApp, type AppConfig, type TenantBrand } from '../../config/schema';
import { resolveAppSecret } from '../../config/secret-resolver';
import { setSecret } from '../../config/keystore';
import { validateAppCredentials } from '../../utils/feishu-auth';
import { isServiceRunning } from '../../service/adapter';
import { ensureFleetTables } from '../../fleet/bitable';
import { BitableFleetStorage } from '../../fleet/bitable';
import { SignedFleetStore, validateFleetConfig, type FleetConfig } from '../../fleet/model';

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
  const client = new Client({ appId, appSecret: secret, domain: tenant === 'lark' ? Domain.Lark : Domain.Feishu });
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
    tables: cfg.fleet?.tables ?? { nodes: '', routes: '', commands: '' }, pollMs };
  const pending = 'tblPending';
  validateFleetConfig({ ...identity, tables: { nodes: pending, routes: pending, commands: pending } });
  cfg.fleet = identity;
  await saveConfig(cfg);
  const tables = await ensureFleetTables(client, appToken);
  const config: FleetConfig = { enabled: true, nodeId, name: options.name.trim(), appToken, tables, pollMs };
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
  console.log(JSON.stringify(cfg.fleet ? { enabled: cfg.fleet.enabled, nodeId: cfg.fleet.nodeId,
    name: cfg.fleet.name, pollMs: cfg.fleet.pollMs ?? 15_000, configFile: paths.configFile }
    : { enabled: false, configFile: paths.configFile }, null, 2));
}

export async function runFleetDisable(): Promise<void> {
  if (isServiceRunning()) throw new Error('请先停止本机 Bridge，修改配置后再 start');
  const cfg = await selectedConfig();
  if (!isComplete(cfg)) throw new Error('机器人配置不完整');
  if (cfg.fleet) { cfg.fleet.enabled = false; await saveConfig(cfg); }
  console.log('多电脑配置已关闭。仅在其他节点也已停用后，才以原单机模式连接同一个机器人。');
}
