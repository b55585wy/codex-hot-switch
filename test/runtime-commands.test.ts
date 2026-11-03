import { describe, expect, it, vi } from 'vitest';
import { createRuntimeCommands, RUNTIME, type RuntimeMessage } from '../src/account/runtime-commands';
import {
  RuntimeSwitchError,
  type RuntimeSwitchAccount,
  type RuntimeSwitchOutcome,
  type RuntimeUsageReport,
} from '../src/account/runtime-switch';

const account: RuntimeSwitchAccount = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  shortId: 'abcd1234',
  name: 'Work',
  email: 'p***@example.com',
  planType: 'pro',
  authMode: 'chatgpt',
  current: true,
  autoSwitchDisabled: false,
};

const usage: RuntimeUsageReport = {
  generatedAt: 1_800_000_000,
  currentAccountId: account.id,
  accounts: [{
    account,
    status: 'ok',
    fiveHour: { usedPercent: 10, leftPercent: 90, windowMinutes: 300, resetsAt: 1_800_001_000 },
    weekly: { usedPercent: 25, leftPercent: 75, windowMinutes: 10_080, resetsAt: 1_800_100_000 },
  }],
};

const switched: RuntimeSwitchOutcome = {
  alias: 'abcd1234',
  commandCompleted: true,
  runtimeVerified: false,
  switchedTo: { name: 'Work', shortId: 'abcd1234' },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixture() {
  const options = {
    isAdmin: vi.fn((_sender: string) => true),
    isBusy: vi.fn(() => false),
    isTransitioning: vi.fn(() => false),
    reply: vi.fn(async (_message: RuntimeMessage, _text: string) => {}),
    list: vi.fn(async () => [account]),
    usage: vi.fn(async () => usage),
    switchAccount: vi.fn(async (_alias: string) => switched),
  };
  const handler = createRuntimeCommands(options);
  const message = (content: string, chatType = 'p2p'): RuntimeMessage => ({
    content,
    chatType,
    senderId: 'owner',
  });
  const text = () => options.reply.mock.calls.map(call => call[1]).join('\n');
  return { options, handler, message, text };
}

describe('runtime commands', () => {
  it('leaves ordinary messages to the existing dispatcher', async () => {
    const f = fixture();
    expect(await f.handler.handle(f.message('请继续工作'))).toBe(false);
    expect(f.options.reply).not.toHaveBeenCalled();
  });

  it('rejects non-admins before reading account metadata', async () => {
    const f = fixture();
    f.options.isAdmin.mockReturnValue(false);
    expect(await f.handler.handle(f.message('/runtime'))).toBe(true);
    expect(f.options.list).not.toHaveBeenCalled();
    expect(f.options.usage).not.toHaveBeenCalled();
    expect(f.options.switchAccount).not.toHaveBeenCalled();
    expect(f.text()).toContain('仅管理员');
  });

  it('redirects group requests to private chat without listing accounts', async () => {
    const f = fixture();
    expect(await f.handler.handle(f.message('/runtime usage', 'group'))).toBe(true);
    expect(f.options.list).not.toHaveBeenCalled();
    expect(f.options.usage).not.toHaveBeenCalled();
    expect(f.text()).toContain('私聊');
    expect(f.text()).not.toContain('@example.com');
  });

  it('lists selectable accounts by default and keeps /runtime status separate', async () => {
    const f = fixture();
    await f.handler.handle(f.message('/runtime'));
    expect(f.options.list).toHaveBeenCalledTimes(1);
    expect(f.options.switchAccount).not.toHaveBeenCalled();
    expect(f.text()).toContain('Work');
    expect(f.text()).toContain('abcd1234');
    expect(f.text()).toContain('/runtime switch');
    expect(f.text()).not.toContain('只读查询');

    await f.handler.handle(f.message('/runtime status'));
    expect(f.options.list).toHaveBeenCalledTimes(2);
    expect(f.text()).toContain('只读查询');
    expect(f.text()).toContain('当前认证账号');
  });

  it('shows names, short ids and explicit switch usage on the default entry', async () => {
    const f = fixture();
    const second: RuntimeSwitchAccount = {
      ...account,
      id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
      shortId: 'beef5678',
      name: 'Personal',
      current: false,
    };
    f.options.list.mockResolvedValue([account, second]);

    await f.handler.handle(f.message('/runtime'));

    expect(f.text()).toContain('Work');
    expect(f.text()).toContain('abcd1234');
    expect(f.text()).toContain('Personal');
    expect(f.text()).toContain('beef5678');
    expect(f.text()).toContain('/runtime switch <短码或账号 ID>');
    expect(f.options.switchAccount).not.toHaveBeenCalled();
  });

  it('shows usage without switching', async () => {
    const f = fixture();
    await f.handler.handle(f.message('/runtime usage'));
    expect(f.options.usage).toHaveBeenCalledTimes(1);
    expect(f.options.switchAccount).not.toHaveBeenCalled();
    expect(f.text()).toContain('剩余 90.0%');
    expect(f.text()).toContain('剩余 75.0%');
  });

  it('gives a helpful no-account response', async () => {
    const f = fixture();
    f.options.list.mockResolvedValue([]);
    await f.handler.handle(f.message('/runtime'));
    expect(f.text()).toContain('尚未纳管任何账号');
    expect(f.text()).toContain('codex-switch login');
    expect(f.text()).toContain('不提供登录、导入或导出');
    expect(f.options.switchAccount).not.toHaveBeenCalled();
  });

  it.each([
    '/runtime switch',
    '/runtime switch --force',
    '/runtime switch -work',
    '/runtime switch a b',
    '/runtime switch abcd1234 extra',
    '/runtime switch x;rm -rf /',
    '/runtime unknown',
    '/runtime status extra',
  ])('rejects malformed or unsafe input: %s', async input => {
    const f = fixture();
    await f.handler.handle(f.message(input));
    await f.handler.drain();
    expect(f.options.switchAccount).not.toHaveBeenCalled();
    expect(f.options.list).not.toHaveBeenCalled();
    expect(f.text()).toContain('/runtime switch');
  });

  it('runs an explicit switch and keeps completion distinct from runtime verification', async () => {
    const f = fixture();
    await f.handler.handle(f.message('/runtime switch abcd1234'));
    await f.handler.drain();

    expect(f.options.switchAccount).toHaveBeenCalledWith('abcd1234');
    expect(f.text()).toContain('切换命令已完成');
    expect(f.text()).toContain('尚未独立核验');
    expect(f.text()).toContain('不能保证所有终端都已切换');
    expect(f.text()).not.toContain('所有终端已切换');
  });

  it('does not switch while the bridge has queued or running tasks', async () => {
    const f = fixture();
    f.options.isBusy.mockReturnValue(true);
    await f.handler.handle(f.message('/runtime switch abcd1234'));
    await f.handler.drain();
    expect(f.options.switchAccount).not.toHaveBeenCalled();
    expect(f.text()).toContain('仍有任务');
  });

  it('rejects a concurrent operation and leaves the first running', async () => {
    const f = fixture();
    const pending = deferred<RuntimeSwitchOutcome>();
    f.options.switchAccount.mockReturnValue(pending.promise);

    await f.handler.handle(f.message('/runtime switch abcd1234'));
    await vi.waitFor(() => expect(f.options.switchAccount).toHaveBeenCalledTimes(1));

    await f.handler.handle(f.message('/runtime status'));
    expect(f.options.list).not.toHaveBeenCalled();
    expect(f.text()).toContain('账号操作仍在执行');

    pending.resolve(switched);
    await f.handler.drain();
    expect(f.text()).toContain('切换命令已完成');
  });

  it('waits for an in-flight switch during async shutdown', async () => {
    const f = fixture();
    const pending = deferred<RuntimeSwitchOutcome>();
    f.options.switchAccount.mockReturnValue(pending.promise);

    await f.handler.handle(f.message('/runtime switch abcd1234'));
    await vi.waitFor(() => expect(f.options.switchAccount).toHaveBeenCalledTimes(1));

    let drained = false;
    const drain = f.handler.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    pending.resolve(switched);
    await drain;
    expect(drained).toBe(true);
  });

  it('maps tool failures to safe messages without raw error text', async () => {
    const cases: [RuntimeSwitchError, string][] = [
      [new RuntimeSwitchError('not_found'), '未找到 codex-switch'],
      [new RuntimeSwitchError('timeout'), '结果未确认'],
      [new RuntimeSwitchError('failed'), '退出码非 0'],
      [new RuntimeSwitchError('output_too_large'), '安全上限'],
      [new RuntimeSwitchError('invalid_output'), '格式无法验证'],
      [new RuntimeSwitchError('spawn_failed'), '无法启动'],
      [new RuntimeSwitchError('cleanup_required'), '未能确认退出'],
    ];
    for (const [error, expected] of cases) {
      const f = fixture();
      f.options.switchAccount.mockRejectedValue(error);
      await f.handler.handle(f.message('/runtime switch abcd1234'));
      await f.handler.drain();
      expect(f.text()).toContain(expected);
      expect(f.text()).not.toContain('SECRET');
    }
  });

  it('does not execute a switch when the acknowledgment cannot be delivered', async () => {
    const f = fixture();
    f.options.reply.mockRejectedValueOnce(new Error('network token=SECRET'));
    await f.handler.handle(f.message('/runtime switch abcd1234'));
    await f.handler.drain();
    expect(f.options.switchAccount).not.toHaveBeenCalled();
    expect(f.options.reply).toHaveBeenCalledTimes(2);
  });

  it('does not misreport a completed switch as failed when the result reply fails', async () => {
    const f = fixture();
    f.options.reply
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('network token=SECRET'));
    await f.handler.handle(f.message('/runtime switch abcd1234'));
    await f.handler.drain();
    expect(f.options.switchAccount).toHaveBeenCalledTimes(1);
    expect(f.text()).toContain('切换命令已完成');
    expect(f.text()).not.toContain('退出码非 0');
    expect(f.text()).not.toContain('SECRET');
  });

  it('dispatches runtime menu keys as read-only text', async () => {
    const f = fixture();
    const send = vi.fn(async (_text: string) => {});

    expect(await f.handler.handleMenu('dm.settings', send)).toBe(false);
    expect(send).not.toHaveBeenCalled();

    expect(await f.handler.handleMenu(RUNTIME.accounts, send)).toBe(true);
    const accountsText = send.mock.calls.at(-1)![0];
    expect(accountsText).toContain('/runtime switch');
    expect(accountsText).toContain('已纳管');
    expect(accountsText).toContain('不会自动切换');
    expect(f.options.switchAccount).not.toHaveBeenCalled();

    expect(await f.handler.handleMenu(RUNTIME.status, send)).toBe(true);
    expect(send.mock.calls.at(-1)![0]).toContain('只读查询');

    expect(await f.handler.handleMenu(RUNTIME.usage, send)).toBe(true);
    expect(f.options.usage).toHaveBeenCalledTimes(1);
    expect(send.mock.calls.at(-1)![0]).toContain('剩余 90.0%');
    expect(f.options.switchAccount).not.toHaveBeenCalled();
  });

  it('does not read account data from a menu click during a transition', async () => {
    const f = fixture();
    f.options.isTransitioning.mockReturnValue(true);
    const send = vi.fn(async (_text: string) => {});
    await f.handler.handleMenu(RUNTIME.accounts, send);
    expect(f.options.list).not.toHaveBeenCalled();
    expect(send.mock.calls[0]![0]).toContain('仍在执行');
  });
});
