import { describe, expect, it, vi } from 'vitest';
import { createAccountCommands, type AccountMessage } from '../src/account/native-commands';
import { CcSwitchControlError } from '../src/account/cc-switch-control';
import { assertAccountReady, isAccountTransitioning, withAccountTransition } from '../src/account/transition';

const id = 'ccs-aeda2df6ebc6';
function fixture() {
  const options = {
    isAdmin: vi.fn(() => true), isBusy: vi.fn(() => false), reply: vi.fn(async (_m: AccountMessage, _s: string) => {}),
    list: vi.fn(async () => [{id, maskedEmail:'f***@example.com', isDefault:true}]),
    status: vi.fn(async () => '共享后台：f***@example.com'), setup: vi.fn(async () => ({ready:true as const})),
    activate: vi.fn(async (_id: string) => ({ready:true as const, emailHash:'a'.repeat(64)})),
    check: vi.fn(async (_id: string) => ({ready:true as const, emailHash:'a'.repeat(64)})),
    recover: vi.fn(async (_hash: string) => ({maskedEmail:'f***@example.com'})),
  };
  const handler = createAccountCommands(options);
  const message = (content: string, chatType = 'p2p'): AccountMessage => ({content, chatType, senderId:'owner'});
  const text = () => options.reply.mock.calls.map(call => call[1]).join('\n');
  return {options, handler, message, text};
}
describe('native account commands bypass model execution', () => {
  it('lists masked stable account IDs without activating accounts or querying a model', async () => {
    const f=fixture(); expect(await f.handler.handle(f.message('/account'))).toBe(true);
    expect(f.text()).toContain(id); expect(f.text().replace(/\\/g, '')).toContain('f***@example.com');
    expect(f.options.activate).not.toHaveBeenCalled(); expect(f.options.recover).not.toHaveBeenCalled();
  });
  it('leaves ordinary messages to the existing dispatcher', async () => {
    const f=fixture(); expect(await f.handler.handle(f.message('请继续工作'))).toBe(false); expect(f.options.reply).not.toHaveBeenCalled();
  });
  it('denies non-admins before reading any account metadata', async () => {
    const f=fixture(); f.options.isAdmin.mockReturnValue(false); await f.handler.handle(f.message('/account'));
    expect(f.options.list).not.toHaveBeenCalled(); expect(f.text()).toContain('仅管理员');
  });
  it('redirects group requests to private chat without exposing the account list', async () => {
    const f=fixture(); await f.handler.handle(f.message('/account','group'));
    expect(f.options.list).not.toHaveBeenCalled(); expect(f.text()).toContain('私聊'); expect(f.text()).not.toContain('@example.com');
  });
  it.each(['/account switch '+id, '/account switch 1 --restart', '/account switch '+id+' --restart extra', '/account switch x;shutdown --restart'])('rejects ambiguous or unconfirmed action: %s', async input => {
    const f=fixture(); await f.handler.handle(f.message(input)); await f.handler.drain();
    expect(f.options.activate).not.toHaveBeenCalled(); expect(f.options.recover).not.toHaveBeenCalled();
  });
  it('refuses to change accounts while an existing task is still running', async () => {
    const f=fixture(); f.options.isBusy.mockReturnValue(true); await f.handler.handle(f.message('/account switch '+id+' --restart'));
    expect(f.options.activate).not.toHaveBeenCalled(); expect(f.text()).toContain('仍有任务');
  });
  it('switches through the external adapter before restarting and reports only verified success', async () => {
    const f=fixture(); await f.handler.handle(f.message('/account switch '+id+' --restart')); await f.handler.drain();
    expect(f.options.activate).toHaveBeenCalledWith(id); expect(f.options.recover).toHaveBeenCalledWith('a'.repeat(64));
    expect(f.options.activate.mock.invocationCallOrder[0]).toBeLessThan(f.options.recover.mock.invocationCallOrder[0]!);
    expect(f.text()).toContain('后台已核验'); expect(f.text()).toContain('未发送续跑'); expect(isAccountTransitioning()).toBe(false);
  });
  it('recover verifies a manually selected account without activating a card again', async () => {
    const f=fixture(); await f.handler.handle(f.message('/account recover '+id+' --restart')); await f.handler.drain();
    expect(f.options.check).toHaveBeenCalledWith(id); expect(f.options.activate).not.toHaveBeenCalled(); expect(f.options.recover).toHaveBeenCalled();
  });
  it('does not restart after an adapter timeout or claim completion', async () => {
    const f=fixture(); f.options.activate.mockRejectedValue(new CcSwitchControlError('adapter_timeout'));
    await f.handler.handle(f.message('/account switch '+id+' --restart')); await f.handler.drain();
    expect(f.options.recover).not.toHaveBeenCalled(); expect(f.text()).not.toContain('后台已核验'); expect(isAccountTransitioning()).toBe(false);
  });
  it('keeps a partial activation distinct from verified runtime completion', async () => {
    const f=fixture(); f.options.recover.mockRejectedValue(new Error('secret must never be returned'));
    await f.handler.handle(f.message('/account switch '+id+' --restart')); await f.handler.drain();
    expect(f.text()).toContain('后台尚未完成核验'); expect(f.text()).toContain('/account recover'); expect(f.text()).not.toContain('secret must');
  });
  it('rejects a removed account before calling the external adapter', async () => {
    const f=fixture(); f.options.list.mockResolvedValue([]); await f.handler.handle(f.message('/account switch '+id+' --restart')); await f.handler.drain();
    expect(f.options.activate).not.toHaveBeenCalled(); expect(f.text()).toContain('账号已不存在');
  });
  it('setup only checks the adapter and never changes an account', async () => {
    const f=fixture(); await f.handler.handle(f.message('/account setup')); expect(f.options.setup).toHaveBeenCalled();
    expect(f.options.activate).not.toHaveBeenCalled(); expect(f.options.recover).not.toHaveBeenCalled(); expect(f.text()).toContain('尚未切换');
  });
  it('does not activate an account if the initial acknowledgment cannot be sent', async () => {
    const f=fixture(); f.options.reply.mockRejectedValueOnce(new Error('network'));
    await f.handler.handle(f.message('/account switch '+id+' --restart'));await f.handler.drain();
    expect(f.options.activate).not.toHaveBeenCalled();expect(isAccountTransitioning()).toBe(false);
  });
  it('does not misreport verified runtime success as failed after a delivery error', async () => {
    const f=fixture();f.options.reply.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('network'));
    await f.handler.handle(f.message('/account switch '+id+' --restart'));await f.handler.drain();
    expect(f.text()).toContain('后台身份已核验');expect(f.text()).not.toContain('后台尚未完成核验');
  });
  it('status invokes only the read-only native management path', async () => {
    const f=fixture(); await f.handler.handle(f.message('/account status')); expect(f.options.status).toHaveBeenCalled();
    expect(f.options.activate).not.toHaveBeenCalled(); expect(f.options.recover).not.toHaveBeenCalled();
  });
  it('blocks a second action while the first is waiting on the external tool', async () => {
    const f=fixture(); let release!: () => void;
    f.options.activate.mockImplementation(async () => {await new Promise<void>(resolve => {release=resolve;});return {ready:true,emailHash:'a'.repeat(64)};});
    await f.handler.handle(f.message('/account switch '+id+' --restart')); await vi.waitFor(() => expect(f.options.activate).toHaveBeenCalledTimes(1));
    expect(isAccountTransitioning()).toBe(true); expect(() => assertAccountReady()).toThrow('账号正在切换');
    await f.handler.handle(f.message('/account status')); expect(f.options.status).not.toHaveBeenCalled();
    release(); await f.handler.drain(); expect(isAccountTransitioning()).toBe(false);
  });
  it('clears the transition after a failure and rejects overlapping operations', async () => {
    await expect(withAccountTransition(async () => {expect(() => assertAccountReady()).toThrow(); throw new Error('failed');})).rejects.toThrow('failed');
    expect(isAccountTransitioning()).toBe(false);
  });
});
