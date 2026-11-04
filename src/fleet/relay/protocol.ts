import type { FleetTable, StoredValue } from '../model';

export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_PATH = '/relay/v1';
export const RELAY_TOKEN_MIN_BYTES = 32;
export const RELAY_FRAME_BYTES = 256 * 1024;
export const RELAY_ROW_BYTES = 128 * 1024;
/**
 * Hard escaped-JSON budget for one stored row. The raw value contract is
 * 128 KiB; escape expansion may grow it, but an accepted row plus a response
 * envelope must still fit a 256 KiB frame. The explicit 4 KiB headroom covers
 * the response/request envelope (ids, table, cursor, framing).
 */
export const RELAY_ROW_ENCODED_BYTES = RELAY_FRAME_BYTES - 4 * 1024;
export const RELAY_KEY_CHARS = 256;
export const RELAY_TARGET_CHARS = 256;
export const RELAY_MAX_WORKERS = 32;
export const RELAY_MAX_OBSERVERS = 16;
export const RELAY_MAX_ROWS = 10_000;
export const RELAY_DATA_BYTES = 16 * 1024 * 1024;
export const RELAY_LIST_TARGET_BYTES = 128 * 1024;
export const RELAY_LIST_MAX = 100;
export const RELAY_HELLO_TIMEOUT_MS = 5_000;
export const RELAY_PING_INTERVAL_MS = 30_000;
export const RELAY_RPC_TIMEOUT_MS = 15_000;
export const RELAY_MAX_PENDING_RPC = 64;
export const RELAY_SEND_BUFFER_BYTES = 1024 * 1024;
export const RELAY_ACTIVATE_MIN_INTERVAL_MS = 0;

export const FLEET_TABLES: readonly FleetTable[] = ['nodes', 'routes', 'commands'];
export const RELAY_OPS = ['get', 'list', 'put', 'remove', 'cas', 'activate'] as const;
export type RelayOp = typeof RELAY_OPS[number];

export type RelayRole = 'worker' | 'observer';
export type RelayErrorCode =
  | 'bad_request' | 'unauthorized' | 'forbidden' | 'conflict' | 'not_found'
  | 'too_large' | 'overloaded' | 'expired' | 'internal';

export class RelayProtocolError extends Error {
  constructor(readonly code: RelayErrorCode, message: string) { super(message); }
}

export interface WorkerHello {
  type: 'hello'; version: 1; appId: string; role: 'worker';
  nodeId: string; host: string;
}
export interface ObserverHello {
  type: 'hello'; version: 1; appId: string; role: 'observer';
}
export type RelayHello = WorkerHello | ObserverHello;
export interface RelayReady { type: 'ready'; version: 1; nodes: string[] }
export interface RelayRequest {
  type: 'request'; id: string; op: RelayOp;
  table?: FleetTable; key?: string; row?: StoredValue; target?: string;
  cursor?: string; expectedValue?: string | null;
}
export interface RelayResponse {
  type: 'response'; id: string; ok: true; result: unknown;
}
export interface RelayErrorResponse {
  type: 'response'; id: string; ok: false; error: { code: RelayErrorCode; message: string };
}
export type RelayServerMessage = RelayReady | RelayResponse | RelayErrorResponse
  | { type: 'notice'; kind: 'commands'; target: string }
  | { type: 'notice'; kind: 'presence'; nodes: string[] };

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const NODE_RE = /^[a-f0-9-]{36}$/i;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RelayProtocolError('bad_request', '消息格式无效');
  }
  return value as Record<string, unknown>;
}
function fleetRelayText(value: unknown, max: number, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value)) {
    throw new RelayProtocolError('bad_request', `${label}无效`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new RelayProtocolError('bad_request', `${label}包含控制字符`);
  return value;
}
function isTable(value: unknown): value is FleetTable {
  return typeof value === 'string' && (FLEET_TABLES as readonly string[]).includes(value);
}
function byteLength(value: string): number { return Buffer.byteLength(value, 'utf8'); }

/** Exact JSON-encoded size of a row, including quote/backslash/control escaping. */
export function encodedRowBytes(row: StoredValue): number {
  return byteLength(JSON.stringify(row));
}

export function assertTable(value: unknown): asserts value is FleetTable {
  if (!isTable(value)) throw new RelayProtocolError('bad_request', '数据表无效');
}

export function validateStoredValue(value: unknown): StoredValue {
  const row = record(value);
  const key = fleetRelayText(row.key, RELAY_KEY_CHARS, '记录键');
  if (typeof row.value !== 'string') throw new RelayProtocolError('bad_request', '记录内容无效');
  if (byteLength(row.value) > RELAY_ROW_BYTES) throw new RelayProtocolError('too_large', '记录内容超过 128 KiB');
  let target: string | undefined;
  if (row.target !== undefined && row.target !== '') {
    target = fleetRelayText(row.target, RELAY_TARGET_CHARS, '记录目标');
  }
  let expiresAt: number | undefined;
  if (row.expiresAt !== undefined && row.expiresAt !== 0 && row.expiresAt !== null) {
    if (!Number.isFinite(row.expiresAt) || (row.expiresAt as number) <= 0) {
      throw new RelayProtocolError('bad_request', '记录过期时间无效');
    }
    expiresAt = row.expiresAt as number;
  }
  const candidate: StoredValue = { key, value: row.value,
    ...(target === undefined ? {} : { target }), ...(expiresAt === undefined ? {} : { expiresAt }) };
  // A row is accepted only when its escaped JSON form plus a response envelope
  // fits one 256 KiB frame. The raw value limit above is the binding contract;
  // escape expansion up to the hard frame budget is supported.
  if (encodedRowBytes(candidate) > RELAY_ROW_ENCODED_BYTES) {
    throw new RelayProtocolError('too_large', '记录编码后超过帧预算，无法安全分页');
  }
  return candidate;
}

export function parseHello(value: unknown, appId: string): RelayHello {
  const msg = record(value);
  if (msg.type !== 'hello' || msg.version !== RELAY_PROTOCOL_VERSION) {
    throw new RelayProtocolError('bad_request', '需要协议版本 1 的 hello');
  }
  if (typeof msg.appId !== 'string' || msg.appId !== appId) {
    throw new RelayProtocolError('unauthorized', '应用标识不匹配');
  }
  if (msg.role === 'observer') {
    return { type: 'hello', version: 1, appId, role: 'observer' };
  }
  if (msg.role !== 'worker') throw new RelayProtocolError('bad_request', '连接角色无效');
  if (typeof msg.nodeId !== 'string' || !NODE_RE.test(msg.nodeId)) {
    throw new RelayProtocolError('bad_request', '设备 ID 无效');
  }
  const host = fleetRelayText(msg.host, 128, '电脑标识');
  return { type: 'hello', version: 1, appId, role: 'worker', nodeId: msg.nodeId.toLowerCase(), host };
}

export function parseRequest(value: unknown): RelayRequest {
  const msg = record(value);
  if (msg.type !== 'request') throw new RelayProtocolError('bad_request', '需要 request 消息');
  const id = fleetRelayText(msg.id, 128, '请求 ID');
  if (!ID_RE.test(id)) throw new RelayProtocolError('bad_request', '请求 ID 无效');
  const op = msg.op;
  if (typeof op !== 'string' || !(RELAY_OPS as readonly string[]).includes(op)) {
    throw new RelayProtocolError('bad_request', '操作无效');
  }
  const request: RelayRequest = { type: 'request', id, op: op as RelayOp };
  if (op === 'activate') return request;
  if (!isTable(msg.table)) throw new RelayProtocolError('bad_request', '数据表无效');
  request.table = msg.table;
  if (msg.cursor !== undefined) request.cursor = fleetRelayText(msg.cursor, 512, '分页游标');
  if (msg.target !== undefined) request.target = fleetRelayText(msg.target, RELAY_TARGET_CHARS, '查询目标');
  if (op === 'get' || op === 'remove') request.key = fleetRelayText(msg.key, RELAY_KEY_CHARS, '记录键');
  if (op === 'list') {
    if (msg.key !== undefined) throw new RelayProtocolError('bad_request', 'list 不接受记录键');
  }
  if (op === 'put') {
    if (msg.key !== undefined && msg.key !== record(msg.row).key) {
      throw new RelayProtocolError('bad_request', '记录键与内容不一致');
    }
    request.row = validateStoredValue(msg.row);
  }
  if (op === 'cas') {
    request.row = validateStoredValue(msg.row);
    if (!Object.prototype.hasOwnProperty.call(msg, 'expectedValue')) {
      throw new RelayProtocolError('bad_request', 'CAS 需要 expectedValue');
    }
    if (msg.expectedValue !== null) {
      if (typeof msg.expectedValue !== 'string' || byteLength(msg.expectedValue) > RELAY_ROW_BYTES) {
        throw new RelayProtocolError('bad_request', 'CAS 期望值无效');
      }
      request.expectedValue = msg.expectedValue;
    } else request.expectedValue = null;
  }
  return request;
}

export function encodeCursor(table: FleetTable, key: string): string {
  return Buffer.from(JSON.stringify({ t: table, k: key }), 'utf8').toString('base64url');
}
export function decodeCursor(cursor: string, table: FleetTable): string | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: unknown; k?: unknown };
    if (parsed.t !== table || typeof parsed.k !== 'string' || parsed.k.length > RELAY_KEY_CHARS) {
      throw new Error('mismatch');
    }
    return parsed.k;
  } catch {
    throw new RelayProtocolError('bad_request', '分页游标无效');
  }
}

export function sanitizeMessage(error: unknown): string {
  if (error instanceof RelayProtocolError) return error.message;
  return '中继请求处理失败';
}
export function sanitizeCode(error: unknown): RelayErrorCode {
  return error instanceof RelayProtocolError ? error.code : 'internal';
}

export function isExpired(row: StoredValue, now = Date.now()): boolean {
  return typeof row.expiresAt === 'number' && row.expiresAt > 0 && row.expiresAt <= now;
}

/**
 * Bounded by count and exact encoded byte budget. A single accepted row is
 * always returned even when it alone exceeds the soft target; accepted rows are
 * capped at the hard encoded frame budget, so one such page still fits the
 * 256 KiB frame.
 */
export function pageRows(rows: StoredValue[], table: FleetTable, cursor: string | undefined, now = Date.now()):
{ items: StoredValue[]; cursor?: string } {
  const after = decodeCursor(cursor ?? '', table);
  const sorted = rows.filter(row => !isExpired(row, now)).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const start = after === undefined ? 0 : sorted.findIndex(row => row.key > after);
  const items: StoredValue[] = [];
  let bytes = 0;
  for (let index = start < 0 ? sorted.length : start; index < sorted.length && items.length < RELAY_LIST_MAX; index += 1) {
    const row = sorted[index]!;
    // Count the comma/JSON separator along with the full escaped row.
    const size = encodedRowBytes(row) + 1;
    if (items.length && bytes + size > RELAY_LIST_TARGET_BYTES) break;
    items.push(row); bytes += size;
    if (bytes >= RELAY_LIST_TARGET_BYTES) break;
  }
  const next = start < 0 ? sorted.length : start + items.length;
  return { items, ...(next < sorted.length && items.length ? { cursor: encodeCursor(table, items[items.length - 1]!.key) } : {}) };
}
