import type { Client } from '@larksuiteoapi/node-sdk';
import { describe, expect, it, vi } from 'vitest';
import { BitableFleetStorage, ensureFleetTables } from '../src/fleet/bitable';

const config = { appToken: 'appToken12345', tables: { nodes: 'tblNodes', routes: 'tblRoutes', commands: 'tblCommands' } };
function client() {
  return { bitable: { appTable: {
    list: vi.fn(async (_args: unknown) => ({ code: 0, data: { items: [] } })),
    create: vi.fn(async (_args: unknown) => ({ code: 0, data: { table_id: 'tblCreated' } })),
  }, appTableRecord: {
    list: vi.fn(async (_args: unknown): Promise<unknown> => ({ code: 0, data: { items: [] } })),
    create: vi.fn(async (_args: unknown) => ({ code: 0, data: { record: { record_id: 'rec1' } } })),
    update: vi.fn(async (_args: unknown) => ({ code: 0 })),
    delete: vi.fn(async (_args: unknown) => ({ code: 0 })),
  } } };
}

describe('Feishu Bitable transport contract', () => {
  it('queries only the target computer and paginates all matching rows', async () => {
    const fake = client();
    fake.bitable.appTableRecord.list.mockResolvedValueOnce({ code: 0, data: {
      items: [{ record_id: 'r1', fields: { key: 'a', data: 'one', target: 'mac' } }], has_more: true, page_token: 'next' } });
    fake.bitable.appTableRecord.list.mockResolvedValueOnce({ code: 0, data: {
      items: [{ record_id: 'r2', fields: { key: [{ text: 'b' }], data: [{ text: 'two' }], target: 'mac' } }] } });
    const store = new BitableFleetStorage(fake as unknown as Client, config);
    expect(await store.list('commands', 'mac')).toMatchObject([{ key: 'a', value: 'one' }, { key: 'b', value: 'two' }]);
    expect(fake.bitable.appTableRecord.list.mock.calls[0]![0]).toMatchObject({ params: { filter: 'CurrentValue.[target]="mac"' } });
    expect(fake.bitable.appTableRecord.list.mock.calls[1]![0]).toMatchObject({ params: { page_token: 'next' } });
  });
  it('uses a stable server idempotency token for create and never retries an uncertain write blindly', async () => {
    const fake = client(); const store = new BitableFleetStorage(fake as unknown as Client, config);
    await store.put('commands', { key: 'same-command', value: '{}' });
    await store.put('commands', { key: 'same-command', value: '{}' });
    const a = fake.bitable.appTableRecord.create.mock.calls[0]![0] as { params: { client_token: string } };
    const b = fake.bitable.appTableRecord.create.mock.calls[1]![0] as typeof a;
    expect(a.params.client_token).toBe(b.params.client_token);
    expect(a.params.client_token).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
    fake.bitable.appTableRecord.create.mockRejectedValueOnce(new Error('connection lost after send'));
    await expect(store.put('commands', { key: 'uncertain', value: '{}' })).rejects.toThrow('connection lost');
    expect(fake.bitable.appTableRecord.create).toHaveBeenCalledTimes(3);
  });
  it('reports permission/rate-limit failures and conflicting duplicate keys', async () => {
    const fake = client(); const store = new BitableFleetStorage(fake as unknown as Client, config);
    fake.bitable.appTableRecord.list.mockResolvedValueOnce({ code: 403, msg: 'permission denied' });
    await expect(store.get('nodes', 'a')).rejects.toThrow('403');
    fake.bitable.appTableRecord.list.mockResolvedValueOnce({ code: 1254290, msg: 'rate limited' });
    await expect(store.list('commands', 'mac')).rejects.toThrow('1254290');
    fake.bitable.appTableRecord.list.mockResolvedValueOnce({ code: 0, data: { items: [
      { fields: { key: 'a', data: 'one' } }, { fields: { key: 'a', data: 'different' } },
    ] } });
    await expect(store.get('routes', 'a')).rejects.toThrow('冲突');
  });
  it('refuses to update or create over duplicate existing keys', async () => {
    const fake = client(); const store = new BitableFleetStorage(fake as unknown as Client, config);
    fake.bitable.appTableRecord.list.mockResolvedValueOnce({ code: 0, data: { items: [
      { record_id: 'r1', fields: { key: 'owned', data: '{"value":"one"}' } },
      { record_id: 'r2', fields: { key: 'owned', data: '{"value":"two"}' } },
    ] } });
    await expect(store.put('routes', { key: 'owned', value: '{"value":"three"}' })).rejects.toThrow('重复键');
    expect(fake.bitable.appTableRecord.update).not.toHaveBeenCalled();
    expect(fake.bitable.appTableRecord.create).not.toHaveBeenCalled();
  });
  it('creates only the dedicated fleet tables with required fields', async () => {
    const fake = client();
    expect(await ensureFleetTables(fake as unknown as Client, config.appToken)).toEqual({ nodes: 'tblCreated', routes: 'tblCreated', commands: 'tblCreated' });
    expect(fake.bitable.appTable.create).toHaveBeenCalledTimes(3);
    expect(fake.bitable.appTable.create.mock.calls[0]![0]).toMatchObject({ data: { table: {
      name: 'Bridge电脑', fields: [{ field_name: 'key', type: 1 }, { field_name: 'data', type: 1 },
        { field_name: 'target', type: 1 }, { field_name: 'expiresAt', type: 2 }],
    } } });
  });
});
