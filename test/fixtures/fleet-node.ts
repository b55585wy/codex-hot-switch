import { FleetRuntime } from '../../src/fleet/runtime';
import { FleetInbox } from '../../src/fleet/inbox';
import { SignedFleetStore, type FleetConfig, type FleetEvent, type FleetStorage, type FleetTable, type StoredValue } from '../../src/fleet/model';

let serial = 0;
const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
function rpc(method: string, args: unknown[]): Promise<unknown> {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    process.send!({ type: 'storage', id, method, args });
  });
}
const storage: FleetStorage = {
  get: (table, key) => rpc('get', [table, key]) as Promise<StoredValue | undefined>,
  list: (table, target) => rpc('list', [table, target]) as Promise<StoredValue[]>,
  put: (table, row) => rpc('put', [table, row]).then(() => {}),
  remove: (table, key) => rpc('remove', [table, key]).then(() => {}),
};
const input = JSON.parse(process.env.FLEET_SMOKE_CONFIG!) as { nodeId: string; name: string; inbox: string; mac: boolean };
const config: FleetConfig = { enabled: true, nodeId: input.nodeId, name: input.name, appToken: 'appToken12345',
  tables: { nodes: 'tblNodes', routes: 'tblRoutes', commands: 'tblCommands' }, pollMs: 60000 };
const runtime = new FleetRuntime({ config, host: input.name,
  cfg: { accounts: { app: { id: 'test-app', secret: 'fixture', tenant: 'feishu' } },
    preferences: { access: { ownerOpenId: 'ou_owner' } } },
  store: new SignedFleetStore(storage, 'test-app', 'test-fleet-smoke'), inbox: new FleetInbox(input.inbox),
  projects: async () => input.mac ? [{ name: 'project', chatId: 'oc_mac', cwd: '/Users/example/project',
    blank: false, createdAt: 1, ownerNodeId: input.nodeId }] : [],
  migrate: async () => {},
  dispatch: async event => { process.send!({ type: 'dispatched', nodeId: input.nodeId, event }); },
  reply: async (_event, text) => { process.send!({ type: 'notice', text }); },
  picker: async () => {}, onError: error => { process.send!({ type: 'error', message: String(error) }); },
});

process.on('message', (message: unknown) => {
  const data = message as { type: string; id: number; value?: unknown; error?: string; operation?: string; event?: FleetEvent };
  if (data.type === 'storage-result') {
    const pending = waiting.get(data.id); waiting.delete(data.id);
    if (data.error) pending?.reject(new Error(data.error)); else pending?.resolve(data.value);
    return;
  }
  if (data.type !== 'control') return;
  void (async () => {
    if (data.operation === 'receive') await runtime.receive(data.event!);
    if (data.operation === 'tick') await runtime.tick();
    if (data.operation === 'stop') await runtime.shutdown();
    process.send!({ type: 'control-result', id: data.id });
    if (data.operation === 'stop') process.exit(0);
  })().catch(error => process.send!({ type: 'control-result', id: data.id, error: String(error) }));
});
runtime.start().then(() => process.send!({ type: 'ready' })).catch(error => {
  process.send!({ type: 'error', message: String(error) }); process.exit(1);
});
