import { hostname } from 'node:os';
import { join, relative } from 'node:path';
import type { CardActionEvent, CommentEvent, LarkChannel, NormalizedMessage, ReactionEvent } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../config/schema';
import { paths } from '../config/paths';
import { listProjects, updateProject } from '../project/registry';
import { listSessions, patchSession } from '../bot/session-store';
import type { createOrchestrator } from '../bot/handle-message';
import { log } from '../core/logger';
import { sendManagedCard } from '../card/managed';
import { BitableFleetStorage } from './bitable';
import { FleetInbox } from './inbox';
import { FleetDeliveryUnknown, FleetRuntime } from './runtime';
import { SignedFleetStore, digest, eventActor, isOnline, validateFleetConfig, type FleetEvent, type FleetNode } from './model';
import { selectFleetApiClient } from './transport';
import { installFleetHooks } from './hooks';
import { setFleetNodeId } from './context';

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
    picker: async (event, nodes: FleetNode[]) => {
      const nameCounts = new Map<string, number>();
      for (const node of nodes) {
        const key = node.name.toLocaleLowerCase();
        nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
      }
      const elements: object[] = nodes.map(node => {
        const online = isOnline(node);
        const duplicate = (nameCounts.get(node.name.toLocaleLowerCase()) ?? 0) > 1;
        const description = { tag: 'markdown', content:
          `**${node.name}** · ${online ? '在线' : '离线或版本不兼容'}${duplicate ? `\n设备 ID：${node.id}` : ''}` };
        if (!online) return description;
        const selectButton = {
          tag: 'button', text: { tag: 'plain_text', content: `选择 ${node.name}` }, type: 'default',
          behaviors: [{ type: 'callback', value: { a: 'fleet.select', targetNodeId: node.id } }],
        };
        return { tag: 'column_set', flex_mode: 'none', horizontal_spacing: 'medium', columns: [
          { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [description] },
          { tag: 'column', width: 'auto', vertical_align: 'center', elements: [selectButton] },
        ] };
      });
      elements.push({ tag: 'markdown', content: '私聊：/电脑 电脑名\n未绑定项目群：/电脑 绑定 电脑名\n文档评论：/电脑 文档 文件类型 文件token' });
      await sendManagedCard(channel, typeof event.data.chatId === 'string' ? event.data.chatId : eventActor(event),
        { schema: '2.0', header: { title: { tag: 'plain_text', content: '执行电脑' } }, body: { elements } },
        undefined, false, typeof event.data.chatId === 'string' ? 'chat_id' : 'open_id');
    },
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
