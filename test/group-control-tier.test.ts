import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema';
import { botDir, useBotDir } from '../src/config/paths';

// The entry-card rotation hook reads this bot's group-menu state; keep it away
// from real state (read-only here, but isolation keeps tests deterministic).
const testBotId = `vitest-group-control-tier-${process.pid}`;
beforeAll(() => {
  useBotDir(testBotId);
});
afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(botDir(testBotId), { recursive: true, force: true }).catch(() => undefined);
});

/**
 * End-to-end (dispatcher → controller → backend projection) coverage of the
 * #admin / #guest ownership policy. The denial paths never start an agent run,
 * so only the platform/registry seams need fakes here.
 */
const fake = vi.hoisted(() => ({
  backend: {
    capabilities: { goal: true, steer: true },
    id: 'codex',
    displayName: 'Codex',
    listModels: vi.fn(async () => []),
    resumeThread: vi.fn(),
    startThread: vi.fn(),
  },
  send: vi.fn(async () => ({})),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
  project: {
    name: 'p',
    chatId: 'chat',
    cwd: '/test',
    kind: 'multi' as 'multi' | 'single',
    allowedUsers: [] as string[],
    mode: 'workspace-write' as 'workspace-write' | 'read-only' | 'danger-full-access',
    guestMode: 'read-only' as 'workspace-write' | 'read-only' | 'danger-full-access',
  },
  records: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/core/logger', () => ({
  log: fake.log,
  withTrace: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../src/agent', async (original) => ({
  ...(await original<object>()),
  createBackend: () => fake.backend,
}));
vi.mock('../src/project/registry', async (original) => ({
  ...(await original<object>()),
  getProjectByChatId: async () => ({ ...fake.project }),
}));
vi.mock('../src/bot/session-store', async (original) => ({
  ...(await original<object>()),
  listSessions: async () => fake.records,
  getSession: async (key: string) => fake.records.find((record) => record.threadId === key),
  patchSession: async () => undefined,
  upsertSession: async () => undefined,
}));
vi.mock('../src/bot/session-title-coordinator', () => ({
  SessionTitleCoordinator: class {
    startRecovery() {}
    async register() {
      return undefined;
    }
    async shutdown() {}
  },
}));
vi.mock('../src/card/run-card-stream', () => ({
  RunCardStream: class {
    async create() {
      return 'card';
    }
    getCardId() {
      return 'card_entity';
    }
    async updateElement() {
      return true;
    }
    streamCoalesced() {}
    async drain() {}
    setImageWorker() {}
    async settleImages() {
      return new Map();
    }
    async updateCard() {
      return true;
    }
    async finalizeCard() {
      return true;
    }
    stats() {
      return { pushCount: 0, cardPushes: 0, elPushes: 0, totalRttMs: 0, maxRttMs: 0 };
    }
  },
}));

import { createOrchestrator } from '../src/bot/handle-message';
import { GC, GROUP_CONTROL_GOAL_INPUT } from '../src/bot/group-controls';

interface CallbackValue {
  a: string;
  t?: string;
  k?: string;
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
    for (const child of Object.values(object)) values(child, out);
  }
  return out;
}

function parseCard(json: string): unknown {
  return JSON.parse(json);
}

function cfg(): AppConfig {
  return {
    accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
    preferences: { access: { ownerOpenId: 'owner' } },
  } as AppConfig;
}

interface Harness {
  orchestrator: ReturnType<typeof createOrchestrator>;
  appCfg: AppConfig;
  cards: string[];
  click: (
    action: string,
    value?: Record<string, unknown>,
    user?: string,
    formValue?: Record<string, unknown>,
  ) => Promise<void>;
}

function setup(): Harness {
  const cards: string[] = [];
  let messageSeq = 0;
  const channel = {
    send: fake.send,
    rawClient: {
      cardkit: {
        v1: {
          card: {
            create: async (payload: { data: { data: string } }) => {
              cards.push(payload.data.data);
              return { data: { card_id: `card_${cards.length}` } };
            },
            update: async () => ({}),
          },
        },
      },
      im: {
        v1: {
          message: {
            create: async () => {
              messageSeq += 1;
              return { data: { message_id: `msg_${messageSeq}` } };
            },
            reply: async () => {
              messageSeq += 1;
              return { data: { message_id: `msg_${messageSeq}` } };
            },
          },
        },
      },
    },
  } as never;
  const appCfg = cfg();
  const orchestrator = createOrchestrator(channel, appCfg, '/test');
  return {
    orchestrator,
    appCfg,
    cards,
    click: (action, value = {}, user = 'owner', formValue) =>
      orchestrator.dispatcher.handle({
        chatId: 'chat',
        messageId: 'source-card',
        operator: { openId: user },
        action: { tag: 'button', value: { a: action, ...value } },
        ...(formValue ? { raw: { action: { form_value: formValue } } } : {}),
      } as never),
  };
}

const adminRecord = {
  threadId: 'topic#admin',
  chatId: 'chat',
  sessionId: 'sess-admin',
  backend: 'codex',
  cwd: '/test',
  summary: '管理员会话',
  updatedAt: 2,
};
const guestRecord = {
  threadId: 'topic#guest',
  chatId: 'chat',
  sessionId: 'sess-guest',
  backend: 'codex',
  cwd: '/test',
  summary: '访客会话',
  updatedAt: 1,
};

let h: Harness;

beforeEach(() => {
  vi.clearAllMocks();
  fake.records = [adminRecord, guestRecord];
  fake.project.kind = 'multi';
  fake.project.allowedUsers = [];
  h = setup();
});

afterEach(async () => {
  await h.orchestrator.shutdown();
});

describe('group control tier policy (orchestrator level)', () => {
  it('omits #admin sessions from a non-admin picker', async () => {
    await h.click(GC.sessions, {}, 'guest');
    await vi.waitFor(() => expect(h.cards).toHaveLength(1));
    const selections = values(parseCard(h.cards[0]!)).filter((value) => value.a === GC.select);
    expect(selections.map((value) => value.k)).toEqual(['topic#guest']);
  });

  it('refuses a forged #admin selection and never sends an admin panel', async () => {
    await h.click(GC.sessions, {}, 'guest');
    await vi.waitFor(() => expect(h.cards).toHaveLength(1));
    const token = values(parseCard(h.cards[0]!)).find((value) => value.a === GC.select)?.t;
    expect(token).toBeTruthy();

    await h.click(GC.select, { t: token, k: 'topic#admin' }, 'guest');
    await vi.waitFor(() =>
      expect(fake.send).toHaveBeenCalledWith(
        'chat',
        expect.objectContaining({ markdown: expect.stringContaining('管理员会话') }),
        expect.anything(),
      ),
    );
    expect(h.cards).toHaveLength(1);
  });

  it('denies continue on an #admin panel after the operator is demoted', async () => {
    await h.click(GC.sessions, {}, 'owner');
    await vi.waitFor(() => expect(h.cards).toHaveLength(1));
    const selections = values(parseCard(h.cards[0]!)).filter((value) => value.a === GC.select);
    expect(selections.map((value) => value.k)).toEqual(['topic#admin', 'topic#guest']);
    const adminSelection = selections.find((value) => value.k === 'topic#admin')!;

    await h.click(GC.select, { t: adminSelection.t, k: 'topic#admin' }, 'owner');
    await vi.waitFor(() => expect(h.cards).toHaveLength(2));
    const continueToken = values(parseCard(h.cards[1]!)).find((value) => value.a === GC.continue)?.t;
    expect(continueToken).toBeTruthy();

    // Demotion happens between panel issue and click.
    h.appCfg.preferences!.access!.ownerOpenId = 'someone-else';
    await h.click(GC.continue, { t: continueToken }, 'owner');

    await vi.waitFor(() =>
      expect(fake.send).toHaveBeenCalledWith(
        'chat',
        expect.objectContaining({ markdown: expect.stringMatching(/无权|管理员/) }),
        expect.anything(),
      ),
    );
    expect(fake.backend.startThread).not.toHaveBeenCalled();
  });

  it('denies goal submission on an #admin session after demotion', async () => {
    await h.click(GC.sessions, {}, 'owner');
    await vi.waitFor(() => expect(h.cards).toHaveLength(1));
    const selection = values(parseCard(h.cards[0]!)).find(
      (value) => value.a === GC.select && value.k === 'topic#admin',
    )!;
    await h.click(GC.select, { t: selection.t, k: 'topic#admin' }, 'owner');
    await vi.waitFor(() => expect(h.cards).toHaveLength(2));
    const goalFormToken = values(parseCard(h.cards[1]!)).find((value) => value.a === GC.goalForm)?.t;
    expect(goalFormToken).toBeTruthy();
    await h.click(GC.goalForm, { t: goalFormToken }, 'owner');
    await vi.waitFor(() => expect(h.cards).toHaveLength(3));
    const submitToken = values(parseCard(h.cards[2]!)).find((value) => value.a === GC.goalSubmit)?.t;
    expect(submitToken).toBeTruthy();

    h.appCfg.preferences!.access!.ownerOpenId = 'someone-else';
    await h.click(GC.goalSubmit, { t: submitToken }, 'owner', { [GROUP_CONTROL_GOAL_INPUT]: '越权目标' });

    await vi.waitFor(() =>
      expect(fake.send).toHaveBeenCalledWith(
        'chat',
        expect.objectContaining({ markdown: expect.stringMatching(/无权|管理员/) }),
        expect.anything(),
      ),
    );
    expect(fake.backend.startThread).not.toHaveBeenCalled();
  });
});
