import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createLarkChannel, Domain, type CardActionEvent, type CommentEvent,
  type LarkChannel, type NormalizedMessage, type ReactionEvent } from '@larksuiteoapi/node-sdk';
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

/**
 * Cloud Feishu receiver. It forwards the seven native event shapes into the
 * durable relay directory and never imports or invokes a model/backend/task.
 */
export async function startFleetRelayGateway(options: FleetRelayGatewayOptions): Promise<FleetRelayGateway> {
  if (!options?.appId || !options.appSecret || !options.ownerOpenId) throw new Error('中继网关缺少飞书应用或管理员配置');
  if (options.tenant !== 'feishu' && options.tenant !== 'lark') throw new Error('中继网关租户配置无效');
  const identity = relayGatewayIdentity(options.appId);
  const onError = options.onError ?? (() => undefined);
  const setState = (state: GatewayState): void => {
    try { options.onState?.(state); } catch (error) { onError(error); }
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
    });
    ownedChannel = true;
  }

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
    reply, picker: createFleetPicker(channel), onError, kind: 'gateway',
  });

  const teardown: Array<() => void> = [];
  const forward = (kind: FleetEvent['kind'], data: unknown): void => {
    const event: FleetEvent = { kind, data: data as Record<string, unknown> };
    // Acknowledge Feishu immediately; durable relay work happens asynchronously.
    void runtime.receive(event).catch(async error => {
      onError(error);
      // Never echo raw storage/SDK errors (which may contain paths or
      // credentials) back into chat.
      await reply(event, '中继请求处理失败，未执行。请稍后重试或联系管理员。').catch(onError);
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
    if (ownedChannel) await channel.connect();
    setState('connected');
  } catch (error) {
    setState('error');
    for (const restore of teardown.reverse()) { try { restore(); } catch { /* best effort */ } }
    await runtime.shutdown().catch(() => undefined);
    if (ownedChannel) await channel.disconnect().catch(() => undefined);
    throw error;
  }

  // Inbox-like no-op directory keeps the option shape explicit without touching disk.
  void join(options.dataDir, 'gateway-inbox');
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    runtime.stop();
    for (const restore of teardown.reverse()) { try { restore(); } catch (error) { onError(error); } }
    await runtime.shutdown().catch(onError);
    if (ownedChannel) await channel!.disconnect().catch(onError);
    setState('disabled');
    // The server owns the relay storage; gateway shutdown never closes it.
  };
  return { nodeId: identity.nodeId, close, shutdown: close };
}
