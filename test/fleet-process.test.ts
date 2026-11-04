import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { SignedFleetStore, type FleetEvent, type FleetStorage, type FleetTable, type StoredValue } from '../src/fleet/model';

it('routes and deduplicates across two independent Node processes and local inboxes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-fleet-process-'));
  const children: ChildProcess[] = [];
  const rows = new Map<string, StoredValue>();
  const storage: FleetStorage = {
    get: async (table, key) => rows.get(`${table}:${key}`),
    list: async (table, target) => [...rows].filter(([key, row]) => key.startsWith(`${table}:`) && (!target || target === row.target)).map(([, row]) => row),
    put: async (table, row) => { rows.set(`${table}:${row.key}`, structuredClone(row)); },
    remove: async (table, key) => { rows.delete(`${table}:${key}`); },
  };
  const win = '11111111-1111-4111-8111-111111111111';
  const mac = '22222222-2222-4222-8222-222222222222';
  const store = new SignedFleetStore(storage, 'test-app', 'test-fleet-smoke');
  await store.put('routes', 'home', { nodeId: win });
  const dispatches: Array<{ nodeId: string; event: FleetEvent }> = [];
  const errors: string[] = [];
  let controlId = 0;
  try {
    const worker = join(root, 'worker.cjs');
    await build({ entryPoints: [fileURLToPath(new URL('./fixtures/fleet-node.ts', import.meta.url))],
      outfile: worker, bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent' });
    const start = async (nodeId: string, name: string, isMac: boolean) => {
      const child = spawn(process.execPath, [worker], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env, FLEET_SMOKE_CONFIG: JSON.stringify({ nodeId, name, mac: isMac, inbox: join(root, nodeId) }) } });
      children.push(child);
      const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
      const ready = new Promise<void>((resolveReady, rejectReady) => {
        child.once('error', rejectReady);
        child.on('message', (message: unknown) => {
          const data = message as { type: string; id: number; method: keyof FleetStorage; args: unknown[];
            nodeId: string; event: FleetEvent; error?: string; message?: string };
          if (data.type === 'ready') resolveReady();
          if (data.type === 'dispatched') dispatches.push({ nodeId: data.nodeId, event: data.event });
          if (data.type === 'error') { errors.push(data.message ?? 'unknown'); rejectReady(new Error(data.message)); }
          if (data.type === 'control-result') {
            const waiter = pending.get(data.id); pending.delete(data.id);
            if (data.error) waiter?.reject(new Error(data.error)); else waiter?.resolve();
          }
          if (data.type !== 'storage') return;
          const [table, value] = data.args as [FleetTable, unknown];
          let response: Promise<unknown>;
          if (data.method === 'get') response = storage.get(table, value as string);
          else if (data.method === 'list') response = storage.list(table, value as string | undefined);
          else if (data.method === 'put') response = storage.put(table, value as StoredValue);
          else response = storage.remove(table, value as string);
          void response.then(result => child.send({ type: 'storage-result', id: data.id, value: result }),
            error => child.send({ type: 'storage-result', id: data.id, error: String(error) }));
        });
      });
      await ready;
      return { child, send(operation: string, event?: FleetEvent): Promise<void> {
        const id = ++controlId;
        return new Promise((resolveControl, reject) => {
          pending.set(id, { resolve: resolveControl, reject });
          child.send({ type: 'control', id, operation, event });
        });
      } };
    };
    const windows = await start(win, 'windows', false);
    const macbook = await start(mac, 'wangyidemacbookair', true);
    const event: FleetEvent = { kind: 'message', data: { messageId: 'om_cross_process', chatId: 'oc_mac',
      senderId: 'ou_owner', chatType: 'group', mentionedBot: true, content: 'run project tests' } };
    await windows.send('receive', event); await macbook.send('tick');
    expect(dispatches).toEqual([{ nodeId: mac, event }]);
    await windows.send('receive', event); await macbook.send('tick');
    await macbook.send('receive', event);
    expect(dispatches).toHaveLength(1);
    expect(errors).toEqual([]);
    await Promise.all([windows.send('stop'), macbook.send('stop')]);
  } finally {
    await Promise.all(children.map(child => new Promise<void>(done => {
      if (child.exitCode !== null) { done(); return; }
      child.once('exit', () => done()); child.kill();
    })));
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
