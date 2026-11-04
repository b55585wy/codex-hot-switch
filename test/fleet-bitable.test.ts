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
  it('retries one proven transient TLS read and succeeds on the second attempt', async () => {
    const fake = client(); const store = new BitableFleetStorage(fake as unknown as Client, config);
    fake.bitable.appTableRecord.list
      .mockRejectedValueOnce(Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'),
        { code: 'ECONNRESET' }))
      .mockResolvedValueOnce({ code: 0, data: { items: [{ fields: { key: 'a', data: 'one', target: 'mac' } }] } });
    vi.useFakeTimers();
    try {
      const pending = store.list('commands', 'mac');
      await vi.advanceTimersByTimeAsync(250);
      await expect(pending).resolves.toMatchObject([{ key: 'a', value: 'one' }]);
      expect(fake.bitable.appTableRecord.list).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('stops at two attempts and reports an indeterminate read without claiming it did not execute', async () => {
    const fake = client(); const store = new BitableFleetStorage(fake as unknown as Client, config);
    fake.bitable.appTableRecord.list
      .mockRejectedValueOnce(Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ETIMEDOUT' }))
      .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    vi.useFakeTimers();
    try {
      const pending = store.get('nodes', 'a');
      const result = expect(pending).rejects.toThrow('当前任务状态未知');
      await vi.advanceTimersByTimeAsync(250);
      await result;
      expect(fake.bitable.appTableRecord.list).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('never retries cancellation, HTTP status, permission, quota or business errors', async () => {
    const failures: Array<[unknown, string]> = [
      [Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' }), 'canceled'],
      [Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } }), '401'],
      [Object.assign(new Error('Request failed with status code 403'), { response: { status: 403 } }), '403'],
      [Object.assign(new Error('Request failed with status code 429'), { response: { status: 429 } }), '429'],
    ];
    for (const [error, text] of failures) {
      const fake = client(); const store = new BitableFleetStorage(fake as unknown as Client, config);
      fake.bitable.appTableRecord.list.mockRejectedValueOnce(error);
      await expect(store.get('nodes', 'a')).rejects.toThrow(text);
      expect(fake.bitable.appTableRecord.list).toHaveBeenCalledTimes(1);
    }
    const quota = client(); const quotaStore = new BitableFleetStorage(quota as unknown as Client, config);
    quota.bitable.appTableRecord.list.mockResolvedValueOnce({ code: 1254290, msg: 'rate limited' });
    await expect(quotaStore.list('commands', 'mac')).rejects.toThrow('1254290');
    expect(quota.bitable.appTableRecord.list).toHaveBeenCalledTimes(1);
    const business = client(); const businessStore = new BitableFleetStorage(business as unknown as Client, config);
    business.bitable.appTableRecord.list.mockResolvedValueOnce({ code: 99991400, msg: 'invalid request' });
    await expect(businessStore.get('nodes', 'a')).rejects.toThrow('99991400');
    expect(business.bitable.appTableRecord.list).toHaveBeenCalledTimes(1);
  });

  it('may retry source lookup reads inside put and remove but never replays a write', async () => {
    const putFake = client(); const putStore = new BitableFleetStorage(putFake as unknown as Client, config);
    putFake.bitable.appTableRecord.list
      .mockRejectedValueOnce(Object.assign(new Error('read reset'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce({ code: 0, data: { items: [] } });
    vi.useFakeTimers();
    try {
      const pending = putStore.put('commands', { key: 'stable', value: '{}' });
      await vi.advanceTimersByTimeAsync(250);
      await pending;
      expect(putFake.bitable.appTableRecord.list).toHaveBeenCalledTimes(2);
      expect(putFake.bitable.appTableRecord.create).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }

    const createFake = client(); const createStore = new BitableFleetStorage(createFake as unknown as Client, config);
    createFake.bitable.appTableRecord.create.mockRejectedValueOnce(Object.assign(new Error('connection lost after send'),
      { code: 'ECONNRESET' }));
    await expect(createStore.put('commands', { key: 'uncertain', value: '{}' })).rejects.toThrow('connection lost');
    expect(createFake.bitable.appTableRecord.create).toHaveBeenCalledTimes(1);

    const updateFake = client(); const updateStore = new BitableFleetStorage(updateFake as unknown as Client, config);
    updateFake.bitable.appTableRecord.list.mockResolvedValueOnce({ code: 0, data: { items: [
      { record_id: 'r1', fields: { key: 'owned', data: '{"value":"one"}' } }] } });
    updateFake.bitable.appTableRecord.update.mockRejectedValueOnce(Object.assign(new Error('update reset'), { code: 'ECONNRESET' }));
    await expect(updateStore.put('routes', { key: 'owned', value: '{"value":"two"}' })).rejects.toThrow('update reset');
    expect(updateFake.bitable.appTableRecord.update).toHaveBeenCalledTimes(1);

    const deleteFake = client(); const deleteStore = new BitableFleetStorage(deleteFake as unknown as Client, config);
    deleteFake.bitable.appTableRecord.list.mockResolvedValueOnce({ code: 0, data: { items: [
      { record_id: 'r1', fields: { key: 'old', data: '{}' } }] } });
    deleteFake.bitable.appTableRecord.delete.mockRejectedValueOnce(Object.assign(new Error('delete reset'), { code: 'ECONNRESET' }));
    await expect(deleteStore.remove('commands', 'old')).rejects.toThrow('delete reset');
    expect(deleteFake.bitable.appTableRecord.delete).toHaveBeenCalledTimes(1);
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
