import { Command } from 'commander';
import { bridgeVersion } from '../core/version';
import { runDoctor } from './commands/doctor';
import { runRun } from './commands/run';
import { runStart, runStop, runRestart, runStatus, runLogs } from './commands/daemon';
import { runUpdate } from './commands/update';
import { runBotInit, runBotList, runBotUse, runBotRm } from './commands/bot';
import { runWeb } from './commands/web';
import { runDaemonControl } from './commands/daemon-control';
import { runWinRelaunch } from '../service/win-startup';
import { secretsGet, secretsSet, secretsList, secretsRemove } from './commands/secrets';
import {
  runFleetSetup, runFleetStatus, runFleetDisable,
  runFleetRelaySetupCommand, runFleetRelayStatusCommand, runFleetRelayDisable,
} from './commands/fleet';

const program = new Command();

program
  .name('feishu-codex-bridge')
  .description('把飞书/Lark 桥接到本机 Codex（项目=群, 话题=会话）')
  .version(bridgeVersion());

// ── 进程 / 守护 ──────────────────────────────────────────────
program
  .command('run')
  .description('前台启动活跃机器人（多个则各自独立进程；没配置则先扫码 init；Ctrl+C 优雅退出）')
  .option('--bot <name>', '只启动指定的一个机器人（名字或 appId）')
  .action(async (options: { bot?: string }) => {
    await runRun(options.bot);
  });

program
  .command('start')
  .description('后台 daemon 启动（装 launchd 开机自启；没配置则先扫码 init）')
  .action(async () => {
    await runStart();
  });

program
  .command('stop')
  .description('停止后台 daemon 并关闭开机自启')
  .action(async () => {
    await runStop();
  });

program
  .command('restart')
  .description('重启后台 daemon')
  .action(async () => {
    await runRestart();
  });

program
  .command('status')
  .description('后台 daemon 状态（pid / 日志路径 / 上次退出码）')
  .action(async () => {
    await runStatus();
  });

program
  .command('logs')
  .description('查看后台 daemon 日志')
  .option('-f, --follow', '持续跟随日志')
  .action(async (options: { follow?: boolean }) => {
    await runLogs(Boolean(options.follow));
  });

program
  .command('update')
  .description('更新到最新版（npm i -g），并自动重启后台 daemon')
  .option('--check', '只检查有无新版，不安装')
  .action(async (options: { check?: boolean }) => {
    await runUpdate({ check: Boolean(options.check) });
  });

program
  .command('web')
  .description('本机 Web 控制台（只读预览，仅 127.0.0.1 + token；写操作随 daemon 集成开放）')
  .option('--port <port>', '监听端口（默认 51847）')
  .action(async (options: { port?: string }) => {
    await runWeb({ port: options.port !== undefined ? Number(options.port) : undefined });
  });

// 内部命令：Web 控制台「重启 / 升级」按钮 detached spawn 的 helper 入口。脱离
// daemon 进程执行 service.restart()（升级则先 npm i -g 再重启），不对外暴露。
program
  .command('__daemon-control <action>', { hidden: true })
  .action(async (action: string) => {
    await runDaemonControl(action);
  });

// 内部命令（Windows 专用）：restartWinStartup 经 WMI/计划任务在「daemon 进程树之外」
// 拉起的 relauncher 入口。它 taskkill 旧 daemon → 等其真死 → startNow 起新，绝不会
// 像旧的进程内重启那样把自己一起杀掉。不对外暴露。
program
  .command('__win-relaunch [requestPath]', { hidden: true })
  .action(async (requestPath?: string) => {
    await runWinRelaunch({ requestPath });
  });

// ── 飞书机器人管理 ───────────────────────────────────────────
const bot = program.command('bot').description('飞书机器人管理（多机器人）');
bot
  .command('init [name]')
  .description('扫码注册一个飞书机器人并授权（可选短名）')
  .action(async (name?: string) => {
    await runBotInit(name);
  });
bot
  .command('list')
  .description('列出已注册的飞书机器人')
  .action(async () => {
    await runBotList();
  });
bot
  .command('use [names...]')
  .description('勾选/指定要同时连接的机器人（多选）；无参数弹交互式勾选框')
  .action(async (names: string[]) => {
    await runBotUse(names ?? []);
  });
bot
  .command('rm <name>')
  .description('移除一个机器人配置')
  .action(async (name: string) => {
    await runBotRm(name);
  });

// ── 杂项 ─────────────────────────────────────────────────────
const fleet = program.command('fleet').description('多电脑接入（默认关闭，各机独立执行）');
fleet.command('setup').description('配置同一机器人和共享表，注册当前电脑；需先停止本机后台')
  .requiredOption('--name <name>', '本机显示名称')
  .requiredOption('--base <url>', '共享飞书多维表格链接或 app token')
  .option('--app-id <id>', '新电脑复用已有机器人的 App ID')
  .option('--owner <openId>', '新电脑管理员 open_id')
  .option('--tenant <tenant>', 'feishu 或 lark')
  .option('--secret-stdin', '从标准输入读取 App Secret，避免出现在命令历史中')
  .option('--poll-ms <ms>', '轮询间隔 5000–60000 毫秒，默认 15000')
  .action(runFleetSetup);
fleet.command('status').description('查看本机多电脑配置，不输出密钥').action(runFleetStatus);
fleet.command('disable').description('停用本机多电脑配置；中继模式将失败关闭，不回退长连接').action(runFleetDisable);

const relay = fleet.command('relay').description('可选云端实时中继（API-only worker；令牌只写入本机加密密钥库）');
relay.command('setup')
  .description('配置中继 worker；复用本机已有机器人凭据，不创建第二个机器人')
  .requiredOption('--url <wss-url>', '中继 WebSocket URL（固定 /relay/v1；公网必须 wss://）')
  .option('--name <name>', '电脑显示名称（默认沿用现有名称或主机名）')
  .option('--app-id <id>', '指定已配置的机器人 App ID')
  .requiredOption('--token-stdin', '从标准输入读取中继令牌（绝不出现在命令参数中）')
  .option('--proxy-url <local-proxy>', '仅用于中继 WebSocket 的本地 HTTP(S) 代理')
  .option('--import-from-bitable', '显式导入原 Bitable 目录的 nodes/routes（不复制指令/收件箱）')
  .action(async (options: Parameters<typeof runFleetRelaySetupCommand>[0]) => {
    await runFleetRelaySetupCommand(options);
  });
relay.command('status')
  .description('只读显示中继 transport/URL/名称/设备 ID，不输出令牌或密钥引用')
  .option('--app-id <id>', '指定已配置的机器人 App ID')
  .action(async (options: { appId?: string }) => {
    await runFleetRelayStatusCommand(options.appId);
  });
relay.command('disable')
  .description('停用中继配置；后续 start 失败关闭，不回退到本机飞书长连接')
  .action(async () => {
    await runFleetRelayDisable();
  });

program
  .command('doctor')
  .description('本地自检：codex / 登录 / lark-cli / 当前机器人配置')
  .action(async () => {
    await runDoctor();
  });

// Internal plumbing — the `secrets-getter` wrapper execs `secrets get` to
// resolve the App Secret from the keystore. Users never call it, so hide it
// from --help (still fully functional, just unlisted).
const secrets = program.command('secrets', { hidden: true }).description('本地加密密钥库（内部）');
secrets
  .command('get')
  .description('exec-provider 端点（从 stdin 读 JSON 请求）')
  .action(async () => {
    await secretsGet();
  });
secrets
  .command('set <id>')
  .description('存储密钥（值从 stdin 读）')
  .action(async (id: string) => {
    await secretsSet(id);
  });
secrets
  .command('list')
  .description('列出密钥 id')
  .action(async () => {
    await secretsList();
  });
secrets
  .command('remove <id>')
  .description('删除密钥')
  .action(async (id: string) => {
    await secretsRemove(id);
  });

program
  .command('hook', { hidden: true })
  .requiredOption('--agent <agent>', 'claude or codex')
  .option('--bot <nameOrAppId>', 'target bot name or appId')
  .action(async (options: { agent: string; bot?: string }) => {
    const { runHookCommand } = await import('../cli-bridge');
    await runHookCommand(options.agent, options.bot);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
