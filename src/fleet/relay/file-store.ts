import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import type { FleetStorage, FleetStorageNotice, FleetTable, StoredValue } from '../model';
import {
  FLEET_TABLES, RELAY_DATA_BYTES, RELAY_KEY_CHARS, RELAY_MAX_ROWS, RELAY_TARGET_CHARS,
  assertTable, encodedRowBytes, validateStoredValue,
} from './protocol';

interface RelaySnapshot {
  version: 1;
  appId: string;
  updatedAt: number;
  rows: Record<FleetTable, StoredValue[]>;
}
interface LockRecord { token: string; pid: number; host: string; startedAt: number }

type Rows = Map<FleetTable, Map<string, StoredValue>>;
const STATE_FILE = 'relay-state.json';
const LOCK_FILE = 'relay-state.lock';
const RECOVERY_FILE = 'relay-state.lock.recovery';
const LOCK_TOUCH_MS = 10_000;

function cloneRows(rows: Rows): Rows {
  const copy: Rows = new Map();
  for (const table of FLEET_TABLES) copy.set(table, new Map(
    [...(rows.get(table) ?? new Map()).entries()].map(([key, row]) => [key, { ...row }]),
  ));
  return copy;
}
/** Count actual escaped JSON bytes, never a raw-length undercount. */
function rowBytes(row: StoredValue): number {
  return encodedRowBytes(row);
}
function totalBytes(rows: Rows): number {
  let total = 0;
  for (const table of FLEET_TABLES) for (const row of rows.get(table)?.values() ?? []) total += rowBytes(row);
  return total;
}
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
function bad(message: string, cause?: unknown): Error {
  return new Error(`中继持久化存储${message}`, cause === undefined ? undefined : { cause });
}

/**
 * Durable single-writer store for the cloud relay. All keys are opaque data;
 * the filesystem only ever sees the fixed state/lock/temp file names.
 */
export class RelayFileStore implements FleetStorage {
  private rows: Rows = new Map(FLEET_TABLES.map(table => [table, new Map()]));
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(notice: FleetStorageNotice) => void>();
  private inspector?: (nodeId: string) => boolean;
  private lockToken?: string;
  private lockTimer?: ReturnType<typeof setInterval>;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private closed = false;
  private failure?: Error;

  private constructor(private readonly directory: string, private readonly appId: string) {}

  static async open(directory: string, appId: string): Promise<RelayFileStore> {
    if (!directory || typeof directory !== 'string') throw bad('目录无效');
    if (!appId || typeof appId !== 'string') throw bad('应用标识无效');
    const store = new RelayFileStore(directory, appId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await store.acquireLock();
    try {
      await store.load();
    } catch (error) {
      await store.releaseLock();
      throw error;
    }
    store.cleanupTimer = setInterval(() => {
      void store.cleanup().catch(error => store.recordFailure(error));
    }, 15_000);
    store.cleanupTimer.unref();
    return store;
  }

  private get statePath(): string { return join(this.directory, STATE_FILE); }
  private get lockPath(): string { return join(this.directory, LOCK_FILE); }
  private get recoveryPath(): string { return join(this.directory, RECOVERY_FILE); }

  private recordFailure(error: unknown): Error {
    const failure = error instanceof Error ? error : bad('未知错误', error);
    if (!this.failure) this.failure = failure;
    return this.failure;
  }

  private async acquireLock(): Promise<void> {
    const token = randomUUID();
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const handle = await open(this.lockPath, 'wx', 0o600);
        try {
          const record: LockRecord = { token, pid: process.pid, host: hostname(), startedAt: Date.now() };
          await handle.writeFile(JSON.stringify(record));
          await handle.sync();
        } finally { await handle.close(); }
        this.lockToken = token;
        this.lockTimer = setInterval(() => { void this.touchLock().catch(() => undefined); }, LOCK_TOUCH_MS);
        this.lockTimer.unref();
        return;
      } catch (error) {
        lastError = error;
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw bad('无法建立锁', error);
        const recovery = await this.reclaimWithGuard();
        if (recovery === 'busy') break;
        if (recovery === 'guard') {
          throw bad('检测到未清理的中继锁恢复保护文件 relay-state.lock.recovery；请确认没有进程运行后按运维文档人工恢复');
        }
        // 'removed' retries acquisition; 'not-stale' means a live owner exists.
        if (recovery === 'not-stale') break;
      }
    }
    throw bad('已被另一个进程占用或无法建立锁；若确认无进程运行，请人工检查锁文件', lastError);
  }

  /** Only a definitively dead same-host owner is reclaimable; everything else fails closed. */
  private staleRecord(record: Partial<LockRecord> | undefined): boolean {
    if (!record || typeof record !== 'object') return false;
    if (typeof record.token !== 'string' || !record.token) return false;
    if (typeof record.host !== 'string' || record.host !== hostname()) return false;
    if (!Number.isInteger(record.pid) || (record.pid as number) <= 0) return false;
    // Never age out a same-host PID. startedAt and mtime are diagnostic only.
    if (record.pid === process.pid) return false;
    return !alive(record.pid as number);
  }

  private async reclaimWithGuard(): Promise<'removed' | 'not-stale' | 'busy' | 'guard'> {
    const token = randomUUID();
    let handle;
    try {
      handle = await open(this.recoveryPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return 'busy';
      // Never auto-reclaim an existing recovery guard. Reading and unlinking
      // someone else's guard would recreate the same read/unlink TOCTOU one
      // level up and could delete a live reclaimer's guard. Fail closed to an
      // explicit operator recovery for this rare crash point.
      return 'guard';
    }
    try {
      const guard: LockRecord = { token, pid: process.pid, host: hostname(), startedAt: Date.now() };
      await handle.writeFile(JSON.stringify(guard));
      await handle.sync();
      await handle.close();
      handle = undefined;
      let record: LockRecord;
      try { record = JSON.parse(await readFile(this.lockPath, 'utf8')) as LockRecord; }
      catch { return 'removed'; }
      if (!this.staleRecord(record)) return 'not-stale';
      // Re-read immediately before unlink; the guard prevents other reclaimers
      // from replacing the owner between the check and the unlink.
      const current = JSON.parse(await readFile(this.lockPath, 'utf8')) as LockRecord;
      if (current.token !== record.token) return 'not-stale';
      await unlink(this.lockPath);
      return 'removed';
    } catch {
      return 'not-stale';
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await this.releaseLockFile(this.recoveryPath, token).catch(() => undefined);
    }
  }

  private async releaseLockFile(path: string, token: string): Promise<void> {
    try {
      const current = JSON.parse(await readFile(path, 'utf8')) as LockRecord;
      if (current.token === token) await unlink(path);
    } catch { /* only remove the record we own */ }
  }

  private async touchLock(): Promise<void> {
    if (!this.lockToken || this.closed) return;
    try {
      const current = JSON.parse(await readFile(this.lockPath, 'utf8')) as LockRecord;
      if (current.token !== this.lockToken) return;
      const now = new Date();
      await utimes(this.lockPath, now, now);
    } catch { /* lock handling stays lazy; close is authoritative */ }
  }

  private async releaseLock(): Promise<void> {
    if (this.lockTimer) { clearInterval(this.lockTimer); this.lockTimer = undefined; }
    if (!this.lockToken) return;
    const token = this.lockToken;
    this.lockToken = undefined;
    await this.releaseLockFile(this.lockPath, token);
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      // Reject an oversize snapshot from metadata before reading it into memory.
      const info = await stat(this.statePath);
      if (info.size > RELAY_DATA_BYTES) throw bad('文件超过 16 MiB 上限，拒绝覆盖');
      raw = await readFile(this.statePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      if ((error as Error).message?.includes('16 MiB')) throw error;
      throw bad('读取失败', error);
    }
    if (Buffer.byteLength(raw, 'utf8') > RELAY_DATA_BYTES) throw bad('文件超过 16 MiB 上限，拒绝覆盖');
    let snapshot: RelaySnapshot;
    try { snapshot = JSON.parse(raw) as RelaySnapshot; }
    catch (error) { throw bad('文件已损坏，拒绝覆盖；请从备份恢复', error); }
    if (!snapshot || snapshot.version !== 1 || snapshot.appId !== this.appId
      || !snapshot.rows || typeof snapshot.rows !== 'object') {
      throw bad('快照格式或应用标识不匹配，拒绝覆盖');
    }
    const rows: Rows = new Map(FLEET_TABLES.map(table => [table, new Map()]));
    let bytes = 0;
    for (const table of FLEET_TABLES) {
      const list = snapshot.rows[table];
      if (!Array.isArray(list) || list.length > RELAY_MAX_ROWS) throw bad('快照记录数超出限制，拒绝覆盖');
      for (const item of list) {
        let row: StoredValue;
        try { row = validateStoredValue(item); }
        catch (error) { throw bad('包含无效记录，拒绝覆盖', error); }
        if (!row.key || row.key.length > RELAY_KEY_CHARS) throw bad('包含无效记录键，拒绝覆盖');
        if (rows.get(table)!.has(row.key)) throw bad('包含重复记录键，拒绝覆盖');
        rows.get(table)!.set(row.key, row);
        bytes += rowBytes(row);
      }
    }
    if (bytes > RELAY_DATA_BYTES) throw bad('数据超过 16 MiB 上限，拒绝覆盖');
    this.rows = rows;
  }

  private async persist(rows: Rows): Promise<void> {
    const snapshot: RelaySnapshot = { version: 1, appId: this.appId, updatedAt: Date.now(),
      rows: Object.fromEntries(FLEET_TABLES.map(table => [table,
        [...(rows.get(table)?.values() ?? [])].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(row => ({ ...row }))])) as RelaySnapshot['rows'] };
    if (totalBytes(rows) > RELAY_DATA_BYTES) throw bad('数据超过 16 MiB 上限，未写入');
    const serialized = `${JSON.stringify(snapshot)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > RELAY_DATA_BYTES) {
      throw bad('持久化数据超过 16 MiB 上限，未写入');
    }
    const temporary = join(this.directory, `${STATE_FILE}.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    try {
      await rename(temporary, this.statePath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw bad('原子替换失败，未确认写入', error);
    }
    // Windows cannot fsync a directory handle; best-effort for POSIX durability.
    try { const dir = await open(this.directory, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
    catch { /* platform limitations are not a write failure */ }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async mutate<T>(task: (draft: Rows) => T | Promise<T>): Promise<T> {
    if (this.closed) throw bad('已关闭');
    if (this.failure) throw bad('存储处于失败状态，已拒绝后续写入', this.failure);
    return this.enqueue(async () => {
      if (this.failure) throw bad('存储处于失败状态，已拒绝后续写入', this.failure);
      const draft = cloneRows(this.rows);
      const result = await task(draft);
      try {
        await this.persist(draft);
      } catch (error) {
        // Never acknowledge a mutation whose durable write failed.
        throw this.recordFailure(error);
      }
      this.rows = draft;
      return result;
    });
  }

  private async read<T>(task: (rows: Rows) => T): Promise<T> {
    await this.queue;
    if (this.failure) throw bad('存储处于失败状态，请检查磁盘或数据', this.failure);
    return task(this.rows);
  }

  async get(table: FleetTable, key: string): Promise<StoredValue | undefined> {
    assertTable(table);
    if (typeof key !== 'string' || !key || key.length > RELAY_KEY_CHARS) throw bad('记录键无效');
    return this.read(rows => {
      const row = rows.get(table)?.get(key);
      return row && !(row.expiresAt && row.expiresAt <= Date.now()) ? { ...row } : undefined;
    });
  }

  async list(table: FleetTable, target?: string): Promise<StoredValue[]> {
    assertTable(table);
    if (target !== undefined && (typeof target !== 'string' || !target || target.length > RELAY_TARGET_CHARS)) {
      throw bad('查询目标无效');
    }
    return this.read(rows => [...(rows.get(table)?.values() ?? [])]
      .filter(row => (!target || row.target === target) && !(row.expiresAt && row.expiresAt <= Date.now()))
      .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
      .map(row => ({ ...row })));
  }

  private validated(row: StoredValue): StoredValue {
    try { return validateStoredValue(row); }
    catch (error) {
      if (error instanceof Error && /超过 128 KiB|帧预算/.test(error.message)) throw error;
      throw bad('包含无效记录，未写入', error);
    }
  }

  async put(table: FleetTable, row: StoredValue): Promise<void> {
    assertTable(table);
    const valid = this.validated(row);
    await this.mutate(draft => {
      const tableRows = draft.get(table)!;
      if (!tableRows.has(valid.key) && tableRows.size >= RELAY_MAX_ROWS) throw bad('单表记录数超过 10000 条');
      tableRows.set(valid.key, { ...valid });
    });
    this.notify(table === 'commands' && valid.target ? { type: 'commands', target: valid.target } : { type: 'presence' });
  }

  async remove(table: FleetTable, key: string): Promise<void> {
    assertTable(table);
    if (typeof key !== 'string' || !key || key.length > RELAY_KEY_CHARS || /[\u0000-\u001f\u007f]/.test(key)) {
      throw bad('记录键无效');
    }
    await this.mutate(draft => { draft.get(table)!.delete(key); });
    this.notify({ type: 'presence' });
  }

  async compareAndSwap(table: FleetTable, row: StoredValue, expectedValue: string | null): Promise<boolean> {
    assertTable(table);
    const valid = this.validated(row);
    if (this.closed) throw bad('已关闭');
    if (this.failure) throw bad('存储处于失败状态，已拒绝后续写入', this.failure);
    const changed = await this.enqueue(async () => {
      if (this.failure) throw bad('存储处于失败状态，已拒绝后续写入', this.failure);
      const draft = cloneRows(this.rows);
      const tableRows = draft.get(table)!;
      const existing = tableRows.get(valid.key);
      const matches = expectedValue === null ? !existing : existing?.value === expectedValue;
      // A lost CAS is a read-only outcome; do not rewrite the whole snapshot.
      if (!matches) return false;
      if (!existing && tableRows.size >= RELAY_MAX_ROWS) throw bad('单表记录数超过 10000 条');
      tableRows.set(valid.key, { ...valid });
      try {
        await this.persist(draft);
      } catch (error) {
        throw this.recordFailure(error);
      }
      this.rows = draft;
      return true;
    });
    if (changed) this.notify(table === 'commands' && valid.target ? { type: 'commands', target: valid.target } : { type: 'presence' });
    return changed;
  }

  connect(): Promise<void> { return Promise.resolve(); }

  /** Cheap fail-closed health; never exposes paths, secrets or payloads. */
  health(): { ok: boolean } {
    return { ok: !this.failure };
  }

  subscribe(listener: (notice: FleetStorageNotice) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  isNodeConnected(nodeId: string): boolean {
    return this.inspector ? this.inspector(nodeId) : true;
  }

  /** Server-owned presence map injection for the runtime's offline overlay. */
  setConnectionInspector(inspector: (nodeId: string) => boolean): void {
    this.inspector = inspector;
  }

  notify(notice: FleetStorageNotice): void {
    for (const listener of this.listeners) {
      try { listener(notice); } catch { /* listeners must not break commits */ }
    }
  }

  /** Remove expired rows and persist only when something actually expired. */
  async cleanup(now = Date.now()): Promise<void> {
    if (this.closed) return;
    try {
      await this.enqueue(async () => {
        if (this.failure) throw this.failure;
        const draft = cloneRows(this.rows);
        let changed = false;
        for (const table of FLEET_TABLES) {
          for (const [key, row] of draft.get(table)!) {
            if (row.expiresAt && row.expiresAt > 0 && row.expiresAt <= now) {
              draft.get(table)!.delete(key); changed = true;
            }
          }
        }
        if (!changed) return;
        await this.persist(draft);
        this.rows = draft;
      });
    } catch (error) {
      // Surface a failed background cleanup as fail-closed storage health.
      throw this.recordFailure(error);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = undefined; }
    await this.queue.catch(() => undefined);
    this.listeners.clear();
    await this.releaseLock();
  }
}

export const relayStateFileName = STATE_FILE;
export const relayLockFileName = LOCK_FILE;
