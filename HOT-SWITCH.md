# Codex 多终端热切换与飞书控制

本仓库包含飞书桥完整源码，以及通过 seven332/codex-switch 0.3.2 接入的受管 Codex 账号切换功能。

## 使用

1. 安装 Node.js 24+、Codex CLI 和 codex-switch 0.3.2。
2. 本机执行 `codex-switch login account-a` 和 `codex-switch login account-b`，录入自己的账号。
3. 在各项目终端运行 `scripts/codex-managed.ps1`；可追加 `resume <session-id>` 恢复已有会话。
4. 管理员在机器人私聊发送 `/runtime`、`/runtime usage` 或 `/runtime switch account-a`。
5. 飞书原生菜单配置见 [BOT-MENU.md](docs/BOT-MENU.md)，完整操作说明见 [RUNTIME-SWITCH.md](docs/RUNTIME-SWITCH.md)。

未受管的既有进程不能被接管。启动时工具可能按额度策略自动选择账号；切换中的请求可能需要重试。飞书查询及切号命令由本地代码处理，不依赖模型推理。

## 验证与范围

2026-11-03 在 Windows、Codex CLI 0.166.0、codex-switch 0.3.2 环境验证：飞书发起 B→A 切换后，两个受管终端的 `/status` 均显示 A，相关进程 ID 与启动时间保持不变。控制台菜单和账号查询已由用户确认可用。尚未实测真实额度耗尽后的恢复及切换后的模型请求。

类型检查、私有扩展构建及最终 67 个定向测试通过；此前 255 个私有扩展回归测试通过。

codex-switch 是独立上游项目：https://github.com/seven332/codex-switch 。本仓库不包含其二进制、账号数据或凭据。Windows 编译 0.3.2 时遇到上游 dead_code 检查错误，曾使用单次构建环境变量 `RUSTFLAGS=-A dead_code`，不修改上游源码。

## 源码来源

基础源码来自 https://github.com/b55585wy/feishu-codex-bridge ，保留原许可证及来源说明。本仓库作为独立源码快照保存，不包含本机日志、浏览器状态、运行数据、账号文件或部署备份。
