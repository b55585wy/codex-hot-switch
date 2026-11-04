import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const FLEET_PROTOCOL = 1;
export const ONLINE_MS = 90_000;
export const COMMAND_TTL_MS = 10 * 60_000;
export const MAX_EVENT_BYTES = 48 * 1024;

export interface FleetConfig {
  enabled: boolean;
  nodeId: string;
  name: string;
  appToken: string;
  tables: { nodes: string; routes: string; commands: string };
  pollMs?: number;
}
export interface FleetNode {
  id: string;
  name: string;
  protocol: number;
  seenAt: number;
  host: string;
}
export type FleetKind = 'message' | 'cardAction' | 'reaction' | 'comment' | 'botAdded' | 'botRemoved' | 'botMenu';
export interface FleetEvent { kind: FleetKind; data: Record<string, unknown> }
export interface FleetCommand {
  id: string;
  appId: string;
  source: string;
  target: string;
  createdAt: number;
  expiresAt: number;
  event: FleetEvent;
}
export type FleetTable = 'nodes' | 'routes' | 'commands';
export interface StoredValue { key: string; value: string; target?: string; expiresAt?: number }
export interface FleetStorage {
  get(table: FleetTable, key: string): Promise<StoredValue | undefined>;
  list(table: FleetTable, target?: string): Promise<StoredValue[]>;
  put(table: FleetTable, row: StoredValue): Promise<void>;
  remove(table: FleetTable, key: string): Promise<void>;
}

export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter(k => record[k] !== undefined)
    .map(k => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`;
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export class SignedFleetStore {
  constructor(readonly storage: FleetStorage, readonly appId: string, private readonly secret: string) {}

  proof(value: unknown): string {
    return createHmac('sha256', this.secret).update(`bridge-fleet-v1\0${this.appId}\0${canonical(value)}`).digest('hex');
  }

  matches(value: unknown, proof: unknown): boolean {
    if (typeof proof !== 'string' || !/^[a-f0-9]{64}$/.test(proof)) return false;
    return timingSafeEqual(Buffer.from(this.proof(value), 'hex'), Buffer.from(proof, 'hex'));
  }

  decode<T>(table: FleetTable, row: StoredValue): T {
    const signed = JSON.parse(row.value) as { value: T; proof: string };
    if (!this.matches({ table, key: row.key, value: signed.value }, signed.proof)) {
      throw new Error('多电脑共享记录来源校验失败，未执行操作');
    }
    return signed.value;
  }

  async get<T>(table: FleetTable, key: string): Promise<T | undefined> {
    const row = await this.storage.get(table, key);
    return row ? this.decode<T>(table, row) : undefined;
  }

  async list<T>(table: FleetTable, target?: string): Promise<T[]> {
    const rows = await this.storage.list(table, target);
    return rows.map(row => this.decode<T>(table, row));
  }

  async put(table: FleetTable, key: string, value: unknown, target?: string, expiresAt?: number): Promise<void> {
    const payload = { value, proof: this.proof({ table, key, value }) };
    await this.storage.put(table, { key, value: canonical(payload), target, expiresAt });
  }
}

export function eventActor(event: FleetEvent): string {
  if (event.kind === 'message') return String(event.data.senderId ?? '');
  const operator = event.data.operator as { openId?: string } | undefined;
  return operator?.openId ?? String(event.data.openId ?? '');
}

export function validEvent(event: FleetEvent): boolean {
  if (!event || !event.data || typeof event.data !== 'object' || !eventActor(event)) return false;
  if (Buffer.byteLength(canonical(event)) > MAX_EVENT_BYTES) return false;
  const d = event.data;
  switch (event.kind) {
    case 'message': return typeof d.messageId === 'string' && typeof d.chatId === 'string'
      && typeof d.content === 'string' && (d.chatType === 'p2p' || d.chatType === 'group');
    case 'cardAction': return typeof d.messageId === 'string' && typeof d.chatId === 'string'
      && !!d.action && typeof d.action === 'object';
    case 'reaction': return typeof d.messageId === 'string' && typeof d.emojiType === 'string'
      && (d.action === 'added' || d.action === 'removed');
    case 'comment': return typeof d.fileToken === 'string' && typeof d.fileType === 'string'
      && typeof d.commentId === 'string';
    case 'botAdded': case 'botRemoved': return typeof d.chatId === 'string';
    case 'botMenu': return typeof d.eventKey === 'string';
    default: return false;
  }
}

export function commandId(event: FleetEvent, target: string): string {
  // Card render tokens and selected values distinguish real subsequent clicks.
  return digest({ target, kind: event.kind, data: event.data });
}

export function isOnline(node: FleetNode, now = Date.now()): boolean {
  // seenAt=0 is the explicit offline marker; never infer liveness from clock skew.
  if (!node || typeof node !== 'object' || !Number.isFinite(now)) return false;
  if (typeof node.id !== 'string' || !node.id) return false;
  if (typeof node.name !== 'string' || !node.name.trim() || node.name.length > 32) return false;
  if (node.protocol !== FLEET_PROTOCOL) return false;
  if (!Number.isFinite(node.seenAt) || node.seenAt <= 0) return false;
  return node.seenAt <= now + 30_000 && now - node.seenAt <= ONLINE_MS;
}

export function validateFleetConfig(cfg: FleetConfig): void {
  if (!/^[a-f0-9-]{36}$/i.test(cfg.nodeId)) throw new Error('多电脑配置缺少有效设备 ID');
  if (!cfg.name?.trim() || cfg.name.length > 32) throw new Error('电脑名应为 1–32 个字符');
  if (!/^[a-zA-Z0-9]+$/.test(cfg.appToken)) throw new Error('多维表格 app token 无效');
  if (!cfg.tables || !(['nodes', 'routes', 'commands'] as const).every(key => /^tbl[a-zA-Z0-9]+$/.test(cfg.tables[key] ?? ''))) {
    throw new Error('多电脑配置缺少有效数据表 ID');
  }
  if (cfg.pollMs !== undefined && (!Number.isFinite(cfg.pollMs) || cfg.pollMs < 5_000 || cfg.pollMs > 60_000)) {
    throw new Error('多电脑轮询间隔必须在 5–60 秒之间');
  }
}
