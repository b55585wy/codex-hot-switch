import type { Client } from '@larksuiteoapi/node-sdk';
import type { FleetConfig, FleetStorage, FleetTable, StoredValue } from './model';
import { digest } from './model';

type Row = { record_id?: string; fields?: Record<string, unknown> };
const TABLE_NAMES = { nodes: 'Bridge电脑', routes: 'Bridge路由', commands: 'Bridge指令' } as const;

function checkFleetResponse<T extends { code?: number; msg?: string }>(response: T): T {
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(`多电脑共享表请求失败（${response.code}）：${response.msg ?? '未知错误'}`);
  }
  return response;
}

function fleetCellText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(v => typeof v === 'string' ? v : (v as { text?: string })?.text ?? '').join('');
  return '';
}

function decodeFleetRow(row: Row): StoredValue {
  return { key: fleetCellText(row.fields?.key), value: fleetCellText(row.fields?.data), target: fleetCellText(row.fields?.target),
    expiresAt: Number(row.fields?.expiresAt ?? 0) };
}

function fleetBitableFilter(field: string, value: string): string {
  return `CurrentValue.[${field}]=${JSON.stringify(value)}`;
}

export class BitableFleetStorage implements FleetStorage {
  constructor(private readonly client: Client, private readonly config: Pick<FleetConfig, 'appToken' | 'tables'>) {}

  private async rows(table: FleetTable, expression?: string): Promise<Row[]> {
    const rows: Row[] = [];
    let page: string | undefined;
    do {
      const response = checkFleetResponse(await this.client.bitable.appTableRecord.list({
        path: { app_token: this.config.appToken, table_id: this.config.tables[table] },
        params: { page_size: 100, ...(expression ? { filter: expression } : {}), ...(page ? { page_token: page } : {}) },
      }));
      rows.push(...(response.data?.items ?? []));
      page = response.data?.has_more ? response.data.page_token : undefined;
      if (rows.length > 10_000) throw new Error('多电脑数据表记录过多，请先清理过期指令');
    } while (page);
    return rows;
  }

  async get(table: FleetTable, key: string): Promise<StoredValue | undefined> {
    const rows = await this.rows(table, fleetBitableFilter('key', key));
    if (rows.length > 1 && new Set(rows.map(r => fleetCellText(r.fields?.data))).size > 1) {
      throw new Error('多电脑共享目录存在冲突记录，未执行操作');
    }
    return rows[0] ? decodeFleetRow(rows[0]) : undefined;
  }

  async list(table: FleetTable, target?: string): Promise<StoredValue[]> {
    return (await this.rows(table, target ? fleetBitableFilter('target', target) : undefined)).map(decodeFleetRow);
  }

  async put(table: FleetTable, row: StoredValue): Promise<void> {
    const path = { app_token: this.config.appToken, table_id: this.config.tables[table] };
    const fields = { key: row.key, data: row.value, target: row.target ?? '', expiresAt: row.expiresAt ?? 0 };
    const existing = await this.rows(table, fleetBitableFilter('key', row.key));
    if (existing.length > 1) throw new Error('多电脑共享目录存在重复键，未覆盖记录');
    if (existing[0]?.record_id) {
      checkFleetResponse(await this.client.bitable.appTableRecord.update({ path: { ...path, record_id: existing[0].record_id }, data: { fields } }));
      return;
    }
    // Stable create idempotency token prevents duplicate records after uncertain transport failures.
    const hash = digest({ table: path.table_id, key: row.key });
    const clientToken = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    checkFleetResponse(await this.client.bitable.appTableRecord.create({ path, params: { client_token: clientToken }, data: { fields } }));
  }

  async remove(table: FleetTable, key: string): Promise<void> {
    const rows = await this.rows(table, fleetBitableFilter('key', key));
    for (const row of rows) {
      if (!row.record_id) continue;
      checkFleetResponse(await this.client.bitable.appTableRecord.delete({
        path: { app_token: this.config.appToken, table_id: this.config.tables[table], record_id: row.record_id },
      }));
    }
  }
}

export async function ensureFleetTables(client: Client, appToken: string): Promise<FleetConfig['tables']> {
  const ids = {} as FleetConfig['tables'];
  let page: string | undefined;
  const known = new Map<string, string>();
  do {
    const response = checkFleetResponse(await client.bitable.appTable.list({ path: { app_token: appToken },
      params: { page_size: 100, ...(page ? { page_token: page } : {}) } }));
    for (const table of response.data?.items ?? []) {
      if (table.name && table.table_id) known.set(table.name, table.table_id);
    }
    page = response.data?.has_more ? response.data.page_token : undefined;
  } while (page);
  for (const kind of Object.keys(TABLE_NAMES) as FleetTable[]) {
    const found = known.get(TABLE_NAMES[kind]);
    if (found) { ids[kind] = found; continue; }
    const response = checkFleetResponse(await client.bitable.appTable.create({ path: { app_token: appToken }, data: {
      table: { name: TABLE_NAMES[kind], default_view_name: '全部', fields: [
        { field_name: 'key', type: 1 }, { field_name: 'data', type: 1 },
        { field_name: 'target', type: 1 }, { field_name: 'expiresAt', type: 2 },
      ] },
    } }));
    const id = response.data?.table_id;
    if (!id) throw new Error('创建多电脑共享表未返回 ID');
    ids[kind] = id;
  }
  return ids;
}
