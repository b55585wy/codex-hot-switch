import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startFleetRelayServer } from './server';
import { startFleetRelayGateway } from './gateway';
import { sanitizeCode, sanitizeMessage } from './protocol';

export interface RelayCliConfig {
  appId: string;
  token: string;
  dataDir: string;
  host: string;
  port: number;
  storageOnly: boolean;
  gateway?: { appSecret: string; tenant: 'feishu' | 'lark'; ownerOpenId: string; admins?: string[] };
}
export const RELAY_CLI_HELP = `Feishu Codex relay server (protocol v1)

Usage:
  relay-server --help
  relay-server [--storage-only]

Secrets are read only from protected files/environment paths, never argv.
Environment:
  CODEX_RELAY_APP_ID              Feishu application id (also the relay namespace)
  CODEX_RELAY_TOKEN_FILE         file containing the relay worker token (>=32 bytes, high entropy)
  CODEX_RELAY_APP_SECRET_FILE    file containing the Feishu app secret (gateway only)
  CODEX_RELAY_OWNER_OPEN_ID     gateway owner open_id
  CODEX_RELAY_ADMINS            comma-separated additional admin open_ids
  CODEX_RELAY_TENANT            feishu (default) or lark
  CODEX_RELAY_GATEWAY_ENABLED   true/false; default enabled when full credentials exist
  CODEX_RELAY_HOST              127.0.0.1 (default) or a private bind address
  CODEX_RELAY_PORT              8787 (default)
  CODEX_RELAY_DATA_DIR          durable state directory

Plain ws:// is allowed only on loopback. Put TLS in front for public access.
--storage-only prepares durable storage and WebSocket intake with the Feishu
gateway disabled. Do not run the cloud gateway beside an old receiver.
`;
const ENV_NAMES = {
  appId: 'CODEX_RELAY_APP_ID', tokenFile: 'CODEX_RELAY_TOKEN_FILE',
  secretFile: 'CODEX_RELAY_APP_SECRET_FILE', owner: 'CODEX_RELAY_OWNER_OPEN_ID',
  admins: 'CODEX_RELAY_ADMINS', tenant: 'CODEX_RELAY_TENANT',
  enabled: 'CODEX_RELAY_GATEWAY_ENABLED', host: 'CODEX_RELAY_HOST',
  port: 'CODEX_RELAY_PORT', dataDir: 'CODEX_RELAY_DATA_DIR',
} as const;

export function parseRelayCliArgs(argv: string[]): { help: boolean; storageOnly: boolean } {
  let help = false;
  let storageOnly = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--storage-only') storageOnly = true;
    // Never echo an unknown argument: it may be a pasted secret such as
    // --token=... or a URL containing one.
    else throw new Error('未知参数。令牌和密钥不接受命令行参数，请使用受保护的环境/文件配置。');
  }
  return { help, storageOnly };
}

function flag(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} 必须是 true 或 false`);
}
async function secret(path: string | undefined, name: string, max = 512, min = 1): Promise<string | undefined> {
  if (!path) return undefined;
  // Bound the read by metadata before loading a potentially huge file.
  const info = await stat(path).catch(() => undefined);
  if (!info) throw new Error(`${name} 文件不可读`);
  if (!info.isFile()) throw new Error(`${name} 必须是普通文件`);
  if (info.size > max + 1) throw new Error(`${name} 文件内容过长`);
  const value = (await readFile(path, 'utf8')).trim();
  if (!value) throw new Error(`${name} 文件为空`);
  if (value.length > max) throw new Error(`${name} 文件内容过长`);
  if (Buffer.byteLength(value, 'utf8') < min) throw new Error(`${name} 内容过短，至少需要 ${min} 字节`);
  if (/[\u0000-\u0020\u007f]/.test(value)) throw new Error(`${name} 不能包含空白或控制字符`);
  return value;
}

export async function loadRelayCliConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<RelayCliConfig | undefined> {
  const args = parseRelayCliArgs(argv);
  if (args.help) return undefined;
  const appId = env[ENV_NAMES.appId]?.trim();
  if (!appId || !/^[A-Za-z0-9_-]{1,128}$/.test(appId)) throw new Error('缺少有效的 CODEX_RELAY_APP_ID');
  const token = await secret(env[ENV_NAMES.tokenFile], 'CODEX_RELAY_TOKEN_FILE', 512, 32);
  if (!token) throw new Error('缺少 CODEX_RELAY_TOKEN_FILE；中继令牌不能通过命令行传入');
  const host = env[ENV_NAMES.host]?.trim() || '127.0.0.1';
  const portText = env[ENV_NAMES.port]?.trim() || '8787';
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('CODEX_RELAY_PORT 无效');
  const dataDir = env[ENV_NAMES.dataDir]?.trim() || join(homedir(), '.feishu-codex-relay');

  const hasGatewayCredentials = Boolean(env[ENV_NAMES.secretFile] || env[ENV_NAMES.owner]);
  const enabledFlag = flag(env[ENV_NAMES.enabled], ENV_NAMES.enabled);
  const gatewayEnabled = !args.storageOnly && (enabledFlag ?? hasGatewayCredentials);
  if (gatewayEnabled) {
    const appSecret = await secret(env[ENV_NAMES.secretFile], 'CODEX_RELAY_APP_SECRET_FILE');
    const ownerOpenId = env[ENV_NAMES.owner]?.trim();
    const tenantText = env[ENV_NAMES.tenant]?.trim().toLowerCase() || 'feishu';
    if (tenantText !== 'feishu' && tenantText !== 'lark') throw new Error('CODEX_RELAY_TENANT 必须是 feishu 或 lark');
    if (!appSecret || !ownerOpenId) {
      throw new Error('中继网关配置不完整：需要 CODEX_RELAY_APP_SECRET_FILE、CODEX_RELAY_OWNER_OPEN_ID 与 CODEX_RELAY_TOKEN_FILE');
    }
    const admins = env[ENV_NAMES.admins]?.split(',').map(value => value.trim()).filter(Boolean);
    return { appId, token, dataDir, host, port, storageOnly: false,
      gateway: { appSecret, tenant: tenantText, ownerOpenId, ...(admins?.length ? { admins } : {}) } };
  }
  if (hasGatewayCredentials && enabledFlag !== false && !args.storageOnly) {
    throw new Error('中继网关配置不完整：请同时提供应用密钥、owner 和启用开关');
  }
  return { appId, token, dataDir, host, port, storageOnly: true };
}

export async function runRelayCli(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = await loadRelayCliConfig(argv, env);
  if (!config) { process.stdout.write(RELAY_CLI_HELP); return; }
  const server = await startFleetRelayServer({ appId: config.appId, token: config.token,
    dataDir: config.dataDir, host: config.host, port: config.port });
  let gateway: Awaited<ReturnType<typeof startFleetRelayGateway>> | undefined;
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (gateway) await gateway.shutdown().catch(() => undefined);
    await server.close().catch(() => undefined);
  };
  try {
    if (config.gateway) {
      gateway = await startFleetRelayGateway({
        appId: config.appId, appSecret: config.gateway.appSecret, tenant: config.gateway.tenant,
        ownerOpenId: config.gateway.ownerOpenId, admins: config.gateway.admins,
        storage: server.storage, dataDir: config.dataDir,
        onState: state => server.setGatewayState(state),
        // Sanitized: never dump raw request credentials/SDK error bodies.
        onError: error => process.stderr.write(
          `relay gateway error (${sanitizeCode(error)}): ${sanitizeMessage(error)}\n`),
      });
    }
    process.stdout.write(`relay server listening at ${server.url}${config.storageOnly ? ' (storage-only, gateway disabled)' : ''}\n`);
    await new Promise<void>(resolve => {
      const stop = (): void => { void shutdown().finally(resolve); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } catch (error) {
    await shutdown();
    throw error;
  }
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void runRelayCli().catch(error => {
    process.stderr.write(`relay server failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
