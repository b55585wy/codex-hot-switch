import type { CcSwitchAccountSummary } from './cc-switch-accounts';
import { CcSwitchControlError, type ControlResult } from './cc-switch-control';
import { CodexRuntimeError } from './codex-runtime';
import { isAccountTransitioning, withAccountTransition } from './transition';

export interface AccountMessage { chatType: string; senderId: string; content: string }
export interface AccountCommandOptions<M extends AccountMessage> {
  isAdmin(sender: string): boolean;
  isBusy(): boolean;
  reply(message: M, text: string): Promise<void>;
  list(): Promise<CcSwitchAccountSummary[]>;
  status(): Promise<string>;
  setup(): Promise<ControlResult>;
  activate(id: string): Promise<ControlResult>;
  check(id: string): Promise<ControlResult>;
  recover(emailHash: string): Promise<{ maskedEmail: string }>;
}
const HELP = '账号管理命令（不调用模型）\n/account：已存账号\n/account status：当前共享后台账号\n/account setup：检查 CC Switch 适配器\n/account switch <账号代号> --restart：切换并刷新后台\n/account recover <账号代号> --restart：只刷新已切好的账号\n\n会保留原会话绑定；刷新共享后台可能中断其他窗口的请求。独立终端需自行重连。';
const ACCOUNT_ID = /^ccs-[0-9a-f]{12}$/;
function safeLabel(value: string): string { return value.replace(/[\\`*_[\]<>()]/g, '\\$&'); }
function failureMessage(error: unknown): string {
  if (error instanceof CodexRuntimeError) return error.message;
  if (error instanceof CcSwitchControlError) {
    if (error.code === 'setup_required') return '尚未启用 CC Switch 适配器，请先查看 docs/ACCOUNT-CONTROL.md 并运行 /account setup。';
    if (error.code === 'adapter_timeout') return 'CC Switch 适配器未响应。原版没有此控制入口，需先安装本项目提供的适配补丁。';
    if (error.code === 'provider_not_found' || error.code === 'provider_not_bound') return '所选账号没有绑定的官方提供商卡，请先在 CC Switch 中完成绑定。';
    if (error.code === 'reauth_required') return 'CC Switch 标记所选账号需要重新登录，请先在 CC Switch 中处理。';
    if (error.code === 'provider_ambiguous') return '所选账号绑定了多张官方卡，暂不自动选择，请先在 CC Switch 中明确绑定。';
    if (error.code === 'account_not_found') return '账号已不存在，请重新运行 /account 获取最新列表。';
  }
  return '本机操作未完成或结果未通过校验，请检查适配器后重试。';
}
export function createAccountCommands<M extends AccountMessage>(options: AccountCommandOptions<M>) {
  const jobs = new Set<Promise<void>>();
  async function handle(message: M): Promise<boolean> {
    const text = message.content.trim();
    if (!/^\/account(?:\s|$)/i.test(text)) return false;
    if (!options.isAdmin(message.senderId)) { await options.reply(message, '⛔ 仅管理员可管理本机 Codex 账号。'); return true; }
    if (message.chatType !== 'p2p') { await options.reply(message, '请私聊机器人发送 /account 管理账号。'); return true; }
    const parts = text.split(/\s+/);
    const command = parts[1]?.toLowerCase() ?? 'list';
    if (isAccountTransitioning()) { await options.reply(message, '账号操作仍在执行，请等待结果后再发送指令。'); return true; }
    if (command === 'switch' || command === 'recover') {
      const id = parts[2] ?? '';
      if (!ACCOUNT_ID.test(id) || parts.length !== 4 || parts[3] !== '--restart') {
        await options.reply(message, HELP); return true;
      }
      if (options.isBusy()) { await options.reply(message, 'Bridge 仍有任务执行或排队，请待任务结束后再切号。'); return true; }
      const job = withAccountTransition(async () => {
        let cardActivated = false;
        let runtimeVerified = false;
        try {
          if (!(await options.list()).some(account => account.id === id)) throw new CcSwitchControlError('account_not_found');
          await options.reply(message, `正在处理 ${id}。本机工具完成切号和后台核验，不调用模型。`);
          const result = command === 'switch' ? await options.activate(id) : await options.check(id);
          cardActivated = command === 'switch';
          if (!result.emailHash) throw new CcSwitchControlError('untrusted_response');
          const verified = await options.recover(result.emailHash);
          runtimeVerified = true;
          await options.reply(message, `✅ Codex 后台已核验为 ${safeLabel(verified.maskedEmail)}。\n原项目、话题与 session 绑定保留。请回原话题发送“继续”；Bridge 未发送续跑指令。`);
        } catch (error) {
          if (runtimeVerified) {
            await options.reply(message, '⚠️ 后台身份已核验，但结果消息未确认送达。可用 /account status 查看。').catch(() => undefined);
            return;
          }
          const state = cardActivated ? `CC Switch 已返回切卡成功，Codex 后台尚未完成核验。\n修复后可运行 /account recover ${id} --restart。\n`
            : '操作结果未确认，未报告换号成功。\n';
          await options.reply(message, '⚠️ ' + state + failureMessage(error)).catch(() => undefined);
        }
      });
      jobs.add(job);
      void job.catch(() => undefined).finally(() => jobs.delete(job));
      return true;
    }
    try {
      if (parts.length > 2) { await options.reply(message, HELP); return true; }
      if (command === 'list') {
        const accounts = await options.list();
        const list = accounts.map(account => `${account.id} · ${safeLabel(account.maskedEmail)}${account.isDefault ? ' · CC Switch 默认' : ''}\n/account switch ${account.id} --restart`).join('\n\n');
        await options.reply(message, (list || 'CC Switch 尚未保存 Codex OAuth 账号。') + '\n\n' + HELP);
      } else if (command === 'status') await options.reply(message, await options.status());
      else if (command === 'setup') { await options.setup(); await options.reply(message, '✅ 本机 CC Switch 适配器已通过校验；尚未切换账号。'); }
      else await options.reply(message, HELP);
    } catch (error) { await options.reply(message, '⚠️ ' + failureMessage(error)); }
    return true;
  }
  return { handle, drain: async () => { await Promise.allSettled([...jobs]); } };
}
