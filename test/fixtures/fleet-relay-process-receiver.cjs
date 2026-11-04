// Independent acceptance receiver. All identities and credentials are test-only.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { FleetRelayClient, RelayWorker, FleetRuntime, FleetInbox, SignedFleetStore } = require(process.env.RELAY_QA_LIBRARY);
const appId = 'cli_process_acceptance';
const secret = 'process-acceptance-signing-secret';
const nodeId = '81818181-8181-4181-8181-818181818181';
const url = process.env.RELAY_QA_URL;
const token = readFileSync(process.env.RELAY_QA_TOKEN_FILE, 'utf8');
const client = new FleetRelayClient({ url, token, appId, nodeId, host: 'process-acceptance-worker', role: 'worker' });
const store = new SignedFleetStore(client, appId, secret);
const config = { enabled: true, nodeId, name: 'Process QA', appToken: '',
  tables: { nodes: '', routes: '', commands: '' }, pollMs: 60000, transport: 'relay',
  relay: { url, tokenSecretId: 'test-only' } };
const cfg = { accounts: { app: { id: appId, secret, tenant: 'feishu' } },
  preferences: { access: { ownerOpenId: 'ou_acceptance' } }, fleet: config };
const send = value => { if (process.connected) process.send(value); };
const runtime = new FleetRuntime({ config, cfg, host: 'process-acceptance-worker', store,
  inbox: new FleetInbox(join(process.env.RELAY_QA_DATA, 'inbox')),
  projects: async () => [], migrate: async () => {}, picker: async () => {},
  dispatch: async event => { send({ type: 'event', event }); },
  reply: async () => { send({ type: 'reply' }); }, onError: () => { send({ type: 'control-error' }); } });
const worker = new RelayWorker({ client, runtime, store, migrate: async () => {}, onError: () => send({ type: 'worker-error' }) });
let reconnects = 0;
client.subscribe(notice => {
  if (notice.type === 'reconnected') reconnects += 1;
  if (notice.type === 'presence' && reconnects && client.isNodeConnected(nodeId)) send({ type: 'reconnected-active', reconnects });
});
let stopping = false;
process.on('message', async message => {
  if (message?.type !== 'stop' || stopping) return;
  stopping = true;
  worker.stop();
  await runtime.shutdown().catch(() => {});
  await client.close();
  if (process.connected) process.send({ type: 'stopped' }, () => process.exit(0));
  else process.exit(0);
});
worker.start().then(() => send({ type: 'ready', pid: process.pid, nodeId })).catch(() => {
  send({ type: 'fatal' }); process.exitCode = 1;
});
