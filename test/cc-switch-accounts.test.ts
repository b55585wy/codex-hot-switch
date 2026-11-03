import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { listAccounts } from '../src/account/cc-switch-accounts';

const testState = vi.hoisted(() => ({home:'', readError:null as NodeJS.ErrnoException | null}));
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  return {...actual, homedir:() => testState.home};
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {...actual, readFile:(...args: Parameters<typeof actual.readFile>) => {
    if (testState.readError) return Promise.reject(testState.readError);
    return actual.readFile(...args);
  }};
});

describe('CC Switch saved Codex account metadata', () => {
  let root: string;
  let file: string;
  const credential = 'fixture credential must never leave the source';
  function account(id: string, email: unknown = 'alice@example.test') {
    return {account_id:id, email, chatgpt_account_id:'fixture-workspace', authenticated_at:123,
      refresh_token:credential, id_token:'fixture identity credential', access_token:'fixture access credential'};
  }
  async function writeStore(value: unknown) {
    await mkdir(join(root, '.cc-switch'), {recursive:true});
    await writeFile(file, JSON.stringify(value));
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bridge-account-metadata-'));
    file = join(root, '.cc-switch', 'codex_oauth_auth.json');
    testState.home = root;
    testState.readError = null;
  });
  afterEach(async () => {
    testState.readError = null;
    expect(resolve(root).startsWith(resolve(tmpdir()) + sep)).toBe(true);
    await rm(root, {recursive:true, force:true});
    vi.restoreAllMocks();
  });

  it('returns only stable short IDs, masked emails and the saved default flag', async () => {
    await writeStore({version:2,accounts:{'local-a':account('local-a'),'local-b':account('local-b','bob@example.test')},default_account_id:'local-b'});
    const rows = await listAccounts(root);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['id','isDefault','maskedEmail']);
      expect(row.id).toMatch(/^ccs-[a-f0-9]{12}$/);
    }
    expect(rows.find(row => row.isDefault)?.maskedEmail).toBe('b***@example.test');
    expect(rows.find(row => !row.isDefault)?.maskedEmail).toBe('a***@example.test');
    const output = JSON.stringify(rows);
    for (const secret of [credential,'fixture identity credential','fixture access credential','alice@example.test','bob@example.test','local-a','local-b','fixture-workspace']) {
      expect(output).not.toContain(secret);
    }
  });

  it('keeps IDs and ordering stable when the source HashMap is reordered', async () => {
    await writeStore({version:2,accounts:{a:account('a'),b:account('b')},default_account_id:'a'});
    const first = await listAccounts(root);
    await writeStore({version:2,accounts:{b:account('b'),a:account('a')},default_account_id:'a'});
    expect(await listAccounts(root)).toEqual(first);
    expect(new Set(first.map(row => row.id)).size).toBe(2);
  });

  it('does not derive account identity from mutable email, credentials or default selection', async () => {
    await writeStore({version:2,accounts:{a:account('a')},default_account_id:'a'});
    const [before] = await listAccounts(root);
    await writeStore({version:2,accounts:{a:{...account('a','renamed@example.test'),refresh_token:'another fixture credential'}},default_account_id:null});
    const [after] = await listAccounts(root);
    expect(after?.id).toBe(before?.id); expect(after?.maskedEmail).toBe('r***@example.test'); expect(after?.isDefault).toBe(false);
  });

  it('uses only the requested fixture home and leaves its file bytes and timestamps unchanged', async () => {
    await writeStore({version:2,accounts:{a:account('a')}});
    const before = await readFile(file), metadata = await stat(file);
    await listAccounts(root);
    expect(await readFile(file)).toEqual(before);
    const after = await stat(file);
    expect(after.mtimeMs).toBe(metadata.mtimeMs); expect(after.size).toBe(metadata.size);
  });

  it('defaults to the isolated fixture home without accessing the real user account store', async () => {
    await writeStore({version:2,accounts:{a:account('a')}});
    expect(await listAccounts()).toEqual(await listAccounts(root));
  });

  it('returns an empty list when the account file is absent without creating directories', async () => {
    expect(await listAccounts(root)).toEqual([]);
    await expect(stat(join(root,'.cc-switch'))).rejects.toMatchObject({code:'ENOENT'});
  });

  it('accepts an empty v2 account store and an omitted or dangling default pointer', async () => {
    await writeStore({version:2,accounts:{}}); expect(await listAccounts(root)).toEqual([]);
    await writeStore({version:2,accounts:{a:account('a')},default_account_id:'missing'});
    expect((await listAccounts(root))[0]?.isDefault).toBe(false);
  });

  it('accepts a UTF-8 BOM from a restored account file', async () => {
    await writeStore({version:2,accounts:{a:account('a')}});
    await writeFile(file, '\uFEFF' + await readFile(file,'utf8'));
    expect(await listAccounts(root)).toHaveLength(1);
  });

  for (const email of [undefined,null,42,{},'invalid','secret-value','a@bad..test','<unsafe>@example.test']) {
    it('does not display malformed or absent email metadata: ' + JSON.stringify(email), async () => {
      await writeStore({version:2,accounts:{a:{...account('a'),email}}});
      expect((await listAccounts(root))[0]?.maskedEmail).toBe('未提供邮箱');
    });
  }

  it('masks single-character and international local parts while normalizing the domain', async () => {
    await writeStore({version:2,accounts:{a:account('a','a@EXAMPLE.TEST'),b:account('b','用户@example.test')}});
    expect((await listAccounts(root)).map(row=>row.maskedEmail).sort()).toEqual(['a***@example.test','用***@example.test'].sort());
  });

  for (const value of [null,[],{}, {version:1,accounts:{}},{version:3,accounts:{}},{version:2,accounts:[]},
    {version:2,accounts:null},{version:2,accounts:{a:null}},{version:2,accounts:{a:account('b')}},
    {version:2,accounts:{' ':account(' ')}},{version:2,accounts:{'a\nb':account('a\nb')}},
    {version:2,accounts:{},default_account_id:{secret:credential}}]) {
    it('rejects unsupported or inconsistent metadata without returning source data: ' + JSON.stringify(value).slice(0,70), async () => {
      await writeStore(value);
      await expect(listAccounts(root)).rejects.toThrow('账号列表格式无效');
    });
  }

  it('never includes malformed source content or its original JSON parser error in the failure', async () => {
    await writeStore({version:2,accounts:{}});
    await writeFile(file, '{"version":2,"accounts":{"a":{"refresh_token":"' + credential);
    const error = await listAccounts(root).then(() => null, value => value as Error);
    expect(error?.message).toContain('账号列表格式无效');
    expect(String(error)).not.toContain(credential); expect(error?.cause).toBeUndefined();
  });

  for (const code of ['EACCES','EPERM','EIO']) {
    it('sanitizes ' + code + ' read failures without leaking paths or credentials', async () => {
      testState.readError = Object.assign(new Error(credential + ' ' + file), {code});
      const error = await listAccounts(root).then(() => null, value => value as Error);
      expect(error?.message).toContain('无法读取 CC Switch 账号列表');
      expect(String(error)).not.toContain(credential); expect(String(error)).not.toContain(root); expect(error?.cause).toBeUndefined();
    });
  }

  it('does not log account or credential data during successful reads', async () => {
    const spies = [vi.spyOn(console,'log'),vi.spyOn(console,'info'),vi.spyOn(console,'warn'),vi.spyOn(console,'error')];
    await writeStore({version:2,accounts:{a:account('a')}}); await listAccounts(root);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
