import {
  isSafeRuntimeSelector,
  RuntimeSwitchError,
  type RuntimeAccountUsage,
  type RuntimeSwitchAccount,
  type RuntimeSwitchOutcome,
  type RuntimeUsageReport,
  type RuntimeUsageWindow,
} from './runtime-switch';

/**
 * Native `/runtime` commands and bot-menu text handlers.
 *
 * These run before DM console and group task dispatch, never touch a model,
 * and never fall back to automatic switching. Only an explicit
 * `/runtime switch <alias|id>` starts a local codex-switch command.
 */

export interface RuntimeMessage {
  chatType: string;
  senderId: string;
  content: string;
}

export interface RuntimeMenuKeys {
  accounts: 'runtime.accounts';
  status: 'runtime.status';
  usage: 'runtime.usage';
}

export const RUNTIME: RuntimeMenuKeys = {
  accounts: 'runtime.accounts',
  status: 'runtime.status',
  usage: 'runtime.usage',
} as const;

const MENU_KEYS = new Set<string>(Object.values(RUNTIME));

const HELP = [
  '运行时账号命令（本机 codex-switch 0.3.2，不调用模型）',
  '/runtime：查看当前认证账号与已纳管账号',
  '/runtime status：只读状态',
  '/runtime usage：只读查询所有账号用量',
  '/runtime switch <短码或账号 ID>：显式切换认证账号',
  '',
  '仅管理员、仅私聊。切换只更新 codex-switch/Codex 认证；不重启 Bridge，不接管已有终端，也不代表所有终端都已切换。登录、导入、导出请在本机终端执行。',
].join('\n');

const NO_ACCOUNTS = [
  'codex-switch 尚未纳管任何账号。',
  '请在运行 Bridge 的本机终端完成首次登录：`codex-switch login <名称>`。',
  '飞书端不提供登录、导入或导出；完成后回到这里发送 /runtime。',
].join('\n');

function safeLabel(value: string): string {
  // Keep Markdown inline code and links from being broken by an account name.
  return value.replace(/[\\`*_[\]<>()]/g, '\\$&');
}

function formatWindow(window: RuntimeUsageWindow): string {
  const left = window.leftPercent;
  if (left === null) return '用量未知';
  return `剩余 ${left.toFixed(1)}%`;
}

function usageStatusLabel(status: RuntimeAccountUsage['status']): string | undefined {
  if (status === 'ok') return undefined;
  if (status === 'unsupported') return '不支持查询';
  if (status === 'unavailable') return '当前不可用';
  return '查询失败';
}

function accountLine(account: RuntimeSwitchAccount): string {
  const marks = [
    account.current ? '当前认证账号' : undefined,
    account.autoSwitchDisabled ? '已排除自动选择' : undefined,
  ].filter(Boolean);
  return [
    `\`${safeLabel(account.name)}\` · ${account.shortId}`,
    ...(account.email ? [account.email] : []),
    ...(account.planType ? [account.planType] : []),
    ...(marks.length ? [marks.join(' · ')] : []),
  ].join(' · ');
}

const MAX_LISTED_ACCOUNTS = 20;

function listWindow<T>(values: T[]): T[] {
  return values.slice(0, MAX_LISTED_ACCOUNTS);
}

function formatAccounts(accounts: RuntimeSwitchAccount[], menu: boolean): string {
  if (accounts.length === 0) return NO_ACCOUNTS;
  const lines = listWindow(accounts).map(account => `- ${accountLine(account)}`);
  if (accounts.length > MAX_LISTED_ACCOUNTS) lines.push(`- …另有 ${accounts.length - MAX_LISTED_ACCOUNTS} 个账号未展开`);
  const current = accounts.find(account => account.current);
  return [
    `**Codex 运行时账号**（只读；当前：${current ? `\`${safeLabel(current.name)}\` (${current.shortId})` : '未标记'}）`,
    ...lines,
    '',
    '范围和操作：只列出本机 codex-switch 已纳管账号；未纳管/未登录账号不会出现，也不会自动切换。',
    menu
      ? '切换必须显式发送：`/runtime switch <短码或账号 ID>`。'
      : '要切换账号，必须显式发送：`/runtime switch <短码或账号 ID>`。',
  ].join('\n');
}

function formatStatus(accounts: RuntimeSwitchAccount[]): string {
  if (accounts.length === 0) return NO_ACCOUNTS;
  const current = accounts.find(account => account.current);
  return [
    '**Codex 运行时状态**（只读查询，未切换账号）',
    `当前认证账号：${current ? `\`${safeLabel(current.name)}\` (${current.shortId})` : '未标记'}`,
    `已纳管账号：${accounts.length} 个`,
    '',
    '该结果来自 codex-switch 账号库与 Codex 认证标记，不等同于核验每个已打开终端的运行身份；查询不会自动切号。',
  ].join('\n');
}

function formatUsage(report: RuntimeUsageReport): string {
  if (report.accounts.length === 0) return NO_ACCOUNTS;
  const lines = listWindow(report.accounts).map(entry => {
    const suffix = usageStatusLabel(entry.status);
    return `- ${accountLine(entry.account)} · 5 小时${formatWindow(entry.fiveHour)} · 每周${formatWindow(entry.weekly)}${suffix ? ` · ${suffix}` : ''}`;
  });
  if (report.accounts.length > MAX_LISTED_ACCOUNTS) {
    lines.push(`- …另有 ${report.accounts.length - MAX_LISTED_ACCOUNTS} 个账号未展开`);
  }
  return [
    '**Codex 运行时用量**（只读查询，未切换账号）',
    ...lines,
    '',
    '数据来自 `codex-switch usage --all --json`；查询不会自动切换账号。',
  ].join('\n');
}

function failureMessage(error: unknown): string {
  if (error instanceof RuntimeSwitchError) {
    if (error.code === 'invalid_alias') return HELP;
    if (error.code === 'not_found') {
      return '⚠️ 未找到 codex-switch。请确认 0.3.2 可执行文件在 PATH 中，或通过 CODEX_SWITCH_BIN 指定本机路径。';
    }
    if (error.code === 'timeout') return '⚠️ codex-switch 超时，结果未确认；本次没有重试。';
    if (error.code === 'output_too_large') return '⚠️ codex-switch 输出超出安全上限，已停止读取；结果未确认。';
    if (error.code === 'invalid_output') return '⚠️ codex-switch 返回的数据格式无法验证，未报告成功。';
    if (error.code === 'failed') return '⚠️ codex-switch 未成功完成（退出码非 0），未重试，运行身份未核验。';
    if (error.code === 'busy') return '⚠️ 另一个账号操作仍在执行，请等待结果后再发送指令。';
    if (error.code === 'cleanup_required') {
      return '⚠️ 上一次切换进程未能确认退出，已禁止新的切换以免出现第二个写入者。请在本机确认 codex-switch 已退出后重启 Bridge。';
    }
    if (error.code === 'spawn_failed') return '⚠️ 无法启动 codex-switch，运行身份未核验。';
  }
  return '⚠️ 本机操作未完成或结果未通过校验，未报告切换成功。';
}

export function formatSwitchSuccess(result: RuntimeSwitchOutcome): string {
  const target = result.switchedTo
    ? `\`${safeLabel(result.switchedTo.name)}\`${result.switchedTo.shortId ? ` (${result.switchedTo.shortId})` : ''}`
    : `\`${safeLabel(result.alias)}\``;
  return [
    `✅ codex-switch 切换命令已完成：${target}。`,
    '运行身份**尚未独立核验**；此入口不会重启 Bridge，也不会接管已在运行的终端。',
    '- 下一次新请求才会使用新账号；',
    '- 切换瞬间仍在进行的请求可能继续使用旧账号或失败；',
    '- 本命令不能保证所有终端都已切换。',
  ].join('\n');
}

export interface RuntimeCommandOptions<M extends RuntimeMessage> {
  isAdmin(sender: string): boolean;
  isBusy(): boolean;
  isTransitioning?: () => boolean;
  reply(message: M, text: string): Promise<void>;
  list(): Promise<RuntimeSwitchAccount[]>;
  usage(): Promise<RuntimeUsageReport>;
  switchAccount(alias: string): Promise<RuntimeSwitchOutcome>;
}

export function createRuntimeCommands<M extends RuntimeMessage>(options: RuntimeCommandOptions<M>) {
  const jobs = new Set<Promise<void>>();
  let switching = false;
  const isTransitioning = options.isTransitioning ?? (() => false);

  function accountBusy(): boolean {
    return switching || isTransitioning();
  }

  async function switchJob(message: M, alias: string): Promise<void> {
    try {
      try {
        await options.reply(
          message,
          `正在执行 codex-switch 切换 ${alias}。命令只在本机运行一次；不会重启 Bridge、接管终端或调用模型。`,
        );
      } catch {
        // No confirmation → no switch. This mirrors /account's safety rule.
        await options.reply(message, '⚠️ 未能发送切换确认，未执行切换。').catch(() => undefined);
        return;
      }

      let result: RuntimeSwitchOutcome;
      try {
        result = await options.switchAccount(alias);
      } catch (error) {
        await options.reply(message, failureMessage(error)).catch(() => undefined);
        return;
      }

      try {
        await options.reply(message, formatSwitchSuccess(result));
      } catch {
        // The local command already completed; never rewrite that as failure.
        await options.reply(message, '⚠️ 切换命令已完成，但结果消息未确认送达。可用 /runtime status 查看。')
          .catch(() => undefined);
      }
    } finally {
      switching = false;
    }
  }

  async function handle(message: M): Promise<boolean> {
    const text = message.content.trim();
    if (!/^\/runtime(?:\s|$)/i.test(text)) return false;
    if (!options.isAdmin(message.senderId)) {
      await options.reply(message, '⛔ 仅管理员可管理本机 Codex 运行时账号。');
      return true;
    }
    if (message.chatType !== 'p2p') {
      await options.reply(message, '请私聊机器人发送 /runtime 管理运行时账号。');
      return true;
    }
    if (accountBusy()) {
      await options.reply(message, '账号操作仍在执行，请等待结果后再发送指令。');
      return true;
    }

    const parts = text.split(/\s+/);
    // Bare `/runtime` is the entry point: list stored accounts and the exact
    // switch command. `/runtime status` stays the narrow status view.
    const command = (parts[1] ?? '').toLowerCase();

    if (command === 'switch') {
      if (parts.length !== 3) {
        await options.reply(message, HELP);
        return true;
      }
      const alias = parts[2] ?? '';
      if (!isSafeRuntimeSelector(alias)) {
        await options.reply(message, HELP);
        return true;
      }
      if (options.isBusy()) {
        await options.reply(message, 'Bridge 仍有任务执行或排队，请待任务结束后再切换运行时账号。');
        return true;
      }
      switching = true;
      const job = switchJob(message, alias);
      jobs.add(job);
      void job.catch(() => undefined).finally(() => jobs.delete(job));
      return true;
    }

    if ((command !== '' && command !== 'status' && command !== 'usage') || parts.length > 2) {
      await options.reply(message, HELP);
      return true;
    }

    try {
      if (command === 'usage') {
        await options.reply(message, formatUsage(await options.usage()));
      } else if (command === 'status') {
        await options.reply(message, formatStatus(await options.list()));
      } else {
        await options.reply(message, formatAccounts(await options.list(), false));
      }
    } catch (error) {
      await options.reply(message, failureMessage(error));
    }
    return true;
  }

  /** Bot-menu entry (`application.bot.menu_v6`). Admin gate stays in onBotMenu. */
  async function handleMenu(key: string | undefined, send: (text: string) => Promise<void>): Promise<boolean> {
    if (!key || !MENU_KEYS.has(key)) return false;
    if (accountBusy()) {
      await send('⚠️ 另一个账号操作仍在执行，请等待结果后再点菜单。').catch(() => undefined);
      return true;
    }
    try {
      if (key === RUNTIME.accounts) await send(formatAccounts(await options.list(), true));
      else if (key === RUNTIME.usage) await send(formatUsage(await options.usage()));
      else await send(formatStatus(await options.list()));
    } catch (error) {
      await send(failureMessage(error)).catch(() => undefined);
    }
    return true;
  }

  return {
    handle,
    handleMenu,
    drain: async () => { await Promise.allSettled([...jobs]); },
    help: HELP,
  };
}
