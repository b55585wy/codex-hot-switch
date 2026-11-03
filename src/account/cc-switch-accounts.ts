import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CcSwitchAccountSummary {
  id: string;
  maskedEmail: string;
  isDefault: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidStore(): Error {
  return new Error('CC Switch 账号列表格式无效，请在 CC Switch 中检查保存的账号。');
}

function maskEmail(value: unknown): string {
  if (typeof value !== 'string') return '未提供邮箱';
  const match = /^([\p{L}\p{N}])[\p{L}\p{N}._%+-]*@([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)$/u.exec(value.trim());
  if (!match || match[2]!.includes('..')) return '未提供邮箱';
  return `${match[1]}***@${match[2]!.toLowerCase()}`;
}

/** Metadata only: source records and credential fields must never leave this adapter. */
export async function listAccounts(home = homedir()): Promise<CcSwitchAccountSummary[]> {
  let text: string;
  try {
    text = await readFile(join(home, '.cc-switch', 'codex_oauth_auth.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('无法读取 CC Switch 账号列表，请检查本机文件访问权限。');
  }
  let store: unknown;
  try { store = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw invalidStore(); }
  if (!isObject(store) || store.version !== 2 || !isObject(store.accounts)) throw invalidStore();
  if (store.default_account_id != null && typeof store.default_account_id !== 'string') throw invalidStore();
  const summaries: CcSwitchAccountSummary[] = [];
  const ids = new Set<string>();
  for (const [key, account] of Object.entries(store.accounts)) {
    if (!isObject(account) || typeof account.account_id !== 'string' || account.account_id !== key ||
      !key.trim() || key !== key.trim() || /[\x00-\x1f\x7f]/.test(key)) throw invalidStore();
    const id = 'ccs-' + createHash('sha256').update('cc-switch/codex-account/v1\0').update(key).digest('hex').slice(0, 12);
    if (ids.has(id)) throw invalidStore();
    ids.add(id);
    summaries.push({id, maskedEmail:maskEmail(account.email), isDefault:key === store.default_account_id});
  }
  return summaries.sort((left, right) => left.id.localeCompare(right.id));
}
