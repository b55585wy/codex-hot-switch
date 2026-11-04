import type { AppConfig } from '../config/schema';
import { isAdmin, isChatAllowed, isUserAllowedInProject } from '../config/schema';
import { defaultNoMention, type Project } from '../project/registry';
import { FleetInbox } from './inbox';
import { COMMAND_TTL_MS, FLEET_PROTOCOL, SignedFleetStore, commandId, isOnline,
  canonical, validEvent, eventActor, type FleetCommand, type FleetConfig, type FleetEvent, type FleetNode } from './model';

interface Route { nodeId: string; noMention?: boolean; groupKind?: 'single' | 'multi' }
export class FleetDeliveryUnknown extends Error {
  constructor() { super('指令投递回执未确认，未自动重试；请先查看目标电脑状态，再决定是否重新提交。'); }
}
export interface FleetRuntimeOptions {
  config: FleetConfig;
  cfg: AppConfig;
  host: string;
  store: SignedFleetStore;
  inbox: FleetInbox;
  projects: () => Promise<Project[]>;
  extraRoutes?: () => Promise<string[]>;
  migrate: (nodeId: string) => Promise<void>;
  dispatch: (event: FleetEvent) => Promise<void>;
  reply: (event: FleetEvent, text: string) => Promise<void>;
  picker: (event: FleetEvent, nodes: FleetNode[]) => Promise<void>;
  onError: (error: unknown) => void;
  now?: () => number;
}

export class FleetRuntime {
  private timer?: ReturnType<typeof setTimeout>;
  private ticking?: Promise<void>;
  private lastHeartbeat = 0;
  private lastBindings = 0;
  private readonly messageQueues = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private stopped = false;
  private idleTicks = 0;

  constructor(private readonly options: FleetRuntimeOptions) {
    this.now = options.now ?? Date.now;
  }

  get nodeId(): string { return this.options.config.nodeId; }
  get store(): SignedFleetStore { return this.options.store; }

  async start(): Promise<void> {
    if (!await this.store.get<Route>('routes', 'home')) throw new Error('共享目录未初始化，请先运行 fleet setup');
    await this.options.migrate(this.nodeId);
    await this.tick();
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    const delay = Math.min(60_000, (this.options.config.pollMs ?? 15_000) * (1 + Math.floor(this.idleTicks / 4)));
    this.timer = setTimeout(() => {
      void this.tick().catch(this.options.onError).finally(() => this.schedule());
    }, delay);
    this.timer.unref();
  }

  async shutdown(): Promise<void> {
    this.stop();
    if (this.ticking) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.ticking.catch(this.options.onError), new Promise<void>(done => {
        timer = setTimeout(done, 5000); timer.unref();
      })]).finally(() => { if (timer) clearTimeout(timer); });
    }
    await this.publishNode(0).catch(this.options.onError);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  async publishNode(seenAt = this.now()): Promise<void> {
    const { config, host } = this.options;
    const old = await this.store.get<FleetNode>('nodes', this.nodeId);
    if (old && old.host !== host && isOnline(old, this.now())) throw new Error('设备 ID 被另一台在线电脑使用，请重新配置本机身份');
    await this.store.put('nodes', this.nodeId, { id: this.nodeId, name: config.name,
      protocol: FLEET_PROTOCOL, seenAt, host } satisfies FleetNode);
    this.lastHeartbeat = this.now();
  }

  async bindRoute(key: string, nodeId = this.nodeId, replace = false): Promise<void> {
    const old = await this.store.get<Route>('routes', key);
    if (old && old.nodeId !== nodeId && !replace) throw new Error('项目或会话已属于另一台电脑，未自动改绑');
    if (old?.nodeId === nodeId) return;
    await this.store.put('routes', key, { nodeId } satisfies Route);
  }

  async ownMessage(messageId: string): Promise<void> {
    if (messageId) await this.bindRoute(`message:${messageId}`);
  }

  async syncProjects(): Promise<void> {
    for (const project of await this.options.projects()) {
      if (project.ownerNodeId && project.ownerNodeId !== this.nodeId) continue;
      const key = `project:${project.chatId}`;
      const old = await this.store.get<Route>('routes', key);
      if (old && old.nodeId !== this.nodeId) throw new Error('项目已属于另一台电脑，未自动改绑');
      const value: Route = { nodeId: this.nodeId, noMention: project.noMention ?? defaultNoMention(project), groupKind: project.kind ?? 'multi' };
      if (canonical(old) !== canonical(value)) await this.store.put('routes', key, value);
    }
    for (const key of await this.options.extraRoutes?.() ?? []) await this.bindRoute(key);
    this.lastBindings = this.now();
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.ticking) return this.ticking;
    this.ticking = this.poll().finally(() => { this.ticking = undefined; });
    return this.ticking;
  }

  private async poll(): Promise<void> {
    if (!this.lastHeartbeat || this.now() - this.lastHeartbeat >= 30_000) await this.publishNode();
    if (!this.lastBindings || this.now() - this.lastBindings >= 30_000) await this.syncProjects();
    const commands = await this.store.list<FleetCommand>('commands', this.nodeId);
    this.idleTicks = commands.length ? 0 : this.idleTicks + 1;
    const ordered = commands.sort((a, b) => a.createdAt - b.createdAt).slice(0, 10);
    await Promise.all(ordered.map(command => this.consume(command).catch(this.options.onError)));
  }

  async receive(event: FleetEvent): Promise<void> {
    if (this.stopped || !validEvent(event)) throw new Error('多电脑事件无效或超过大小限制');
    this.idleTicks = 0;
    if (await this.control(event)) return;
    if (event.kind === 'message' && event.data.chatType === 'group' && !event.data.mentionedBot) {
      const project = await this.store.get<Route>('routes', `project:${event.data.chatId}`);
      if (!project?.noMention || (project.groupKind !== 'single' && !event.data.threadId)) return;
    }
    const target = await this.resolveTarget(event);
    if (!target) {
      await this.options.reply(event, '尚未绑定执行电脑。请管理员选择电脑后完成项目/文档绑定，未在本机执行。');
      return;
    }
    await this.send(event, target);
  }

  private async resolveTarget(event: FleetEvent): Promise<string | undefined> {
    const d = event.data;
    if (event.kind === 'cardAction') {
      const value = (d.action as { value?: Record<string, unknown> })?.value;
      const node = value?.__fleetNode;
      if (typeof node === 'string') {
        if (!this.store.matches({ cardNode: node }, value?.__fleetProof)) throw new Error('卡片电脑归属校验失败');
        return node;
      }
      return (await this.store.get<Route>('routes', `message:${d.messageId}`))?.nodeId;
    }
    if (event.kind === 'reaction') return (await this.store.get<Route>('routes', `message:${d.messageId}`))?.nodeId;
    if (event.kind === 'comment') return (await this.store.get<Route>('routes', `document:${d.fileType}:${d.fileToken}`))?.nodeId;
    if (event.kind === 'message' && d.chatType === 'group') {
      return (await this.store.get<Route>('routes', `project:${d.chatId}`))?.nodeId;
    }
    if (event.kind === 'botRemoved') return (await this.store.get<Route>('routes', `project:${d.chatId}`))?.nodeId;
    if (event.kind === 'message' && typeof d.replyToMessageId === 'string') {
      const pinned = await this.store.get<Route>('routes', `message:${d.replyToMessageId}`);
      if (pinned) return pinned.nodeId;
    }
    const selected = await this.store.get<Route>('routes', `user:${eventActor(event)}`);
    return selected?.nodeId ?? (await this.store.get<Route>('routes', 'home'))?.nodeId;
  }

  private async send(event: FleetEvent, target: string): Promise<void> {
    const node = await this.store.get<FleetNode>('nodes', target);
    if (!node || !isOnline(node, this.now())) {
      await this.options.reply(event, `电脑「${node?.name ?? target}」离线或版本不兼容，未在其他电脑执行。`);
      return;
    }
    const now = this.now();
    const command: FleetCommand = { id: commandId(event, target), appId: this.store.appId,
      source: this.nodeId, target, createdAt: now, expiresAt: now + COMMAND_TTL_MS, event };
    if (target === this.nodeId) { await this.consume(command); return; }
    const existing = await this.store.get<FleetCommand>('commands', command.id);
    if (existing) return;
    try { await this.store.put('commands', command.id, command, target, command.expiresAt); }
    catch { throw new FleetDeliveryUnknown(); }
    if (event.kind === 'message' || event.kind === 'cardAction') {
      await this.options.reply(event, `已转交电脑「${node.name}」，等待目标电脑接收。此回执不代表任务完成。`);
    }
  }

  async consume(command: FleetCommand): Promise<void> {
    if (command?.appId === this.store.appId && command.target === this.nodeId
      && Number.isFinite(command.expiresAt) && command.expiresAt <= this.now()) {
      await this.store.storage.remove('commands', command.id);
      return;
    }
    if (!this.validCommand(command)) throw new Error('多电脑指令已过期、目标不符或协议无效，未执行');
    const peer = await this.store.get<FleetNode>('nodes', command.source);
    if (!peer || peer.protocol !== FLEET_PROTOCOL) throw new Error('指令来源电脑未注册');
    if (!await this.options.inbox.claim(command)) {
      await this.store.storage.remove('commands', command.id);
      return;
    }
    try { await this.assertLocalTarget(command.event); }
    catch (error) {
      await this.options.inbox.finish(command.id, 'rejected');
      await this.options.reply(command.event, `目标电脑拒绝本次指令：${error instanceof Error ? error.message : '未知错误'}。未执行，未自动重试。`);
      await this.store.storage.remove('commands', command.id);
      return;
    }
    try {
      await this.dispatchOrdered(command.event);
      await this.options.inbox.finish(command.id, 'dispatched');
    } catch (error) {
      await this.options.inbox.finish(command.id, 'unknown');
      await this.options.reply(command.event, `执行回执未确认：${error instanceof Error ? error.message : '未知错误'}。未自动重试，请刷新原会话确认状态。`);
    }
    // Dispatch is acceptance, never a declaration that the Codex task completed.
    await this.store.storage.remove('commands', command.id);
  }

  private validCommand(command: FleetCommand): boolean {
    return !!command && command.appId === this.store.appId && command.target === this.nodeId
      && Number.isFinite(command.createdAt) && command.createdAt <= this.now() + 30_000
      && command.expiresAt > this.now() && command.expiresAt - command.createdAt <= COMMAND_TTL_MS
      && validEvent(command.event) && command.id === commandId(command.event, command.target);
  }

  private async assertLocalTarget(event: FleetEvent): Promise<void> {
    const cfg = this.options.cfg;
    const d = event.data;
    if (event.kind === 'message' && d.chatType === 'group') {
      const project = (await this.options.projects()).find(p => p.chatId === d.chatId);
      if (!isChatAllowed(cfg, String(d.chatId))) throw new Error('当前电脑不允许此会话');
      if (!project || (project.ownerNodeId && project.ownerNodeId !== this.nodeId)) throw new Error('本机没有对应项目绑定');
      if (!isUserAllowedInProject(cfg, project, eventActor(event))) throw new Error('用户没有当前项目权限');
    }
    if ((event.kind === 'message' && d.chatType === 'p2p') || event.kind === 'botMenu') {
      if (!isAdmin(cfg, eventActor(event))) throw new Error('当前电脑不允许此用户进行私聊管理');
    }
    if (event.kind === 'botAdded') {
      if (!isChatAllowed(cfg, String(d.chatId))) throw new Error('当前电脑不允许此会话');
      if (!isAdmin(cfg, eventActor(event))) throw new Error('当前电脑不允许此用户进行私聊管理');
    }
    if (event.kind === 'cardAction') {
      const target = await this.resolveTarget(event);
      if (target !== this.nodeId) throw new Error('卡片不属于当前电脑');
    }
  }

  private dispatchOrdered(event: FleetEvent): Promise<void> {
    if (event.kind !== 'message') return this.options.dispatch(event);
    const key = String(event.data.chatId);
    const previous = this.messageQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.options.dispatch(event));
    this.messageQueues.set(key, next);
    void next.finally(() => { if (this.messageQueues.get(key) === next) this.messageQueues.delete(key); }).catch(() => undefined);
    return next;
  }

  private async select(event: FleetEvent, query: string): Promise<void> {
    const nodes = await this.store.list<FleetNode>('nodes');
    const matches = nodes.filter(n => n.id === query || n.name.toLocaleLowerCase() === query.toLocaleLowerCase());
    if (matches.length !== 1) throw new Error(matches.length ? '电脑名重复，请使用完整设备 ID' : '没有找到该电脑');
    const node = matches[0]!;
    if (!isOnline(node, this.now())) throw new Error('所选电脑离线或版本不兼容');
    await this.bindRoute(`user:${eventActor(event)}`, node.id, true);
    await this.options.reply(event, `已选择电脑「${node.name}」。后续私聊管理操作使用此电脑；已有项目和卡片归属保持不变。`);
  }

  private async control(event: FleetEvent): Promise<boolean> {
    const action = event.kind === 'cardAction' ? (event.data.action as { value?: Record<string, unknown> })?.value : undefined;
    const content = event.kind === 'message' ? String(event.data.content).trim() : '';
    const match = /^\/(?:电脑|computers)(?:\s+(.*))?$/iu.exec(content);
    if (!match && action?.a !== 'fleet.select') return false;
    if (!isAdmin(this.options.cfg, eventActor(event))) throw new Error('仅管理员可选择执行电脑');
    if (event.kind === 'message' && event.data.chatType === 'group'
      && !isChatAllowed(this.options.cfg, String(event.data.chatId))) throw new Error('此会话未获授权');
    if (action) { await this.select(event, String(action.targetNodeId ?? '')); return true; }
    const query = match?.[1]?.trim();
    if (!query) { await this.options.picker(event, await this.store.list<FleetNode>('nodes')); return true; }
    const bind = /^绑定\s+(.+)$/u.exec(query);
    if (bind) {
      if (event.data.chatType !== 'group') throw new Error('请在要绑定的项目群内使用 /电脑 绑定 电脑名');
      const key = `project:${event.data.chatId}`;
      const existing = await this.store.get<Route>('routes', key);
      const nodes = await this.store.list<FleetNode>('nodes');
      const selected = nodes.filter(n => n.id === bind[1] || n.name === bind[1]);
      const target = selected[0];
      if (selected.length !== 1 || !target || !isOnline(target, this.now())) throw new Error('目标电脑不明确或不在线');
      if (existing && existing.nodeId !== target.id) throw new Error('群已有电脑归属，不能在运行中重新绑定');
      await this.bindRoute(key, target.id);
      await this.send({ kind: 'botAdded', data: { chatId: event.data.chatId, operator: { openId: eventActor(event) },
        originMessageId: event.data.messageId } }, target.id);
      await this.options.reply(event, `已将本群的绑定配置交给「${target.name}」，请在机器人私聊完成目录选择。`);
      return true;
    }
    const document = /^文档\s+(\w+)\s+(\w+)$/u.exec(query);
    if (document) {
      const route = await this.store.get<Route>('routes', `user:${eventActor(event)}`)
        ?? await this.store.get<Route>('routes', 'home');
      if (!route) throw new Error('请先选择执行电脑');
      await this.bindRoute(`document:${document[1]}:${document[2]}`, route.nodeId);
      await this.options.reply(event, '文档评论已绑定到当前选择的电脑。');
      return true;
    }
    if (event.data.chatType !== 'p2p') throw new Error('请私聊机器人选择管理电脑；群内使用 /电脑 绑定 电脑名');
    await this.select(event, query);
    return true;
  }
}
