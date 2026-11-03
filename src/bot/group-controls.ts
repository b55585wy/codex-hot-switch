import { randomUUID } from 'node:crypto';
import type { CardObject } from '../card/cards';
import {
  buildGroupControlGoalFormCard,
  buildGroupControlHelpCard,
  buildGroupControlPanelCard,
  buildGroupControlPickerCard,
  type GroupControlPanel,
  type GroupControlSession,
} from '../card/group-control-card';
import { log } from '../core/logger';

/** Action ids used by the backend controller. The card builders emit the same
 * literals; keeping them here makes the dispatcher wiring typo-proof. */
export const GC = {
  sessions: 'gc.sessions',
  help: 'gc.help',
  select: 'gc.select',
  page: 'gc.page',
  refresh: 'gc.refresh',
  continue: 'gc.continue',
  interrupt: 'gc.interrupt',
  goalForm: 'gc.goal.form',
  goalSubmit: 'gc.goal.submit',
  goalEnd: 'gc.goal.end',
} as const;

export const GROUP_CONTROL_GOAL_INPUT = 'gc_goal_objective';
export const GROUP_CONTROL_GOAL_MAX_LENGTH = 1000;
export const GROUP_CONTROL_PANEL_TTL_MS = 15 * 60_000;
export const GROUP_CONTROL_MAX_PENDING = 64;
export const GROUP_CONTROL_MAX_SESSIONS = 100;
const GROUP_CONTROL_PAGE_SIZE = 10;

export type GroupControlStatus = 'idle' | 'running' | 'goal-running';

/**
 * Permission scope carried by a persisted session key. `#admin`/`#guest` are the
 * role-namespaced keys minted when a project has distinct admin/guest tiers;
 * `shared` is a legacy unsuffixed key that both tiers may use.
 */
export type GroupControlAccessTier = 'admin' | 'guest' | 'shared';

export function accessTierOfKey(sessionKey: string): GroupControlAccessTier {
  if (/#admin$/.test(sessionKey)) return 'admin';
  if (/#guest$/.test(sessionKey)) return 'guest';
  return 'shared';
}

/**
 * Role a control action may run at for a given target key. The target's scope is
 * authoritative and a caller can only DEMOTE, never elevate:
 *   - `#admin` target → admin only (the tier gate must already have rejected a
 *     non-admin; this clamp guarantees no silent elevation even if it didn't);
 *   - `#guest` target → guest, including for an admin operator (preserve scope);
 *   - legacy `shared` key → the caller's own role, as plain topic routing does.
 */
export function resolveRunTier(keyTier: GroupControlAccessTier, callerIsAdmin: boolean): 'admin' | 'guest' {
  if (keyTier === 'guest') return 'guest';
  if (keyTier === 'admin') return callerIsAdmin ? 'admin' : 'guest';
  return callerIsAdmin ? 'admin' : 'guest';
}

/** Server-side projection of a project. Only fields needed for authorization
 * and token invalidation live here; callbacks never carry them. */
export interface GroupControlProjectView {
  name: string;
  chatId: string;
  /** `single` groups have exactly one implicit session (no topics); only there
   * may the controller skip the explicit picker. */
  kind: 'single' | 'multi';
  backendName: string;
  goalSupported: boolean;
  /** Changes to permission tier / backend / cwd invalidate every issued token. */
  permissionSignature: string;
  allowedUsers?: string[];
}

/** Exact persisted session metadata bound into a panel token. */
export interface GroupControlSessionView {
  key: string;
  title: string;
  status: GroupControlStatus;
  /** Scope of the selected key; a non-admin operator must never reach `admin`. */
  accessTier: GroupControlAccessTier;
  backendName: string;
  goalSupported: boolean;
  settingsSupported: boolean;
  goalObjective?: string;
  /** native backend session id — revalidated before every mutation */
  sessionId: string;
  backend: string;
  cwd: string;
  /** Opaque identity of the ActiveState that produced `status`. Two different
   * runs on the same key therefore have different tokens. */
  runToken?: unknown;
  runOwnerOpenId?: string;
}

export interface GroupControlContext {
  chatId: string;
  operatorOpenId: string;
  /** source card / command message; used as the reply target for fresh cards */
  sourceMessageId: string;
  /** true for /controls invoked inside a Feishu topic */
  inThread?: boolean;
}

export type GroupControlResultStatus =
  | 'ok'
  | 'denied'
  | 'expired'
  | 'stale'
  | 'busy'
  | 'unsupported'
  | 'invalid'
  | 'not-found'
  | 'failed';

export interface GroupControlResult {
  status: GroupControlResultStatus;
  message?: string;
}

export interface ContinueSessionInput {
  project: GroupControlProjectView;
  session: GroupControlSessionView;
  operatorOpenId: string;
  sourceMessageId: string;
}

export interface InterruptSessionInput {
  project: GroupControlProjectView;
  sessionKey: string;
  runToken: unknown;
  operatorOpenId: string;
  sourceMessageId: string;
}

export interface StartGoalInput {
  project: GroupControlProjectView;
  session: GroupControlSessionView;
  objective: string;
  operatorOpenId: string;
  sourceMessageId: string;
}

export interface GroupControlDeps {
  now?: () => number;
  randomId?: () => string;
  isChatAllowed: (chatId: string) => boolean;
  isUserAllowedInProject: (project: GroupControlProjectView, userId: string) => boolean;
  isAdmin: (userId: string) => boolean;
  isAccountTransitioning: () => boolean;
  getProject: (chatId: string) => Promise<GroupControlProjectView | undefined>;
  listSessions: (project: GroupControlProjectView, operatorOpenId: string) => Promise<GroupControlSessionView[]>;
  getSession: (
    project: GroupControlProjectView,
    sessionKey: string,
    operatorOpenId: string,
  ) => Promise<GroupControlSessionView | undefined>;
  sendCard: (chatId: string, card: CardObject, replyTo?: string, inThread?: boolean) => Promise<void>;
  sendText: (chatId: string, text: string, replyTo?: string, inThread?: boolean) => Promise<void>;
  /** Dispatch an explicit 「继续」 through the existing original-topic run path. */
  continueSession: (input: ContinueSessionInput) => Promise<GroupControlResult>;
  /** Interrupt only the ordinary run identified by `runToken`. */
  interruptSession: (input: InterruptSessionInput) => Promise<GroupControlResult>;
  /** Start a goal on the exact selected session/topic (never a fresh topic). */
  startGoalSession: (input: StartGoalInput) => Promise<GroupControlResult>;
  /** Existing goal interrupt path: clearGoal + stop the current turn. Must NOT
   * call the old endGoal path (which lets the in-flight turn finish). */
  endGoalSession: (input: InterruptSessionInput) => Promise<GroupControlResult>;
}

interface PendingPanel {
  token: string;
  chatId: string;
  operatorOpenId: string;
  stage: 'picker' | 'panel' | 'goal-form';
  page: number;
  projectName: string;
  permissionSignature: string;
  createdAt: number;
  sessionKey?: string;
  sessionId?: string;
  backend?: string;
  cwd?: string;
  runToken?: unknown;
}

type Authorized = { project: GroupControlProjectView } | { failure: GroupControlResult };

function expired(message: string): GroupControlResult {
  return { status: 'expired', message };
}

function textFromFormValue(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const object = raw as { value?: unknown; text?: unknown };
    if (typeof object.value === 'string') return object.value;
    if (typeof object.text === 'string') return object.text;
  }
  return undefined;
}

function sessionCard(view: GroupControlSessionView): GroupControlSession {
  return {
    key: view.key,
    title: view.title,
    status: view.status,
    backendName: view.backendName,
    goalSupported: view.goalSupported,
    settingsSupported: view.settingsSupported,
    ...(view.goalObjective ? { goalObjective: view.goalObjective } : {}),
  };
}

function panelCard(
  project: GroupControlProjectView,
  token: string,
  view: GroupControlSessionView,
  extra: { error?: string; notice?: string } = {},
): GroupControlPanel {
  return {
    token,
    projectName: project.name,
    session: sessionCard(view),
    ...(extra.error ? { error: extra.error } : {}),
    ...(extra.notice ? { notice: extra.notice } : {}),
  };
}

/**
 * Per-group interactive controller. All mutable state is issuer-side: a callback
 * only carries an opaque token, and every target field is re-read from the
 * persisted session + live run state at callback time. Tokens are one-shot and
 * consumed synchronously before the first await so duplicate/replayed callbacks
 * can never double-mutate.
 */
export interface GroupControls {
  openSessions: (ctx: GroupControlContext) => Promise<GroupControlResult>;
  openHelp: (ctx: GroupControlContext) => Promise<GroupControlResult>;
  select: (ctx: GroupControlContext, token: string | undefined, key: string | undefined) => Promise<GroupControlResult>;
  page: (ctx: GroupControlContext, token: string | undefined, page: number | undefined) => Promise<GroupControlResult>;
  refresh: (ctx: GroupControlContext, token: string | undefined) => Promise<GroupControlResult>;
  continueSession: (ctx: GroupControlContext, token: string | undefined) => Promise<GroupControlResult>;
  interrupt: (ctx: GroupControlContext, token: string | undefined) => Promise<GroupControlResult>;
  goalForm: (ctx: GroupControlContext, token: string | undefined) => Promise<GroupControlResult>;
  goalSubmit: (ctx: GroupControlContext, token: string | undefined, formValue: Record<string, unknown> | undefined) => Promise<GroupControlResult>;
  goalEnd: (ctx: GroupControlContext, token: string | undefined) => Promise<GroupControlResult>;
  shutdown: () => void;
  pendingCount: () => number;
}

export function createGroupControls(deps: GroupControlDeps): GroupControls {
  const now = deps.now ?? (() => Date.now());
  const randomId = deps.randomId ?? (() => randomUUID());
  const ttlMs = GROUP_CONTROL_PANEL_TTL_MS;
  const maxPending = GROUP_CONTROL_MAX_PENDING;
  const pending = new Map<string, PendingPanel>();
  let closed = false;

  function prune(): void {
    const at = now();
    for (const [token, value] of pending) {
      if (at - value.createdAt > ttlMs) pending.delete(token);
    }
  }

  function issue(fields: Omit<PendingPanel, 'token' | 'createdAt'>): string {
    prune();
    while (pending.size >= maxPending) {
      const oldest = pending.keys().next().value;
      if (oldest === undefined) break;
      pending.delete(oldest);
    }
    const token = randomId();
    pending.set(token, { ...fields, token, createdAt: now() });
    return token;
  }

  function consume(
    ctx: GroupControlContext,
    token: string | undefined,
  ): { panel: PendingPanel } | { failure: GroupControlResult } {
    const missing = expired('这张面板已过期，请重新打开 /controls。');
    if (closed) return { failure: missing };
    if (!token) return { failure: missing };
    const panel = pending.get(token);
    if (!panel) return { failure: missing };
    if (now() - panel.createdAt > ttlMs) {
      pending.delete(token);
      return { failure: missing };
    }
    if (panel.chatId !== ctx.chatId || panel.operatorOpenId !== ctx.operatorOpenId) {
      // Do not let a guessed token evict the legitimate owner's panel.
      log.info('group-controls', 'token-scope-mismatch', {
        chat: ctx.chatId.slice(-6),
        stage: panel.stage,
      });
      return { failure: { status: 'denied', message: '⛔ 无权操作此面板。' } };
    }
    // One-shot: remove before any await so a replayed / duplicated callback
    // observes a missing token instead of mutating twice.
    pending.delete(token);
    return { panel };
  }

  async function authorize(ctx: GroupControlContext): Promise<Authorized> {
    if (!ctx.operatorOpenId) return { failure: { status: 'denied', message: '⛔ 无法识别操作者。' } };
    if (!deps.isChatAllowed(ctx.chatId)) return { failure: { status: 'denied', message: '⛔ 本群不在响应白名单内。' } };
    if (deps.isAccountTransitioning()) {
      return { failure: { status: 'busy', message: '账号后台正在更新，请等待核验结果后再操作。' } };
    }
    const project = await deps.getProject(ctx.chatId);
    if (!project) return { failure: { status: 'not-found', message: '本群未绑定项目。' } };
    if (!deps.isUserAllowedInProject(project, ctx.operatorOpenId)) {
      return { failure: { status: 'denied', message: '⛔ 你不在本项目的响应白名单内。' } };
    }
    return { project };
  }

  async function replyFailure(ctx: GroupControlContext, result: GroupControlResult): Promise<GroupControlResult> {
    if (result.message) await safeText(ctx, result.message);
    return result;
  }

  async function safeCard(ctx: GroupControlContext, card: CardObject): Promise<void> {
    try {
      await deps.sendCard(ctx.chatId, card, ctx.sourceMessageId, ctx.inThread);
    } catch (err) {
      log.fail('group-controls', err, { phase: 'send-card' });
    }
  }

  async function safeText(ctx: GroupControlContext, text: string): Promise<void> {
    try {
      await deps.sendText(ctx.chatId, text, ctx.sourceMessageId, ctx.inThread);
    } catch (err) {
      log.fail('group-controls', err, { phase: 'send-text' });
    }
  }

  async function sendPicker(
    ctx: GroupControlContext,
    project: GroupControlProjectView,
    sessions: GroupControlSessionView[],
    page: number,
    token: string,
  ): Promise<void> {
    const bounded = sessions.slice(0, GROUP_CONTROL_MAX_SESSIONS);
    await safeCard(
      ctx,
      buildGroupControlPickerCard({
        projectName: project.name,
        token,
        sessions: bounded.map(sessionCard),
        page,
      }),
    );
  }

  function pickerToken(project: GroupControlProjectView, ctx: GroupControlContext, page: number): string {
    return issue({
      chatId: ctx.chatId,
      operatorOpenId: ctx.operatorOpenId,
      stage: 'picker',
      page,
      projectName: project.name,
      permissionSignature: project.permissionSignature,
    });
  }

  function panelToken(
    project: GroupControlProjectView,
    ctx: GroupControlContext,
    view: GroupControlSessionView,
    stage: 'panel' | 'goal-form' = 'panel',
  ): string {
    return issue({
      chatId: ctx.chatId,
      operatorOpenId: ctx.operatorOpenId,
      stage,
      page: 0,
      projectName: project.name,
      permissionSignature: project.permissionSignature,
      sessionKey: view.key,
      sessionId: view.sessionId,
      backend: view.backend,
      cwd: view.cwd,
      runToken: view.runToken,
    });
  }

  async function sendPanel(
    ctx: GroupControlContext,
    project: GroupControlProjectView,
    view: GroupControlSessionView,
    extra: { error?: string; notice?: string } = {},
  ): Promise<string> {
    const token = panelToken(project, ctx, view);
    await safeCard(ctx, buildGroupControlPanelCard(panelCard(project, token, view, extra)));
    return token;
  }

  async function revalidate(
    project: GroupControlProjectView,
    panel: PendingPanel,
    operatorOpenId: string,
  ): Promise<{ view: GroupControlSessionView } | { failure: GroupControlResult }> {
    if (panel.permissionSignature !== project.permissionSignature) {
      return {
        failure: {
          status: 'stale',
          message: '⚠️ 项目权限或运行配置已变化，请刷新面板后重试。',
        },
      };
    }
    if (!panel.sessionKey) return { failure: { status: 'stale', message: '⚠️ 面板未绑定会话，请重新选择。' } };
    const view = await deps.getSession(project, panel.sessionKey, operatorOpenId);
    if (!view) {
      // A cross-tier key is filtered out server-side, so a non-admin sees it as
      // gone rather than as an operable session.
      return { failure: { status: 'stale', message: '⚠️ 所选会话已删除或无权访问，请重新选择。' } };
    }
    if (view.sessionId !== panel.sessionId || view.backend !== panel.backend || view.cwd !== panel.cwd) {
      return {
        failure: {
          status: 'stale',
          message: '⚠️ 会话映射已变化，请刷新面板后重试。',
        },
      };
    }
    return { view };
  }

  /**
   * Tier ownership: an `#admin` session belongs to admins only. This is checked
   * on the freshly re-read view at every mutation (not on token contents), so a
   * demoted operator loses access even to a panel issued while still admin.
   */
  function tierFailure(ctx: GroupControlContext, view: GroupControlSessionView): GroupControlResult | undefined {
    if (view.accessTier === 'admin' && !deps.isAdmin(ctx.operatorOpenId)) {
      return { status: 'denied', message: '⛔ 管理员会话仅限管理员操作。' };
    }
    return undefined;
  }

  function visibleSessions(
    project: GroupControlProjectView,
    userId: string,
    sessions: GroupControlSessionView[],
  ): GroupControlSessionView[] {
    const admin = deps.isAdmin(userId);
    return sessions.filter((session) => session.accessTier !== 'admin' || admin);
  }

  function ownerOrAdmin(ctx: GroupControlContext, view: GroupControlSessionView): boolean {
    return ctx.operatorOpenId === view.runOwnerOpenId || deps.isAdmin(ctx.operatorOpenId);
  }

  async function openSessions(ctx: GroupControlContext): Promise<GroupControlResult> {
    const auth = await authorize(ctx);
    if ('failure' in auth) return replyFailure(ctx, auth.failure);
    const sessions = visibleSessions(
      auth.project,
      ctx.operatorOpenId,
      await deps.listSessions(auth.project, ctx.operatorOpenId).catch((err) => {
        log.fail('group-controls', err, { phase: 'list-sessions' });
        return [] as GroupControlSessionView[];
      }),
    );
    // Only a `single` project has one implicit session, so only it may skip the
    // picker. A multi project with exactly one stored session still shows an
    // explicit picker — the user must never get an implicitly chosen session.
    if (auth.project.kind === 'single' && sessions.length > 0) {
      await sendPanel(ctx, auth.project, sessions[0]!);
      return { status: 'ok' };
    }
    const token = pickerToken(auth.project, ctx, 0);
    await sendPicker(ctx, auth.project, sessions, 0, token);
    return { status: 'ok' };
  }

  async function openHelp(ctx: GroupControlContext): Promise<GroupControlResult> {
    const auth = await authorize(ctx);
    if ('failure' in auth) return replyFailure(ctx, auth.failure);
    await safeCard(ctx, buildGroupControlHelpCard({ projectName: auth.project.name }));
    return { status: 'ok' };
  }

  async function select(
    ctx: GroupControlContext,
    token: string | undefined,
    key: string | undefined,
  ): Promise<GroupControlResult> {
    const taken = consume(ctx, token);
    if ('failure' in taken) return replyFailure(ctx, taken.failure);
    if (taken.panel.stage !== 'picker') return replyFailure(ctx, { status: 'invalid', message: '⚠️ 请重新打开会话列表。' });
    const auth = await authorize(ctx);
    if ('failure' in auth) return replyFailure(ctx, auth.failure);
    if (taken.panel.permissionSignature !== auth.project.permissionSignature) {
      return replyFailure(ctx, { status: 'stale', message: '⚠️ 项目配置已变化，请重新打开 /controls。' });
    }
    if (!key) return replyFailure(ctx, { status: 'invalid', message: '⚠️ 未选择会话。' });
    // Explicit denial (not "gone") when a callback forges/keeps an #admin key.
    if (accessTierOfKey(key) === 'admin' && !deps.isAdmin(ctx.operatorOpenId)) {
      return replyFailure(ctx, { status: 'denied', message: '⛔ 管理员会话仅限管理员操作。' });
    }
    const sessions = visibleSessions(auth.project, ctx.operatorOpenId, await deps.listSessions(auth.project, ctx.operatorOpenId));
    const view = sessions.find((session) => session.key === key);
    if (!view) {
      return replyFailure(ctx, { status: 'stale', message: '⚠️ 该会话已不存在，请重新选择。' });
    }
    const tierFail = tierFailure(ctx, view);
    if (tierFail) return replyFailure(ctx, tierFail);
    await sendPanel(ctx, auth.project, view);
    return { status: 'ok' };
  }

  async function page(
    ctx: GroupControlContext,
    token: string | undefined,
    requested: number | undefined,
  ): Promise<GroupControlResult> {
    const taken = consume(ctx, token);
    if ('failure' in taken) return replyFailure(ctx, taken.failure);
    if (taken.panel.stage !== 'picker') return replyFailure(ctx, { status: 'invalid', message: '⚠️ 请重新打开会话列表。' });
    const auth = await authorize(ctx);
    if ('failure' in auth) return replyFailure(ctx, auth.failure);
    if (taken.panel.permissionSignature !== auth.project.permissionSignature) {
      return replyFailure(ctx, { status: 'stale', message: '⚠️ 项目配置已变化，请重新打开 /controls。' });
    }
    const sessions = visibleSessions(
      auth.project,
      ctx.operatorOpenId,
      await deps.listSessions(auth.project, ctx.operatorOpenId),
    ).slice(0, GROUP_CONTROL_MAX_SESSIONS);
    const pages = Math.max(1, Math.ceil(sessions.length / GROUP_CONTROL_PAGE_SIZE));
    const next = Math.min(Math.max(Math.trunc(Number(requested) || 0), 0), pages - 1);
    const nextToken = pickerToken(auth.project, ctx, next);
    await sendPicker(ctx, auth.project, sessions, next, nextToken);
    return { status: 'ok' };
  }

  async function refresh(ctx: GroupControlContext, token: string | undefined): Promise<GroupControlResult> {
    const taken = consume(ctx, token);
    if ('failure' in taken) return replyFailure(ctx, taken.failure);
    const auth = await authorize(ctx);
    if ('failure' in auth) return replyFailure(ctx, auth.failure);
    const listFor = async (): Promise<GroupControlSessionView[]> =>
      visibleSessions(auth.project, ctx.operatorOpenId, await deps.listSessions(auth.project, ctx.operatorOpenId));
    if (taken.panel.permissionSignature !== auth.project.permissionSignature) {
      // Transition-safe reset: a permission/config change invalidates the old
      // target, so return to a freshly issued picker instead of a broken panel.
      const sessions = await listFor();
      const nextToken = pickerToken(auth.project, ctx, 0);
      await sendPicker(ctx, auth.project, sessions, 0, nextToken);
      return { status: 'ok', message: '项目配置已变化，已重新加载会话列表。' };
    }
    if (!taken.panel.sessionKey) {
      const sessions = await listFor();
      const nextToken = pickerToken(auth.project, ctx, 0);
      await sendPicker(ctx, auth.project, sessions, 0, nextToken);
      return { status: 'ok' };
    }
    const view = await deps.getSession(auth.project, taken.panel.sessionKey, ctx.operatorOpenId);
    if (!view) {
      const sessions = await listFor();
      const nextToken = pickerToken(auth.project, ctx, 0);
      await sendPicker(ctx, auth.project, sessions, 0, nextToken);
      return { status: 'ok', message: '所选会话已删除，已重新加载会话列表。' };
    }
    const tierFail = tierFailure(ctx, view);
    if (tierFail) return replyFailure(ctx, tierFail);
    if (view.sessionId !== taken.panel.sessionId || view.backend !== taken.panel.backend || view.cwd !== taken.panel.cwd) {
      return replyFailure(ctx, { status: 'stale', message: '⚠️ 会话映射已变化，请重新打开 /controls。' });
    }
    await sendPanel(ctx, auth.project, view);
    return { status: 'ok' };
  }

  async function continueSelected(ctx: GroupControlContext, token: string | undefined): Promise<GroupControlResult> {
    const taken = consume(ctx, token);
    if ('failure' in taken) return replyFailure(ctx, taken.failure);
    if (taken.panel.stage !== 'panel') return replyFailure(ctx, { status: 'invalid', message: '⚠️ 请刷新面板后重试。' });
    const auth = await authorize(ctx);
    if ('failure' in auth) return replyFailure(ctx, auth.failure);
    const checked = await revalidate(auth.project, taken.panel, ctx.operatorOpenId);
    if ('failure' in checked) return replyFailure(ctx, checked.failure);
    const tierFail = tierFailure(ctx, checked.view);
    if (tierFail) return replyFailure(ctx, tierFail);
    if (checked.view.status !== 'idle' || checked.view.runToken !== undefined) {
      return replyFailure(ctx, { status: 'busy', message: '⚠️ 所选会话正在运行或排队，未发送「继续」。' });
    }
    const result = await deps.continueSession({
      project: auth.project,
      session: checked.view,
      operatorOpenId: ctx.operatorOpenId,
      sourceMessageId: ctx.sourceMessageId,
    });
    if (result.status === 'ok') {
      await safeText(ctx, '▶️ 已向所选会话发送明确的「继续」指令。');
    } else {
      await replyFailure(ctx, result);
    }
    return result;
  }

  async function interruptSelected(ctx: GroupControlContext, token: string | undefined): Promise<GroupControlResult> {
    const taken = consume(ctx, token);
    if ('failure' in taken) return replyFailure(ctx, taken.failure);
    if (taken.panel.stage !== 'panel') return replyFailure(ctx, { status: 'invalid', message: '⚠️ 请刷新面板后重试。' });
    const auth = await authorize(ctx);
    if ('failure' in auth) return replyFailure(ctx, auth.failure);
    const checked = await revalidate(auth.project, taken.panel, ctx.operatorOpenId);
    if ('failure' in checked) return replyFailure(ctx, checked.failure);
    const tierFail = tierFailure(ctx, checked.view);
    if (tierFail) return replyFailure(ctx, tierFail);
    if (checked.view.status !== 'running' || checked.view.runToken === undefined) {
      return replyFailure(ctx, { status: 'stale', message: '⚠️ 所选会话的运行状态已变化，请刷新面板。' });
    }
    if (checked.view.runToken !== taken.panel.runToken) {
      return replyFailure(ctx, { status: 'stale', message: '⚠️ 该轮运行已结束或被替换，请刷新面板。' });
    }
    if (!ownerOrAdmin(ctx, checked.view)) {
      return replyFailure(ctx, { status: 'denied', message: '⚠️ 仅发起人或管理员可停止。' });
    }
    const result = await deps.interruptSession({
      project: auth.project,
      sessionKey: checked.view.key,
      runToken: checked.view.runToken,
      operatorOpenId: ctx.operatorOpenId,
      sourceMessageId: ctx.sourceMessageId,
    });
    if (result.status === 'ok') await safeText(ctx, '⏹ 已请求停止所选会话的当前轮次。');
    else await replyFailure(ctx, result);
    return result;
  }

  async function goalForm(ctx: GroupControlContext, token: string | undefined): Promise<GroupControlResult> {
    const taken = consume(ctx, token);
    if ('failure' in taken) return replyFailure(ctx, taken.failure);
    if (taken.panel.stage !== 'panel') return replyFailure(ctx, { status: 'invalid', message: '⚠️ 请刷新面板后重试。' });
    const auth = await authorize(ctx);
    if ('failure' in auth) return replyFailure(ctx, auth.failure);
    const checked = await revalidate(auth.project, taken.panel, ctx.operatorOpenId);
    if ('failure' in checked) return replyFailure(ctx, checked.failure);
    const tierFail = tierFailure(ctx, checked.view);
    if (tierFail) return replyFailure(ctx, tierFail);
    if (!checked.view.goalSupported) {
      return replyFailure(ctx, { status: 'unsupported', message: '当前后端不支持自主目标。' });
    }
    if (checked.view.status !== 'idle') {
      return replyFailure(ctx, { status: 'busy', message: '⚠️ 所选会话正在运行，暂不能启动目标。' });
    }
    const formToken = panelToken(auth.project, ctx, checked.view, 'goal-form');
    await safeCard(ctx, buildGroupControlGoalFormCard(panelCard(auth.project, formToken, checked.view)));
    return { status: 'ok' };
  }

  async function goalSubmit(
    ctx: GroupControlContext,
    token: string | undefined,
    formValue: Record<string, unknown> | undefined,
  ): Promise<GroupControlResult> {
    // Pure validation happens before consuming the one-shot token: an empty or
    // overlength submission mutates nothing, so the user may correct the form
    // and resubmit. The valid mutation path below consumes synchronously.
    const objective = (textFromFormValue(formValue?.[GROUP_CONTROL_GOAL_INPUT]) ?? '').trim();
    if (!objective) {
      return replyFailure(ctx, { status: 'invalid', message: '目标内容不能为空。' });
    }
    if (objective.length > GROUP_CONTROL_GOAL_MAX_LENGTH) {
      return replyFailure(ctx, {
        status: 'invalid',
        message: `目标内容不能超过 ${GROUP_CONTROL_GOAL_MAX_LENGTH} 字。`,
      });
    }
    const taken = consume(ctx, token);
    if ('failure' in taken) return replyFailure(ctx, taken.failure);
    if (taken.panel.stage !== 'goal-form') {
      return replyFailure(ctx, { status: 'invalid', message: '⚠️ 请重新打开目标表单。' });
    }
    const auth = await authorize(ctx);
    if ('failure' in auth) return replyFailure(ctx, auth.failure);
    const checked = await revalidate(auth.project, taken.panel, ctx.operatorOpenId);
    if ('failure' in checked) return replyFailure(ctx, checked.failure);
    const tierFail = tierFailure(ctx, checked.view);
    if (tierFail) return replyFailure(ctx, tierFail);
    if (!checked.view.goalSupported) {
      return replyFailure(ctx, { status: 'unsupported', message: '当前后端不支持自主目标。' });
    }
    if (checked.view.status !== 'idle') {
      return replyFailure(ctx, { status: 'busy', message: '⚠️ 所选会话正在运行，暂不能启动目标。' });
    }
    const result = await deps.startGoalSession({
      project: auth.project,
      session: checked.view,
      objective,
      operatorOpenId: ctx.operatorOpenId,
      sourceMessageId: ctx.sourceMessageId,
    });
    if (result.status === 'ok') {
      await safeText(ctx, '🎯 已确认启动自主目标，请在所选话题查看运行卡片。');
    } else {
      await replyFailure(ctx, result);
    }
    return result;
  }

  async function goalEnd(ctx: GroupControlContext, token: string | undefined): Promise<GroupControlResult> {
    const taken = consume(ctx, token);
    if ('failure' in taken) return replyFailure(ctx, taken.failure);
    if (taken.panel.stage !== 'panel') return replyFailure(ctx, { status: 'invalid', message: '⚠️ 请刷新面板后重试。' });
    const auth = await authorize(ctx);
    if ('failure' in auth) return replyFailure(ctx, auth.failure);
    const checked = await revalidate(auth.project, taken.panel, ctx.operatorOpenId);
    if ('failure' in checked) return replyFailure(ctx, checked.failure);
    const tierFail = tierFailure(ctx, checked.view);
    if (tierFail) return replyFailure(ctx, tierFail);
    if (checked.view.status !== 'goal-running' || checked.view.runToken === undefined) {
      return replyFailure(ctx, { status: 'stale', message: '⚠️ 所选会话的目标状态已变化，请刷新面板。' });
    }
    if (checked.view.runToken !== taken.panel.runToken) {
      return replyFailure(ctx, { status: 'stale', message: '⚠️ 该目标运行已被替换，请刷新面板。' });
    }
    if (!ownerOrAdmin(ctx, checked.view)) {
      return replyFailure(ctx, { status: 'denied', message: '⚠️ 仅发起人或管理员可结束目标。' });
    }
    const result = await deps.endGoalSession({
      project: auth.project,
      sessionKey: checked.view.key,
      runToken: checked.view.runToken,
      operatorOpenId: ctx.operatorOpenId,
      sourceMessageId: ctx.sourceMessageId,
    });
    // Fire-and-forget interrupt: never claim the goal was cleared.
    if (result.status === 'ok') await safeText(ctx, '已请求结束目标并停止，请查看运行状态');
    else await replyFailure(ctx, result);
    return result;
  }

  return {
    openSessions,
    openHelp,
    select,
    page,
    refresh,
    continueSession: continueSelected,
    interrupt: interruptSelected,
    goalForm,
    goalSubmit,
    goalEnd,
    shutdown: () => {
      closed = true;
      pending.clear();
    },
    pendingCount: () => pending.size,
  };
}
