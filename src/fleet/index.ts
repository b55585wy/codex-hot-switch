import { hostname } from 'node:os';
import { join, relative } from 'node:path';
import type { CardActionEvent, CommentEvent, LarkChannel, NormalizedMessage, ReactionEvent } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../config/schema';
import { paths } from '../config/paths';
import { listProjects, updateProject } from '../project/registry';
import { listSessions, patchSession } from '../bot/session-store';
import type { createOrchestrator } from '../bot/handle-message';
import { log } from '../core/logger';
import { BitableFleetStorage } from './bitable';
import { FleetInbox } from './inbox';
import { FleetDeliveryUnknown, FleetRuntime } from './runtime';
import { SignedFleetStore, digest, eventActor, validateFleetConfig, type FleetEvent } from './model';
import { selectFleetApiClient } from './transport';
import { installFleetHooks } from './hooks';
import { setFleetNodeId } from './context';
import { createFleetPicker } from './picker';

type Orchestrator = ReturnType<typeof createOrchestrator>;

export async function migrateFleetOwnership(nodeId: string): Promise<void> {
  const projects = await listProjects();
  const sessions = await listSessions();
  if ([...projects, ...sessions].some(item => item.ownerNodeId && item.ownerNodeId !== nodeId)) {
    throw new Error('本机数据包含其他电脑归属，请先核对数据目录');
  }
  for (const project of projects) {
    if (!project.ownerNodeId) await updateProject(project.name, { ownerNodeId: nodeId });
  }
  for (const session of sessions) {
    if (!session.ownerNodeId) await patchSession(session.threadId, { ownerNodeId: nodeId });
  }
}

export async function existingDocumentRoutes(): Promise<string[]> {
  const keys = new Set<string>();
  for (const session of await listSessions()) {
    const local = relative(paths.commentsRootDir, session.cwd);
    const match = /^comment-([a-z0-9_]+)-([a-zA-Z0-9]+)$/.exec(local);
    if (match) keys.add(`document:${match[1]}:${match[2]}`);
  }
  return [...keys];
}

export function createFleetBridge(channel: LarkChannel, cfg: AppConfig, secret: string, handlers: Orchestrator) {
  const config = cfg.fleet;
  if (!config?.enabled) return undefined;
  validateFleetConfig(config);
  setFleetNodeId(config.nodeId);
  const onError = (error: unknown): void => log.fail('fleet', error);
  // The optional local proxy applies only to shared Bitable traffic, never to
  // the ordinary bot channel or any other Codex/tool HTTP client.
  const fleetClient = selectFleetApiClient(channel.rawClient, { appId: cfg.accounts.app.id, appSecret: secret,
    tenant: cfg.accounts.app.tenant, apiProxyUrl: config.apiProxyUrl });
  const store = new SignedFleetStore(new BitableFleetStorage(fleetClient, config), cfg.accounts.app.id, secret);
  const reply = async (event: FleetEvent, text: string): Promise<void> => {
    const chatId = event.data.chatId;
    if (typeof chatId === 'string' && chatId) {
      await channel.send(chatId, { markdown: text });
      return;
    }
    await channel.rawClient.im.v1.message.create({ params: { receive_id_type: 'open_id' },
      data: { receive_id: eventActor(event), msg_type: 'text', content: JSON.stringify({ text }) } });
  };
  const dispatch = async ({ kind, data }: FleetEvent): Promise<void> => {
    switch (kind) {
      case 'message': return handlers.onMessage(data as unknown as NormalizedMessage);
      case 'cardAction': return handlers.dispatcher.handle(data as unknown as CardActionEvent);
      case 'reaction': return handlers.onReaction(data as unknown as ReactionEvent);
      case 'comment': return handlers.onComment(data as unknown as CommentEvent);
      case 'botAdded': return handlers.onBotAddedToChat(data as never);
      case 'botRemoved': return handlers.onBotRemovedFromChat(String(data.chatId));
      case 'botMenu': return handlers.onBotMenu(data as never);
    }
  };
  const runtime = new FleetRuntime({ config, cfg, host: digest({ host: hostname(), home: paths.appDir }),
    store, inbox: new FleetInbox(join(paths.fleetDir, 'inbox')), projects: listProjects, extraRoutes: existingDocumentRoutes,
    migrate: migrateFleetOwnership, dispatch, reply, onError,
    picker: createFleetPicker(channel),
  });
  const restore = installFleetHooks(channel, runtime, config.name, onError);
  const handle = (kind: FleetEvent['kind'], data: unknown): void => {
    const event = { kind, data: data as Record<string, unknown> };
    // Return immediately to Feishu; durable handoff may exceed its acknowledgement window.
    void runtime.receive(event).catch(async error => {
      onError(error);
      const message = error instanceof FleetDeliveryUnknown ? error.message
        : `多电脑请求处理失败：${error instanceof Error ? error.message : '未知错误'}`;
      await reply(event, message).catch(onError);
    });
  };
  return {
    handle,
    stop: () => runtime.stop(),
    start: () => runtime.start(),
    shutdown: async () => { await runtime.shutdown(); restore(); setFleetNodeId(undefined); },
  };
}
