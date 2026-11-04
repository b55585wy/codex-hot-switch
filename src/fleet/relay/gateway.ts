import { createHash } from 'node:crypto';
import { createLarkChannel, Domain, type CardActionEvent, type CommentEvent,
  type LarkChannel, type Logger, type NormalizedMessage, type ReactionEvent } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../../config/schema';
import { SignedFleetStore, digest, eventActor, type FleetEvent, type FleetStorage } from '../model';
import { FleetRuntime } from '../runtime';
import { createFleetPicker } from '../picker';
import type { GatewayState } from './server';

export interface FleetRelayGatewayOptions {
  appId: string;
  appSecret: string;
  tenant: 'feishu' | 'lark';
  ownerOpenId: string;
  admins?: string[];
  storage: FleetStorage;
  dataDir: string;
  onError?: (error: unknown) => void;
  onState?: (state: GatewayState) => void;
  /** Test injection; the production path constructs its own native channel. */
  channel?: LarkChannel;
}
export interface FleetRelayGateway {
  nodeId: string;
  /** Frozen gateway API. */
  close(): Promise<void>;
  /** Compatibility alias for close(). */
  shutdown(): Promise<void>;
}

/** Deterministic, non-executable gateway identity derived from the app only. */
export function relayGatewayIdentity(appId: string): { nodeId: string; host: string } {
  const hex = createHash('sha256').update(`feishu-codex-relay-gateway\0${appId}`).digest('hex');
  return {
    nodeId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
    host: digest({ relayGateway: appId }),
  };
}

/** Static SDK diagnostics never echo raw logger arguments. */
const SDK_LOG_ERROR = '飞书中继网关 SDK error 日志已脱敏（未包含原始参数）';
/** Only public SDK error codes may be surfaced; everything else is discarded. */
const SDK_ERROR_CODES = new Set([
  'format_error', 'target_revoked', 'rate_limited', 'permission_denied',
  'upload_failed', 'ssrf_blocked', 'send_timeout', 'not_connected', 'unknown',
]);

/**
 * Only a bounded public error code may cross the SDK boundary. Raw messages,
 * URLs, headers, request bodies and credentials are deliberately discarded.
 */
function sanitizedSdkError(error: unknown, label = '错误'): Error {
  let code: string | undefined;
  try {
    if (error && typeof error === 'object') {
      const candidate = (error as { code?: unknown }).code;
      if (typeof candidate === 'string' && SDK_ERROR_CODES.has(candidate)) code = candidate;
    }
  } catch { /* hostile getters are treated as an unknown code */ }
  const safe = new Error(`飞书中继网关 SDK ${label}${code ? `（${code}）` : ''}`);
  safe.name = 'RelayGatewaySdkError';
  return safe;
}

/**
 * Cloud Feishu receiver. It forwards the seven native event shapes into the
 * durable relay directory and never imports or invokes a model/backend/task.
 */
export async function startFleetRelayGateway(options: FleetRelayGatewayOptions): Promise<FleetRelayGateway> {
  if (!options?.appId || !options.appSecret || !options.ownerOpenId) throw new Error('中继网关缺少飞书应用或管理员配置');
  if (options.tenant !== 'feishu' && options.tenant !== 'lark') throw new Error('中继网关租户配置无效');
  const identity = relayGatewayIdentity(options.appId);
  const onError = options.onError ?? (() => undefined);
  // User callbacks must never break the SDK/receiver lifecycle.
  const report = (error: unknown): void => {
    try { onError(error); } catch { /* best effort */ }
  };
  const emitState = (state: GatewayState): void => {
    try { options.onState?.(state); } catch (error) { report(error); }
  };
  let active = true;   // callbacks may publish state until teardown starts
  let running = false; // only a successfully started gateway reacts to reconnects
  const setState = (state: GatewayState): void => {
    if (!active) return;
    emitState(state);
  };
  // The SDK's default logger can print credential-bearing request objects.
  // This logger ignores every argument and only emits bounded static text.
  const sdkLogger: Logger = {
    error: () => {
      const safe = new Error(SDK_LOG_ERROR);
      safe.name = 'RelayGatewaySdkError';
      report(safe);
    },
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
  };
  let ownedChannel = false;
  let channel = options.channel;
  if (!channel) {
    channel = createLarkChannel({
      appId: options.appId,
      appSecret: options.appSecret,
      domain: options.tenant === 'lark' ? Domain.Lark : Domain.Feishu,
      source: 'feishu-codex-relay-gateway',
      includeRawEvent: true,
      policy: { requireMention: false },
      safety: { batch: { text: { delayMs: 0 } } },
      handshakeTimeoutMs: 30_000,
      logger: sdkLogger,
    });
    ownedChannel = true;
  }
  let ownedWsClosed = false;
  // Owned transports are closed explicitly: the SDK only sets `connected`
  // after a successful handshake, so a failed `connect()` can leave an
  // auto-reconnecting WSClient alive even though `disconnect()` no-ops.
  const closeOwnedChannel = async (): Promise<void> => {
    if (!ownedChannel || !channel) return;
    if (!ownedWsClosed) {
      ownedWsClosed = true;
      try { channel.rawWsClient?.close({}); } catch (error) { report(sanitizedSdkError(error)); }
    }
    try { await channel.disconnect(); } catch (error) { report(sanitizedSdkError(error)); }
  };

  const config = {
    enabled: true,
    nodeId: identity.nodeId,
    name: 'Relay Gateway',
    appToken: '',
    tables: { nodes: '', routes: '', commands: '' },
    transport: 'relay' as const,
    relay: { url: 'ws://127.0.0.1', tokenSecretId: 'gateway' },
  };
  const cfg: AppConfig = {
    accounts: { app: { id: options.appId, secret: options.appSecret, tenant: options.tenant } },
    preferences: { access: { ownerOpenId: options.ownerOpenId, ...(options.admins?.length ? { admins: options.admins } : {}) } },
  } as AppConfig;
  const store = new SignedFleetStore(options.storage, options.appId, options.appSecret);
  const reply = async (event: FleetEvent, text: string): Promise<void> => {
    const chatId = event.data.chatId;
    if (typeof chatId === 'string' && chatId) {
      await channel!.send(chatId, { markdown: text });
      return;
    }
    // No-chat replies go to the actual event actor, never a different admin.
    // Platform-synthetic events (bot removal) have no user target.
    const actor = eventActor(event);
    const receiveId = actor && actor !== '__platform__' && !actor.startsWith('__') ? actor : options.ownerOpenId;
    await channel!.rawClient.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text }) },
    });
  };
  const runtime = new FleetRuntime({
    config, cfg, host: identity.host, store,
    inbox: { claim: async () => false, finish: async () => undefined } as never,
    projects: async () => [], migrate: async () => {},
    dispatch: async () => { throw new Error('中继网关不执行任务'); },
    reply, picker: createFleetPicker(channel), onError: report, kind: 'gateway',
  });

  const teardown: Array<() => void> = [];
  const forward = (kind: FleetEvent['kind'], data: unknown): void => {
    const event: FleetEvent = { kind, data: data as Record<string, unknown> };
    // Acknowledge Feishu immediately; durable relay work happens asynchronously.
    void runtime.receive(event).catch(async error => {
      report(error);
      // Never echo raw storage/SDK errors (which may contain paths or
      // credentials) back into chat.
      await reply(event, '中继请求处理失败，未执行。请稍后重试或联系管理员。').catch(report);
    });
  };

  try {
    setState('connecting');
    // Publish the signed gateway source and subscribe to relay notices BEFORE
    // opening the Feishu receiver or accepting any event.
    await runtime.start();
    teardown.push(channel.on('message', event => forward('message', event as NormalizedMessage)));
    teardown.push(channel.on('cardAction', event => forward('cardAction', event as CardActionEvent)));
    teardown.push(channel.on('reaction', event => forward('reaction', event as ReactionEvent)));
    teardown.push(channel.on('comment', event => forward('comment', event as CommentEvent)));
    teardown.push(channel.on('botAdded', event => forward('botAdded', event)));
    const tap = (channel as unknown as {
      dispatcher?: { register?: (handlers: Record<string, (raw: unknown) => void>) => unknown };
    }).dispatcher;
    if (tap?.register) {
      const registered = tap.register({
        'im.chat.member.bot.deleted_v1': (raw: unknown) => {
          const event = raw as {
            chat_id?: string; event_id?: string;
            operator?: { operator_id?: { open_id?: string } };
            event?: { chat_id?: string; event_id?: string;
              operator?: { operator_id?: { open_id?: string } } };
          };
          const chatId = event?.chat_id ?? event?.event?.chat_id;
          if (chatId) forward('botRemoved', {
            chatId, openId: event?.operator?.operator_id?.open_id
              ?? event?.event?.operator?.operator_id?.open_id ?? '__platform__',
            eventId: event?.event_id ?? event?.event?.event_id, raw,
          });
        },
        'application.bot.menu_v6': (raw: unknown) => {
          const event = raw as {
            event_id?: string; event_key?: string; timestamp?: number;
            operator?: { operator_id?: { open_id?: string } };
            event?: { event_id?: string; event_key?: string; timestamp?: number;
              operator?: { operator_id?: { open_id?: string } } };
          };
          forward('botMenu', {
            openId: event?.operator?.operator_id?.open_id ?? event?.event?.operator?.operator_id?.open_id,
            eventKey: event?.event_key ?? event?.event?.event_key,
            eventId: event?.event_id ?? event?.event?.event_id,
            timestamp: event?.timestamp ?? event?.event?.timestamp, raw,
          });
        },
      });
      if (typeof registered === 'function') teardown.push(registered as () => void);
    }
    // SDK lifecycle callbacks. Errors are reported as bounded static text;
    // runtime transport/API errors never force a false permanent `error`
    // state (only a failed startup does that).
    teardown.push(channel.on('error', error => {
      if (active) report(sanitizedSdkError(error));
    }));
    teardown.push(channel.on('reconnecting', () => {
      if (running) setState('connecting');
    }));
    teardown.push(channel.on('reconnected', () => {
      if (running) setState('connected');
    }));
    if (ownedChannel) await channel.connect();
    running = true;
    setState('connected');
  } catch (error) {
    setState('error');
    running = false;
    for (const restore of teardown.reverse()) { try { restore(); } catch { /* best effort */ } }
    await runtime.shutdown().catch(report);
    // Close an owned WSClient even when connect() never set connected, then
    // run disconnect() so the SDK safety pipeline is disposed.
    await closeOwnedChannel();
    active = false;
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    // Invalidate callbacks before any await: nothing may revive state or
    // reconnect intake after shutdown starts.
    running = false;
    active = false;
    closePromise = (async (): Promise<void> => {
      runtime.stop();
      for (const restore of teardown.reverse()) { try { restore(); } catch (error) { report(error); } }
      await runtime.shutdown().catch(report);
      await closeOwnedChannel();
      emitState('disabled');
      // The server owns the relay storage; gateway shutdown never closes it.
    })();
    return closePromise;
  };
  return { nodeId: identity.nodeId, close, shutdown: close };
}
