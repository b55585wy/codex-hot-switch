import { AppServerClient } from '../agent/codex-appserver/app-server-client';
import { createHash } from 'node:crypto';
import { resolveCodexBin } from '../agent/codex-appserver/locate';
import { spawnProcess } from '../platform/spawn';

export type RuntimeAccount = { type: string; email?: string };

export interface RuntimeAccountClient {
  connect(): Promise<void>;
  request(method: 'account/read', params: { refreshToken: false }, timeoutMs: number): Promise<unknown>;
  close(): Promise<void>;
}

export interface RuntimeClientOptions { bin: string; cwd: string }

export interface RuntimeRestartOptions {
  cwd: string;
  windowsHide: true;
  shell: false;
}

export interface CodexRuntimeDeps {
  cwd: string;
  resolveBin(): string | null;
  createFreshClient(options: RuntimeClientOptions): RuntimeAccountClient | Promise<RuntimeAccountClient>;
  createSharedClient(options: RuntimeClientOptions): RuntimeAccountClient | Promise<RuntimeAccountClient>;
  /** Must close active Bridge sessions as well as its warm/utility clients. */
  closeBridgeOwnedClients(): Promise<void>;
  restartDaemon(bin: string, args: readonly string[], options: RuntimeRestartOptions): Promise<void>;
}

export type CodexRuntimeErrorCode =
  | 'INVALID_ACCOUNT_EMAIL' | 'CODEX_NOT_FOUND' | 'BRIDGE_CLEANUP_REQUIRED'
  | 'FRESH_ACCOUNT_READ_FAILED' | 'FRESH_ACCOUNT_CLOSE_FAILED' | 'FRESH_ACCOUNT_MISMATCH'
  | 'BRIDGE_CLOSE_FAILED' | 'DAEMON_RESTART_FAILED'
  | 'DAEMON_ACCOUNT_READ_FAILED' | 'DAEMON_ACCOUNT_CLOSE_FAILED' | 'DAEMON_ACCOUNT_MISMATCH';

export class CodexRuntimeError extends Error {
  constructor(public readonly code: CodexRuntimeErrorCode, message: string) {
    super(message);
    this.name = 'CodexRuntimeError';
  }
}

type ClientFactory = CodexRuntimeDeps['createFreshClient'];
type ReadStage = 'FRESH' | 'DAEMON';
const RPC_TIMEOUT_MS = 15_000;
const RESTART_TIMEOUT_MS = 30_000;
const RESTART_ARGS = Object.freeze(['app-server', 'daemon', 'restart']);

async function withDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('account operation timeout')), RPC_TIMEOUT_MS);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function normalizeEmail(value: string): string {
  const email = value.trim();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || /[\x00-\x1f\x7f]/.test(email)) {
    throw new CodexRuntimeError('INVALID_ACCOUNT_EMAIL', '目标账号邮箱无效，尚未重启 Codex。');
  }
  return email.toLowerCase();
}

function accountFromResponse(response: unknown): RuntimeAccount {
  if (!response || typeof response !== 'object') throw new Error('invalid account response');
  const account = (response as { account?: unknown }).account;
  if (!account || typeof account !== 'object') throw new Error('missing account');
  const { type, email } = account as { type?: unknown; email?: unknown };
  if (type === 'apiKey' || type === 'amazonBedrock') return { type };
  if (type !== 'chatgpt' || typeof email !== 'string') throw new Error('invalid account');
  return { type, email: normalizeEmail(email) };
}

async function readAccount(options: RuntimeClientOptions, factory: ClientFactory, stage: ReadStage): Promise<RuntimeAccount> {
  let client: RuntimeAccountClient | undefined;
  let readFailed = false;
  try {
    client = await factory(options);
    await withDeadline(client.connect());
    // A fresh server loads the native cache at startup; forcing token refresh could change it.
    return accountFromResponse(await withDeadline(client.request('account/read', { refreshToken: false }, RPC_TIMEOUT_MS)));
  } catch {
    readFailed = true;
    throw new CodexRuntimeError(`${stage}_ACCOUNT_READ_FAILED`, stage === 'FRESH'
      ? '无法通过新 Codex 进程核验账号，尚未重启运行时。'
      : '无法核验共享 Codex 运行时账号，请检查后重试。');
  } finally {
    await closeAccountClient(client, readFailed, stage);
  }
}

async function closeAccountClient(client: RuntimeAccountClient | undefined, readFailed: boolean, stage: ReadStage): Promise<void> {
  if (!client) return;
  try { await withDeadline(client.close()); }
  catch {
    if (!readFailed) throw new CodexRuntimeError(`${stage}_ACCOUNT_CLOSE_FAILED`, '账号核验连接未能关闭，请检查 Codex 进程后重试。');
  }
}

function clientOptions(deps: Partial<CodexRuntimeDeps>): RuntimeClientOptions {
  let bin: string | null = null;
  try { bin = (deps.resolveBin ?? resolveCodexBin)(); }
  catch { /* Do not expose resolver diagnostics in a remote response. */ }
  if (!bin) throw new CodexRuntimeError('CODEX_NOT_FOUND', '未找到 Codex CLI，尚未重启运行时。');
  return { bin, cwd: deps.cwd ?? process.cwd() };
}

function createFreshClient(options: RuntimeClientOptions): RuntimeAccountClient {
  return new AppServerClient({ ...options, clientName: 'feishu-codex-bridge-account-check' });
}

async function createSharedClient(options: RuntimeClientOptions): Promise<RuntimeAccountClient> {
  // The private build copies this helper next to dist/cli.js.
  const modulePath = './bridge-shared-daemon.cjs';
  const helper = await import(modulePath) as {
    createSharedDaemonClient: (base: typeof AppServerClient, options: RuntimeClientOptions) => RuntimeAccountClient;
  };
  return helper.createSharedDaemonClient(AppServerClient, options);
}

async function restartDaemon(bin: string, args: readonly string[], options: RuntimeRestartOptions): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(bin, args, { ...options, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('daemon restart timed out')); }, RESTART_TIMEOUT_MS);
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.once('error', () => finish(new Error('daemon restart failed')));
    child.once('close', code => finish(code === 0 ? undefined : new Error('daemon restart failed')));
  });
}

export type RuntimeAccountIdentity = string | { emailHash: string };
function assertAccount(account: RuntimeAccount, expected: RuntimeAccountIdentity, stage: ReadStage): void {
  const matches = account.email && (typeof expected === 'string' ? account.email === expected
    : createHash('sha256').update(account.email).digest('hex') === expected.emailHash);
  if (account.type === 'chatgpt' && matches) return;
  throw new CodexRuntimeError(`${stage}_ACCOUNT_MISMATCH`, stage === 'FRESH'
    ? '本机 Codex 凭据与目标账号不一致，尚未重启运行时。'
    : '共享 Codex 运行时尚未采用目标账号，身份核验未通过。');
}

function maskedEmail(email: string): string {
  const [local, domain] = email.split('@');
  const initial = local?.match(/[\p{L}\p{N}]/u)?.[0] ?? '';
  return `${initial}***@${domain}`;
}

/** Read only account metadata from a new independent server; never reuse cached pool auth. */
export async function readFreshCodexAccount(deps: Partial<CodexRuntimeDeps> = {}): Promise<RuntimeAccount> {
  return readAccount(clientOptions(deps), deps.createFreshClient ?? createFreshClient, 'FRESH');
}

export async function readDaemonCodexAccount(deps: Partial<CodexRuntimeDeps> = {}): Promise<RuntimeAccount> {
  return readAccount(clientOptions(deps), deps.createSharedClient ?? createSharedClient, 'DAEMON');
}

/**
 * Adopts an already-written native ChatGPT account (daemon restart supported by Codex 0.166).
 * Restart disconnects native frontends and may interrupt turns; persisted histories are retained.
 * This never starts/resumes a thread or kills the independent Bridge service.
 */
export async function restartCodexRuntime(identity: RuntimeAccountIdentity, deps: Partial<CodexRuntimeDeps> = {}): Promise<{
  status: 'verified'; accountType: string; maskedEmail: string;
}> {
  const expected = typeof identity === 'string' ? normalizeEmail(identity) : { emailHash: identity.emailHash?.toLowerCase() };
  if (typeof expected !== 'string' && !/^[0-9a-f]{64}$/.test(expected.emailHash)) {
    throw new CodexRuntimeError('INVALID_ACCOUNT_EMAIL', '目标账号标识无效，尚未重启 Codex。');
  }
  if (!deps.closeBridgeOwnedClients) {
    throw new CodexRuntimeError('BRIDGE_CLEANUP_REQUIRED', '缺少 Bridge 连接清理步骤，尚未重启 Codex。');
  }
  const options = clientOptions(deps);
  assertAccount(await readAccount(options, deps.createFreshClient ?? createFreshClient, 'FRESH'), expected, 'FRESH');
  try { await deps.closeBridgeOwnedClients(); }
  catch { throw new CodexRuntimeError('BRIDGE_CLOSE_FAILED', 'Bridge 旧连接未能全部关闭，尚未重启共享 Codex。'); }
  try {
    await (deps.restartDaemon ?? restartDaemon)(options.bin, RESTART_ARGS, {
      cwd: options.cwd, windowsHide: true, shell: false,
    });
  } catch {
    throw new CodexRuntimeError('DAEMON_RESTART_FAILED', 'Codex 共享运行时重启未确认完成，请检查后重试。');
  }
  const account = await readAccount(options, deps.createSharedClient ?? createSharedClient, 'DAEMON');
  assertAccount(account, expected, 'DAEMON');
  return { status: 'verified', accountType: account.type, maskedEmail: maskedEmail(account.email!) };
}
