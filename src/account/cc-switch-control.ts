import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, lstat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnProcess } from '../platform/spawn';

export class CcSwitchControlError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'CcSwitchControlError'; }
}
export interface ControlResult { ready: true; accountCode?: string; maskedEmail?: string; emailHash?: string }
export interface ControlOptions {
  home?: string;
  now?: () => number;
  nonce?: () => string;
  launch?: (url: string) => Promise<void>;
  wait?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}
const ACCOUNT = /^ccs-[0-9a-f]{12}$/;
const NONCE = /^[0-9a-f]{32}$/;
const KNOWN_ERRORS = new Set(['account_not_found', 'provider_not_found', 'provider_ambiguous',
  'provider_switch_failed', 'invalid_request', 'expired_request', 'replayed_request', 'account_store_unavailable', 'account_identity_unavailable',
  'replay', 'control_unavailable', 'app_not_ready', 'account_ambiguous', 'reauth_required', 'provider_not_bound', 'provider_read_failed', 'activation_failed']);

function sign(payload: string, key: Buffer): string {
  return createHmac('sha256', key).update(payload).digest('hex');
}
async function launchControl(url: string): Promise<void> {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(command, args, { windowsHide: true, shell: false, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new CcSwitchControlError('launch_failed')); }, 10000);
    child.once('error', () => { clearTimeout(timer); reject(new CcSwitchControlError('launch_failed')); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new CcSwitchControlError('launch_failed')); });
  });
}
async function keyAt(directory: string, create: boolean): Promise<Buffer> {
  const file = join(directory, 'key');
  if (create) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(randomBytes(32)); await handle.sync(); } finally { await handle.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new CcSwitchControlError('key_unavailable'); }
  }
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid');
    const key = await readFile(file);
    if (key.length !== 32) throw new Error('invalid');
    return key;
  } catch (error) {
    throw new CcSwitchControlError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'setup_required' : 'key_unavailable');
  }
}
function decodeResponse(raw: string, key: Buffer, nonce: string, accountCode: string | undefined, now: number): ControlResult {
  try {
    const envelope = JSON.parse(raw);
    if (typeof envelope.payload !== 'string' || !/^[0-9a-f]{64}$/.test(envelope.signature)) throw new Error();
    if (!timingSafeEqual(Buffer.from(envelope.signature, 'hex'), Buffer.from(sign(envelope.payload, key), 'hex'))) throw new Error();
    const result = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'));
    if (result.version !== 1 || result.nonce !== nonce || !Number.isFinite(result.issuedAt) || Math.abs(now - result.issuedAt) > 120000) throw new Error();
    if (result.ok !== true) throw new CcSwitchControlError(KNOWN_ERRORS.has(result.error) ? result.error : 'adapter_failed');
    if (accountCode && result.accountCode !== accountCode) throw new Error();
    if (accountCode && (typeof result.emailHash !== 'string' || !/^[0-9a-f]{64}$/.test(result.emailHash))) throw new Error();
    return { ready: true, ...(accountCode ? { accountCode } : {}),
      ...(accountCode ? { emailHash: result.emailHash as string } : {}),
      ...(typeof result.maskedEmail === 'string' ? { maskedEmail: result.maskedEmail.slice(0, 100) } : {}) };
  } catch (error) {
    if (error instanceof CcSwitchControlError) throw error;
    throw new CcSwitchControlError('untrusted_response');
  }
}
export function createCcSwitchControl(options: ControlOptions = {}) {
  const directory = join(options.home ?? homedir(), '.cc-switch', 'bridge-control');
  const now = options.now ?? Date.now;
  async function request(operation: 'status' | 'activate', accountCode?: string, createKey = false): Promise<ControlResult> {
    if (accountCode !== undefined && !ACCOUNT.test(accountCode)) throw new CcSwitchControlError('invalid_account');
    const nonce = options.nonce?.() ?? randomBytes(16).toString('hex');
    if (!NONCE.test(nonce)) throw new CcSwitchControlError('invalid_request');
    const key = await keyAt(directory, createKey);
    const payload = Buffer.from(JSON.stringify({ version: 1, operation, nonce, issuedAt: now(),
      ...(accountCode ? { accountCode } : {}) })).toString('base64url');
    const url = `ccswitch://v1/bridge?payload=${payload}&signature=${sign(payload, key)}`;
    const responseFile = join(directory, 'responses', nonce + '.json');
    await (options.launch ?? launchControl)(url);
    const deadline = now() + (options.timeoutMs ?? (operation === 'activate' ? 120000 : 15000));
    while (now() < deadline) {
      try {
        const raw = await readFile(responseFile, 'utf8');
        if (Buffer.byteLength(raw) > 8192) throw new CcSwitchControlError('untrusted_response');
        const result = decodeResponse(raw, key, nonce, accountCode, now());
        await unlink(responseFile).catch(() => undefined);
        return result;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await (options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(200);
    }
    throw new CcSwitchControlError('adapter_timeout');
  }
  return {
    setup: () => request('status', undefined, true),
    activate: (accountCode: string) => request('activate', accountCode),
    check: (accountCode?: string) => request('status', accountCode),
  };
}
