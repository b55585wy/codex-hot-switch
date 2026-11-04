import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RelayFileStore, relayLockFileName } from '../src/fleet/relay/file-store';
import { RELAY_KEY_CHARS } from '../src/fleet/relay/protocol';
import type { FleetTable, StoredValue } from '../src/fleet/model';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-relay-store-'));
  roots.push(root);
  return root;
}
const row = (key: string, value = 'signed', extra: Partial<StoredValue> = {}): StoredValue =>
  ({ key, value, ...extra });
function lockRecord(token: string, pid: number, startedAt = Date.now()) {
  return JSON.stringify({ token, pid, host: hostname(), startedAt });
}
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  const pid = child.pid!;
  await new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
  return pid;
}
/** Copies the two dependency-free TS modules and runs a real child process. */
async function processRunner(): Promise<{ runner: string; stop: string }> {
  const dir = await directory();
  for (const file of ['file-store.ts', 'protocol.ts']) {
    let source = await readFile(join(process.cwd(), 'src', 'fleet', 'relay', file), 'utf8');
    if (file === 'file-store.ts') source = source.replace("from './protocol'", "from './protocol.ts'");
    await writeFile(join(dir, file), source, 'utf8');
  }
  const stop = join(dir, 'stop');
  const runner = join(dir, 'runner.mjs');
  await writeFile(runner, [
    "import { RelayFileStore } from './file-store.ts';",
    "import { existsSync } from 'node:fs';",
    "try {",
    "  const store = await RelayFileStore.open(process.argv[2], 'app');",
    "  console.log('ACQUIRED');",
    "  while (!existsSync(process.argv[3])) await new Promise(r => setTimeout(r, 20));",
    "  await store.close();",
    "} catch (error) {",
    "  console.log('REJECTED');",
    "  process.exitCode = 2;",
    "}",
  ].join('\n'), 'utf8');
  return { runner, stop };
}
function runChild(runner: string, data: string, stop: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', runner, data, stop], {
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    let stdout = '';
    child.stdout!.on('data', chunk => { stdout += String(chunk); });
    child.once('error', reject);
    child.once('exit', code => resolveRun({ code, stdout }));
  });
}

describe('durable single-writer relay store', () => {
  it('persists node/route/command rows atomically and survives a restart', async () => {
    const dir = await directory();
    const first = await RelayFileStore.open(dir, 'app');
    await first.put('nodes', row('node-a', 'n1'));
    await first.put('routes', row('home', 'r1'));
    await first.put('commands', row('cmd-1', 'c1', { target: 'node-a', expiresAt: Date.now() + 60_000 }));
    // A successful put means the fsynced snapshot already contains the row.
    const onDisk = JSON.parse(await readFile(join(dir, 'relay-state.json'), 'utf8'));
    expect(onDisk.rows.commands).toEqual([expect.objectContaining({ key: 'cmd-1', target: 'node-a' })]);
    await first.close();
    const second = await RelayFileStore.open(dir, 'app');
    expect(await second.get('commands', 'cmd-1')).toMatchObject({ value: 'c1', target: 'node-a' });
    expect(await second.list('routes')).toHaveLength(1);
    await second.close();
  });

  it('serializes CAS: one observed-value winner and absent create is exclusive', async () => {
    const dir = await directory();
    const store = await RelayFileStore.open(dir, 'app');
    await store.put('routes', row('home', 'old'));
    const results = await Promise.all([
      store.compareAndSwap('routes', row('home', 'a'), 'old'),
      store.compareAndSwap('routes', row('home', 'b'), 'old'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(['a', 'b']).toContain((await store.get('routes', 'home'))!.value);
    const creates = await Promise.all([
      store.compareAndSwap('routes', row('new', 'x'), null),
      store.compareAndSwap('routes', row('new', 'y'), null),
    ]);
    expect(creates.filter(Boolean)).toHaveLength(1);
    expect(await store.compareAndSwap('routes', row('home', 'z'), 'missing')).toBe(false);
    await store.close();
  });

  it('cleans expired commands and keeps pending rows across restart', async () => {
    const dir = await directory();
    const store = await RelayFileStore.open(dir, 'app');
    await store.put('commands', row('expired', 'x', { target: 'node-a', expiresAt: Date.now() - 1 }));
    await store.put('commands', row('pending', 'y', { target: 'node-a', expiresAt: Date.now() + 60_000 }));
    await store.cleanup();
    expect(await store.get('commands', 'expired')).toBeUndefined();
    expect(await store.get('commands', 'pending')).toBeDefined();
    await store.close();
    const restarted = await RelayFileStore.open(dir, 'app');
    expect(await restarted.get('commands', 'pending')).toBeDefined();
    await restarted.close();
  });

  it('rejects a second writer and only releases its own lock', async () => {
    const dir = await directory();
    const first = await RelayFileStore.open(dir, 'app');
    await expect(RelayFileStore.open(dir, 'app')).rejects.toThrow(/占用|锁/);
    await first.close();
    const second = await RelayFileStore.open(dir, 'app');
    await second.close();
    const lock = await readFile(join(dir, 'relay-state.lock'), 'utf8').catch(() => 'absent');
    expect(lock).toBe('absent');
  });

  it('fails closed on corrupted or mismatched snapshots without overwriting them', async () => {
    const dir = await directory();
    const broken = await directory();
    await writeFile(join(broken, 'relay-state.json'), '{not-json', 'utf8');
    await expect(RelayFileStore.open(broken, 'app')).rejects.toThrow(/损坏|拒绝/);
    expect(await readFile(join(broken, 'relay-state.json'), 'utf8')).toBe('{not-json');

    const mismatch = await directory();
    await writeFile(join(mismatch, 'relay-state.json'), JSON.stringify({ version: 1, appId: 'other', rows: {} }), 'utf8');
    await expect(RelayFileStore.open(mismatch, 'app')).rejects.toThrow(/格式|不匹配/);
    expect(await readFile(join(mismatch, 'relay-state.json'), 'utf8')).toContain('"other"');
    void dir;
  });

  it('treats hostile keys as data, never filesystem paths', async () => {
    const dir = await directory();
    const store = await RelayFileStore.open(dir, 'app');
    const hostile = '../'.repeat(30) + 'escaped';
    await store.put('routes', row(hostile, 'value'));
    expect(await store.get('routes', hostile)).toMatchObject({ value: 'value' });
    expect(await store.list('routes')).toHaveLength(1);
    await expect(readFile(join(dir, '..', 'escaped'), 'utf8')).rejects.toThrow();
    await store.close();
  });

  it('never evicts a live same-host owner based on old startedAt or age', async () => {
    const dir = await directory();
    const lockPath = join(dir, relayLockFileName);
    await writeFile(lockPath, lockRecord('live-owner', process.pid, Date.now() - 11 * 60_000), 'utf8');
    await expect(RelayFileStore.open(dir, 'app')).rejects.toThrow(/占用|锁/);
    expect(await readFile(lockPath, 'utf8')).toContain('live-owner');
  });

  it('fails closed for foreign/malformed locks instead of guessing ownership', async () => {
    const malformed = await directory();
    await writeFile(join(malformed, relayLockFileName), '{not-json', 'utf8');
    await expect(RelayFileStore.open(malformed, 'app')).rejects.toThrow(/占用|锁/);
    expect(await readFile(join(malformed, relayLockFileName), 'utf8')).toBe('{not-json');

    const foreign = await directory();
    await writeFile(join(foreign, relayLockFileName),
      JSON.stringify({ token: 'foreign', pid: 999999, host: 'another-host', startedAt: 1 }), 'utf8');
    await expect(RelayFileStore.open(foreign, 'app')).rejects.toThrow(/占用|锁/);
    expect(await readFile(join(foreign, relayLockFileName), 'utf8')).toContain('foreign');
  });

  it('recovers a dead same-host lock exactly once under concurrent open', async () => {
    const dir = await directory();
    await writeFile(join(dir, relayLockFileName), lockRecord('dead-owner', await deadPid()), 'utf8');
    const results = await Promise.allSettled([RelayFileStore.open(dir, 'app'), RelayFileStore.open(dir, 'app')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const winner = results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<RelayFileStore>;
    await winner.value.close();
  });

  it('never auto-reclaims an existing recovery guard and preserves it for manual recovery', async () => {
    const dead = await deadPid();
    const stale = await directory();
    const recoveryPath = join(stale, 'relay-state.lock.recovery');
    await writeFile(join(stale, relayLockFileName), lockRecord('dead-owner', dead), 'utf8');
    await writeFile(recoveryPath, lockRecord('dead-reclaimer', dead), 'utf8');
    await expect(RelayFileStore.open(stale, 'app')).rejects.toThrow(/恢复保护文件|占用|锁/);
    expect(await readFile(recoveryPath, 'utf8')).toContain('dead-reclaimer');
    expect(await readFile(join(stale, relayLockFileName), 'utf8')).toContain('dead-owner');

    // Malformed guards are equally untouched; only an operator may remove them.
    const malformed = await directory();
    await writeFile(join(malformed, relayLockFileName), lockRecord('dead-owner', dead), 'utf8');
    await writeFile(join(malformed, 'relay-state.lock.recovery'), '{not-json', 'utf8');
    await expect(RelayFileStore.open(malformed, 'app')).rejects.toThrow(/恢复保护文件|占用|锁/);
    expect(await readFile(join(malformed, 'relay-state.lock.recovery'), 'utf8')).toBe('{not-json');
  });

  it('produces exactly one writer when independent processes recover a dead lock', async () => {
    const dir = await directory();
    await writeFile(join(dir, relayLockFileName), lockRecord('dead-owner', await deadPid()), 'utf8');
    const { runner, stop } = await processRunner();
    const children = [runChild(runner, dir, stop), runChild(runner, dir, stop)];
    // Give both contenders time to attempt acquisition before releasing the winner.
    await new Promise(resolveWait => setTimeout(resolveWait, 900));
    await writeFile(stop, 'stop', 'utf8');
    const results = await Promise.all(children);
    expect(results.filter(result => result.stdout.includes('ACQUIRED'))).toHaveLength(1);
    expect(results.filter(result => result.stdout.includes('REJECTED'))).toHaveLength(1);
  }, 15_000);

  it('validates table/key/encoded size and does not rewrite storage on a lost CAS', async () => {
    const dir = await directory();
    const store = await RelayFileStore.open(dir, 'app');
    await expect(store.put('bogus' as FleetTable, row('k', 'v'))).rejects.toThrow(/数据表/);
    await expect(store.get('routes', '')).rejects.toThrow(/键/);
    // The contract is a 128 KiB raw value; plain content plus the response
    // envelope must round-trip inside a 256 KiB frame.
    const maxPlain = 'a'.repeat(128 * 1024);
    await store.put('routes', row('max-plain', maxPlain));
    expect((await store.get('routes', 'max-plain'))!.value).toBe(maxPlain);
    // Escape expansion is supported up to the hard encoded frame budget.
    const escaped = '"'.repeat(70_000);
    await store.put('routes', row('escaped-ok', escaped));
    expect((await store.get('routes', 'escaped-ok'))!.value).toBe(escaped);
    // Only a row whose escaped JSON cannot fit the hard frame budget is unsafe.
    await expect(store.put('routes', row('escaped-hard', '"'.repeat(130_000)))).rejects.toThrow(/帧预算/);
    await store.put('routes', row('home', 'v1'));
    const before = JSON.parse(await readFile(join(dir, 'relay-state.json'), 'utf8')).updatedAt as number;
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
    expect(await store.compareAndSwap('routes', row('home', 'v2'), 'wrong')).toBe(false);
    const after = JSON.parse(await readFile(join(dir, 'relay-state.json'), 'utf8')).updatedAt as number;
    expect(after).toBe(before);
    await store.close();
  });

  it('enforces the opaque key bound and notifies subscribers after commit', async () => {
    const dir = await directory();
    const store = await RelayFileStore.open(dir, 'app');
    const notices: string[] = [];
    const unsubscribe = store.subscribe(notice => notices.push(notice.type));
    await store.put('commands', row('cmd', 'x', { target: 'node-a' }));
    expect(notices).toContain('commands');
    await expect(store.put('routes', row('k'.repeat(RELAY_KEY_CHARS + 1), 'x'))).rejects.toThrow(/无效/);
    await store.close();
    const reopened = await RelayFileStore.open(dir, 'app');
    await expect(reopened.get('routes', 'k'.repeat(RELAY_KEY_CHARS + 1))).rejects.toThrow(/键/);
    unsubscribe();
    await reopened.close();
  });
});
