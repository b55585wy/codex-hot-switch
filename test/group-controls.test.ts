import { describe, expect, it } from 'vitest';
import type { CardObject } from '../src/card/cards';
import {
  accessTierOfKey,
  createGroupControls,
  GROUP_CONTROL_GOAL_INPUT,
  GROUP_CONTROL_GOAL_MAX_LENGTH,
  resolveRunTier,
  type GroupControlContext,
  type GroupControlDeps,
  type GroupControlProjectView,
  type GroupControlSessionView,
} from '../src/bot/group-controls';

interface CallbackValue {
  a: string;
  t?: string;
  k?: string;
  p?: number;
}

function values(node: unknown, out: CallbackValue[] = []): CallbackValue[] {
  if (Array.isArray(node)) {
    for (const item of node) values(item, out);
  } else if (node && typeof node === 'object') {
    const object = node as Record<string, unknown>;
    if (Array.isArray(object.behaviors)) {
      for (const behavior of object.behaviors) {
        if (behavior && typeof behavior === 'object' && (behavior as { type?: string }).type === 'callback') {
          const value = (behavior as { value?: CallbackValue }).value;
          if (value && typeof value.a === 'string') out.push(value);
        }
      }
    }
    for (const value of Object.values(object)) values(value, out);
  }
  return out;
}

function tokenFor(card: CardObject, action: string): string {
  const value = values(card).find((item) => item.a === action && typeof item.t === 'string');
  if (!value?.t) throw new Error(`missing token for ${action}: ${JSON.stringify(card).slice(0, 300)}`);
  return value.t;
}

function session(overrides: Partial<GroupControlSessionView> = {}): GroupControlSessionView {
  return {
    key: 'topic-1',
    title: '修复登录',
    status: 'idle',
    accessTier: 'shared',
    backendName: 'Codex',
    goalSupported: true,
    settingsSupported: false,
    sessionId: 'sess-1',
    backend: 'codex',
    cwd: '/work/p',
    ...overrides,
  };
}

interface Harness {
  deps: GroupControlDeps;
  project: GroupControlProjectView;
  sessions: GroupControlSessionView[];
  calls: Array<{ name: string; input?: unknown }>;
  cards: CardObject[];
  texts: string[];
  setSession: (value: GroupControlSessionView | undefined) => void;
  setSessions: (value: GroupControlSessionView[]) => void;
  setPermission: (signature: string) => void;
  setAccountTransition: (value: boolean) => void;
  setAllowed: (value: boolean) => void;
  setAdmin: (value: boolean) => void;
  advance: (ms: number) => void;
}

function harness(overrides: Partial<GroupControlDeps> = {}, kind: 'single' | 'multi' = 'single'): Harness {
  const project: GroupControlProjectView = {
    name: 'cloud-repo',
    chatId: 'oc_1',
    kind,
    backendName: 'Codex',
    goalSupported: true,
    permissionSignature: 'sig-1',
    allowedUsers: [],
  };
  let list: GroupControlSessionView[] = [session()];
  let accountTransition = false;
  let allowed = true;
  let admin = false;
  let clock = 1_000_000;
  let seq = 0;
  const calls: Harness['calls'] = [];
  const cards: CardObject[] = [];
  const texts: string[] = [];

  const deps: GroupControlDeps = {
    now: () => clock,
    randomId: () => `token-${++seq}`,
    isChatAllowed: () => true,
    isUserAllowedInProject: () => allowed,
    isAdmin: () => admin,
    isAccountTransitioning: () => accountTransition,
    getProject: async () => project,
    listSessions: async () => list,
    getSession: async (_project, key) => list.find((item) => item.key === key),
    sendCard: async (_chatId, card) => {
      cards.push(card);
    },
    sendText: async (_chatId, text) => {
      texts.push(text);
    },
    continueSession: async (input) => {
      calls.push({ name: 'continue', input });
      return { status: 'ok' };
    },
    interruptSession: async (input) => {
      calls.push({ name: 'interrupt', input });
      return { status: 'ok' };
    },
    startGoalSession: async (input) => {
      calls.push({ name: 'start-goal', input });
      return { status: 'ok' };
    },
    endGoalSession: async (input) => {
      calls.push({ name: 'end-goal', input });
      return { status: 'ok' };
    },
    ...overrides,
  };

  return {
    deps,
    project,
    get sessions() {
      return list;
    },
    calls,
    cards,
    texts,
    setSession: (value) => {
      if (!value) {
        list = [];
        return;
      }
      const index = list.findIndex((item) => item.key === value.key);
      if (index === -1) list = [value];
      else list = list.map((item, itemIndex) => (itemIndex === index ? value : item));
    },
    setSessions: (value) => {
      list = value;
    },
    setPermission: (signature) => {
      project.permissionSignature = signature;
    },
    setAccountTransition: (value) => {
      accountTransition = value;
    },
    setAllowed: (value) => {
      allowed = value;
    },
    setAdmin: (value) => {
      admin = value;
    },
    advance: (ms) => {
      clock += ms;
    },
  };
}

const ctx = (overrides: Partial<GroupControlContext> = {}): GroupControlContext => ({
  chatId: 'oc_1',
  operatorOpenId: 'ou_user',
  sourceMessageId: 'om_source',
  ...overrides,
});

describe('group controls: listing and selection', () => {
  it('opens an explicit picker for multiple sessions and never selects implicitly', async () => {
    const h = harness({}, 'multi');
    h.setSessions([
      session({ key: 'topic-1', title: 'one' }),
      session({ key: 'topic-2', title: 'two' }),
    ]);
    const controls = createGroupControls(h.deps);
    const before = h.calls.length;
    expect(await controls.openSessions(ctx())).toEqual({ status: 'ok' });
    expect(h.calls.length).toBe(before);
    expect(h.cards).toHaveLength(1);
    const card = h.cards[0]!;
    const selectValues = values(card).filter((value) => value.a === 'gc.select');
    expect(selectValues.map((value) => value.k)).toEqual(['topic-1', 'topic-2']);
    expect(JSON.stringify(card)).not.toContain('gc.continue');
  });

  it('still shows an explicit picker for a multi group with exactly one session', async () => {
    const h = harness({}, 'multi');
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    const card = h.cards[0]!;
    expect(values(card).some((value) => value.a === 'gc.select')).toBe(true);
    // Never implicitly open a panel from a list of one.
    expect(values(card).some((value) => value.a === 'gc.continue')).toBe(false);
  });

  it('opens a direct panel only for project.kind === single', async () => {
    const h = harness();
    h.project.kind = 'single';
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    const card = h.cards[0]!;
    expect(values(card).some((value) => value.a === 'gc.continue')).toBe(true);
    expect(values(card).some((value) => value.a === 'gc.select')).toBe(false);
  });

  it('shows the empty state without callbacks', async () => {
    const h = harness();
    h.setSessions([]);
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    expect(JSON.stringify(h.cards[0]!)).toContain('暂无可操作的会话');
    expect(values(h.cards[0]!)).toEqual([]);
  });

  it('validates select against re-read server sessions and binds exact metadata', async () => {
    const h = harness({}, 'multi');
    h.setSessions([session({ key: 'a' }), session({ key: 'b', sessionId: 'sess-b' })]);
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    const pickerToken = tokenFor(h.cards[0]!, 'gc.select');

    expect(await controls.select(ctx(), pickerToken, 'b')).toEqual({ status: 'ok' });
    const panel = h.cards[1]!;
    expect(values(panel).some((value) => value.a === 'gc.continue')).toBe(true);
    const continueToken = tokenFor(panel, 'gc.continue');
    expect(continueToken).not.toBe(pickerToken);

    expect(await controls.continueSession(ctx(), continueToken)).toEqual({ status: 'ok' });
    const call = h.calls.find((item) => item.name === 'continue')!;
    expect(call.input).toMatchObject({
      session: { key: 'b', sessionId: 'sess-b', backend: 'codex', cwd: '/work/p' },
      operatorOpenId: 'ou_user',
    });
  });

  it('rejects a selection key that no longer exists', async () => {
    const h = harness({}, 'multi');
    h.setSessions([session({ key: 'a' }), session({ key: 'b' })]);
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    const pickerToken = tokenFor(h.cards[0]!, 'gc.select');
    h.setSessions([session({ key: 'a' })]);
    expect(await controls.select(ctx(), pickerToken, 'b')).toMatchObject({ status: 'stale' });
    expect(h.calls).toHaveLength(0);
  });

  it('paginates bounded lists and rotates the picker token', async () => {
    const h = harness({}, 'multi');
    h.setSessions(Array.from({ length: 25 }, (_, index) => session({ key: `k${index}`, title: `s${index}` })));
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    const firstToken = tokenFor(h.cards[0]!, 'gc.select');
    expect(values(h.cards[0]!).filter((value) => value.a === 'gc.select')).toHaveLength(10);

    expect(await controls.page(ctx(), firstToken, 1)).toEqual({ status: 'ok' });
    const second = h.cards[1]!;
    expect(values(second).filter((value) => value.a === 'gc.select')).toHaveLength(10);
    const secondToken = tokenFor(second, 'gc.select');
    expect(secondToken).not.toBe(firstToken);
    expect(JSON.stringify(second)).toContain('第 2/3 页');
  });
});

describe('group controls: token scope and lifecycle', () => {
  it('rejects other users and other chats without leaking a mutation', async () => {
    const h = harness();
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    const token = tokenFor(h.cards[0]!, 'gc.continue');

    expect(await controls.continueSession(ctx({ operatorOpenId: 'ou_other' }), token)).toMatchObject({
      status: 'denied',
    });
    expect(await controls.continueSession(ctx({ chatId: 'oc_other' }), token)).toMatchObject({ status: 'denied' });
    expect(h.calls).toHaveLength(0);

    // The legitimate owner's token was not consumed by the rejected attempts.
    expect(await controls.continueSession(ctx(), token)).toEqual({ status: 'ok' });
  });

  it('expires tokens after the TTL and on shutdown', async () => {
    const h = harness();
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    const expiredToken = tokenFor(h.cards[0]!, 'gc.continue');
    h.advance(15 * 60_000 + 1);
    expect(await controls.continueSession(ctx(), expiredToken)).toMatchObject({ status: 'expired' });

    await controls.openSessions(ctx());
    const liveToken = tokenFor(h.cards[1]!, 'gc.continue');
    controls.shutdown();
    expect(await controls.continueSession(ctx(), liveToken)).toMatchObject({ status: 'expired' });
  });

  it('consumes a mutation token before awaiting so a replay is a safe no-op', async () => {
    const h = harness();
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    const token = tokenFor(h.cards[0]!, 'gc.continue');
    expect(await controls.continueSession(ctx(), token)).toEqual({ status: 'ok' });
    expect(await controls.continueSession(ctx(), token)).toMatchObject({ status: 'expired' });
    expect(h.calls.filter((call) => call.name === 'continue')).toHaveLength(1);
  });

  it('fail-closes when the persisted session mapping changes', async () => {
    const h = harness();
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    const token = tokenFor(h.cards[0]!, 'gc.continue');
    h.setSession(session({ sessionId: 'sess-replaced' }));
    expect(await controls.continueSession(ctx(), token)).toMatchObject({ status: 'stale' });
    expect(h.calls).toHaveLength(0);
  });

  it('fail-closes when the project permission signature changes', async () => {
    const h = harness();
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    const token = tokenFor(h.cards[0]!, 'gc.continue');
    h.setPermission('sig-2');
    expect(await controls.continueSession(ctx(), token)).toMatchObject({ status: 'stale' });
    expect(h.calls).toHaveLength(0);
  });

  it('rejects when the account is transitioning or the user lost access', async () => {
    const h = harness();
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    const token = tokenFor(h.cards[0]!, 'gc.continue');
    h.setAccountTransition(true);
    expect(await controls.continueSession(ctx(), token)).toMatchObject({ status: 'busy' });

    h.setAccountTransition(false);
    h.setAllowed(false);
    expect(await controls.openSessions(ctx())).toMatchObject({ status: 'denied' });
    expect(h.calls).toHaveLength(0);
  });

  it('refresh issues a new token and the old one stays dead', async () => {
    const h = harness();
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    const oldToken = tokenFor(h.cards[0]!, 'gc.continue');
    expect(await controls.refresh(ctx(), oldToken)).toEqual({ status: 'ok' });
    const fresh = h.cards[1]!;
    const freshToken = tokenFor(fresh, 'gc.continue');
    expect(freshToken).not.toBe(oldToken);
    expect(await controls.continueSession(ctx(), oldToken)).toMatchObject({ status: 'expired' });
    expect(await controls.continueSession(ctx(), freshToken)).toEqual({ status: 'ok' });
  });
});

describe('group controls: continue and interrupt', () => {
  it('does not continue a busy or goal-running session', async () => {
    const h = harness();
    h.setSession(session({ status: 'running', runToken: {} }));
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    const token = tokenFor(h.cards[0]!, 'gc.interrupt');
    const runningCard = h.cards[0]!;
    expect(values(runningCard).some((value) => value.a === 'gc.continue')).toBe(false);
    expect(token).toBeTruthy();

    h.setSession(session({ status: 'goal-running', runToken: {} }));
    await controls.openSessions(ctx());
    const goalCard = h.cards[1]!;
    expect(values(goalCard).some((value) => value.a === 'gc.continue')).toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it('interrupts only the exact ordinary run and honors owner-or-admin', async () => {
    const runToken = { run: 1 };
    const h = harness();
    h.setSession(session({ status: 'running', runToken, runOwnerOpenId: 'ou_owner' }));
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx({ operatorOpenId: 'ou_owner' }));
    const token = tokenFor(h.cards[0]!, 'gc.interrupt');
    expect(await controls.interrupt(ctx({ operatorOpenId: 'ou_owner' }), token)).toEqual({ status: 'ok' });
    expect(h.calls.find((call) => call.name === 'interrupt')?.input).toMatchObject({
      sessionKey: 'topic-1',
      runToken,
    });

    // A different run on the same key invalidates the old panel token.
    const h2 = harness();
    const oldRun = { run: 1 };
    h2.setSession(session({ status: 'running', runToken: oldRun, runOwnerOpenId: 'ou_owner' }));
    const controls2 = createGroupControls(h2.deps);
    await controls2.openSessions(ctx({ operatorOpenId: 'ou_owner' }));
    const token2 = tokenFor(h2.cards[0]!, 'gc.interrupt');
    h2.setSession(session({ status: 'running', runToken: { run: 2 }, runOwnerOpenId: 'ou_owner' }));
    expect(await controls2.interrupt(ctx({ operatorOpenId: 'ou_owner' }), token2)).toMatchObject({ status: 'stale' });
    expect(h2.calls).toHaveLength(0);
  });

  it('denies non-owner non-admin and allows an admin', async () => {
    const runToken = { run: 1 };
    const h = harness();
    h.setSession(session({ status: 'running', runToken, runOwnerOpenId: 'ou_owner' }));
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx({ operatorOpenId: 'ou_stranger' }));
    const token = tokenFor(h.cards[0]!, 'gc.interrupt');
    expect(await controls.interrupt(ctx({ operatorOpenId: 'ou_stranger' }), token)).toMatchObject({ status: 'denied' });

    await controls.openSessions(ctx({ operatorOpenId: 'ou_admin' }));
    const adminToken = tokenFor(h.cards[1]!, 'gc.interrupt');
    h.setAdmin(true);
    expect(await controls.interrupt(ctx({ operatorOpenId: 'ou_admin' }), adminToken)).toEqual({ status: 'ok' });
  });

  it('never offers ordinary interrupt on a goal-running session', async () => {
    const h = harness();
    h.setSession(session({ status: 'goal-running', runToken: { goal: 1 }, runOwnerOpenId: 'ou_user' }));
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    const card = h.cards[0]!;
    expect(values(card).some((value) => value.a === 'gc.interrupt')).toBe(false);
    expect(values(card).some((value) => value.a === 'gc.goal.end')).toBe(true);
  });
});

describe('group controls: goals', () => {
  it('rejects goal actions when the selected backend does not support goals', async () => {
    const h = harness();
    h.setSession(session({ goalSupported: false }));
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    const card = h.cards[0]!;
    expect(values(card).some((value) => value.a === 'gc.goal.form')).toBe(false);
    expect(await controls.goalForm(ctx(), tokenFor(card, 'gc.continue'))).toMatchObject({ status: 'unsupported' });
    expect(h.calls).toHaveLength(0);
  });

  it('validates empty and overlength objectives before starting a goal', async () => {
    const h = harness();
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    const panelToken = tokenFor(h.cards[0]!, 'gc.goal.form');
    expect(await controls.goalForm(ctx(), panelToken)).toEqual({ status: 'ok' });
    const formToken = tokenFor(h.cards[1]!, 'gc.goal.submit');

    // Empty/overlength submissions are pure validation failures: they consume
    // no token and start no goal.
    expect(await controls.goalSubmit(ctx(), formToken, { [GROUP_CONTROL_GOAL_INPUT]: '   ' })).toMatchObject({
      status: 'invalid',
    });
    expect(h.calls).toHaveLength(0);

    await controls.openSessions(ctx());
    const secondPanel = tokenFor(h.cards[2]!, 'gc.goal.form');
    await controls.goalForm(ctx(), secondPanel);
    const overToken = tokenFor(h.cards[3]!, 'gc.goal.submit');
    expect(
      await controls.goalSubmit(ctx(), overToken, {
        [GROUP_CONTROL_GOAL_INPUT]: 'x'.repeat(GROUP_CONTROL_GOAL_MAX_LENGTH + 1),
      }),
    ).toMatchObject({ status: 'invalid' });
    expect(h.calls).toHaveLength(0);
  });

  it('starts an autonomous goal on the exact selected session with a bounded objective', async () => {
    const h = harness();
    const controls = createGroupControls(h.deps);
    h.setSession(session({ sessionId: 'sess-exact', backend: 'codex', cwd: '/work/exact' }));
    await controls.openSessions(ctx());
    await controls.goalForm(ctx(), tokenFor(h.cards[0]!, 'gc.goal.form'));
    const formToken = tokenFor(h.cards[1]!, 'gc.goal.submit');
    expect(
      await controls.goalSubmit(ctx(), formToken, { [GROUP_CONTROL_GOAL_INPUT]: '  把单测跑绿  ' }),
    ).toEqual({ status: 'ok' });
    expect(h.calls.find((call) => call.name === 'start-goal')?.input).toMatchObject({
      objective: '把单测跑绿',
      session: { key: 'topic-1', sessionId: 'sess-exact', backend: 'codex', cwd: '/work/exact' },
      operatorOpenId: 'ou_user',
    });
    // Replay is a safe no-op.
    expect(await controls.goalSubmit(ctx(), formToken, { [GROUP_CONTROL_GOAL_INPUT]: 'again' })).toMatchObject({
      status: 'expired',
    });
    expect(h.calls.filter((call) => call.name === 'start-goal')).toHaveLength(1);
  });

  it('ends a goal through the stop interrupt path and never claims the goal was cleared', async () => {
    const runToken = { goal: 1 };
    const h = harness();
    h.setSession(session({ status: 'goal-running', runToken, runOwnerOpenId: 'ou_user', goalObjective: '完成测试' }));
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    const card = h.cards[0]!;
    expect(JSON.stringify(card)).toContain('结束目标并停止');
    expect(await controls.goalEnd(ctx(), tokenFor(card, 'gc.goal.end'))).toEqual({ status: 'ok' });
    expect(h.calls.find((call) => call.name === 'end-goal')?.input).toMatchObject({ sessionKey: 'topic-1', runToken });
    expect(h.texts).toContain('已请求结束目标并停止，请查看运行状态');
    expect(h.texts.join('\n')).not.toContain('已清除');
  });

  it('denies goal end to a non-owner non-admin', async () => {
    const h = harness();
    h.setSession(session({ status: 'goal-running', runToken: {}, runOwnerOpenId: 'ou_owner' }));
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx({ operatorOpenId: 'ou_stranger' }));
    const token = tokenFor(h.cards[0]!, 'gc.goal.end');
    expect(await controls.goalEnd(ctx({ operatorOpenId: 'ou_stranger' }), token)).toMatchObject({ status: 'denied' });
    expect(h.calls).toHaveLength(0);
  });
});

describe('group controls: tier ownership (#admin / #guest)', () => {
  it('classifies session keys and never lets a target key elevate the caller', () => {
    expect(accessTierOfKey('topic')).toBe('shared');
    expect(accessTierOfKey('topic#admin')).toBe('admin');
    expect(accessTierOfKey('topic#guest')).toBe('guest');
    // key tier is authoritative; caller can demote only
    expect(resolveRunTier('admin', true)).toBe('admin');
    expect(resolveRunTier('admin', false)).toBe('guest');
    expect(resolveRunTier('guest', true)).toBe('guest');
    expect(resolveRunTier('guest', false)).toBe('guest');
    expect(resolveRunTier('shared', true)).toBe('admin');
    expect(resolveRunTier('shared', false)).toBe('guest');
  });

  it('hides #admin sessions from a non-admin list', async () => {
    const h = harness({}, 'multi');
    h.setSessions([
      session({ key: 'topic#admin', title: 'admin', accessTier: 'admin' }),
      session({ key: 'topic#guest', title: 'guest', accessTier: 'guest', sessionId: 'sess-g' }),
    ]);
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    const selections = values(h.cards[0]!).filter((value) => value.a === 'gc.select');
    expect(selections.map((value) => value.k)).toEqual(['topic#guest']);

    h.setAdmin(true);
    await controls.openSessions(ctx());
    const all = values(h.cards[1]!).filter((value) => value.a === 'gc.select');
    expect(all.map((value) => value.k)).toEqual(['topic#admin', 'topic#guest']);
  });

  it('refuses a forged #admin selection from a guest without mutating anything', async () => {
    const h = harness({}, 'multi');
    h.setSessions([
      session({ key: 'topic#admin', title: 'admin', accessTier: 'admin' }),
      session({ key: 'topic#guest', title: 'guest', accessTier: 'guest', sessionId: 'sess-g' }),
    ]);
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    const pickerToken = tokenFor(h.cards[0]!, 'gc.select');
    const result = await controls.select(ctx(), pickerToken, 'topic#admin');
    expect(result).toMatchObject({ status: 'denied', message: expect.stringContaining('管理员会话') });
    expect(h.calls).toHaveLength(0);
    expect(h.cards).toHaveLength(1);
  });

  it('rejects continue on an #admin panel once the operator is no longer admin', async () => {
    const h = harness();
    h.setAdmin(true);
    h.setSession(session({ key: 'topic#admin', accessTier: 'admin', sessionId: 'sess-a' }));
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    const token = tokenFor(h.cards[0]!, 'gc.continue');
    // Demotion between issue and click: the token still carries the old panel,
    // but authorization is re-evaluated against live state.
    h.setAdmin(false);
    expect(await controls.continueSession(ctx(), token)).toMatchObject({ status: 'denied' });
    expect(h.calls).toHaveLength(0);
  });

  it('rejects goal start on an #admin panel once the operator is no longer admin', async () => {
    const h = harness();
    h.setAdmin(true);
    h.setSession(session({ key: 'topic#admin', accessTier: 'admin', sessionId: 'sess-a' }));
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    await controls.goalForm(ctx(), tokenFor(h.cards[0]!, 'gc.goal.form'));
    const formToken = tokenFor(h.cards[1]!, 'gc.goal.submit');
    h.setAdmin(false);
    expect(
      await controls.goalSubmit(ctx(), formToken, { [GROUP_CONTROL_GOAL_INPUT]: '越权' }),
    ).toMatchObject({ status: 'denied' });
    expect(h.calls).toHaveLength(0);
  });

  it('rejects interrupt/end-goal on an #admin session for a demoted operator', async () => {
    const runToken = { run: 7 };
    const h = harness();
    h.setAdmin(true);
    h.setSession(session({ key: 'topic#admin', accessTier: 'admin', status: 'running', runToken, runOwnerOpenId: 'ou_owner' }));
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    const token = tokenFor(h.cards[0]!, 'gc.interrupt');
    h.setAdmin(false);
    expect(await controls.interrupt(ctx(), token)).toMatchObject({ status: 'denied' });
    expect(h.calls).toHaveLength(0);

    const h2 = harness();
    h2.setAdmin(true);
    h2.setSession(
      session({ key: 'topic#admin', accessTier: 'admin', status: 'goal-running', runToken, runOwnerOpenId: 'ou_owner' }),
    );
    const controls2 = createGroupControls(h2.deps);
    await controls2.openSessions(ctx());
    const endToken = tokenFor(h2.cards[0]!, 'gc.goal.end');
    h2.setAdmin(false);
    expect(await controls2.goalEnd(ctx(), endToken)).toMatchObject({ status: 'denied' });
    expect(h2.calls).toHaveLength(0);
  });

  it('keeps #guest sessions operable by an admin but bound to the guest tier', async () => {
    const h = harness();
    h.setAdmin(true);
    h.setSession(session({ key: 'topic#guest', accessTier: 'guest', sessionId: 'sess-g' }));
    const controls = createGroupControls(h.deps);
    await controls.openSessions(ctx());
    expect(await controls.continueSession(ctx(), tokenFor(h.cards[0]!, 'gc.continue'))).toEqual({ status: 'ok' });
    // The controller binds the exact guest key; the run tier itself is clamped by
    // resolveRunTier('guest', true) === 'guest' in the orchestrator.
    expect(h.calls.find((call) => call.name === 'continue')?.input).toMatchObject({
      session: { key: 'topic#guest', sessionId: 'sess-g' },
    });
  });
});
