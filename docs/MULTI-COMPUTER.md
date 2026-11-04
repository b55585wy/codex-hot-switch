# 一个飞书机器人，多台电脑执行

多电脑模式保留现有 Bridge 的项目群、话题、账号管理和完成通知，在事件进入原处理链前选择执行电脑。每台电脑使用自己的 Codex 登录、账号池、项目目录和算力。飞书多维表格保存电脑目录、路由和待投递指令；不需要自建云端计算服务器。

默认关闭。没有 `fleet.enabled: true` 的配置继续走原单机流程。先在独立测试机器人下验证两台电脑，再切换已有机器人；同一个机器人不能混接未升级的旧实例。

## 准备

- 两台电脑均安装 Node.js 24 或更新版本，本机 Codex 已安装、登录并能正常执行任务。
- 两台使用相同的本仓库版本，并已运行 `npm ci --ignore-scripts` 和 `npm run build`。
- 两台复用同一个飞书自建机器人的 App ID / App Secret，第二台不要重新扫码创建机器人。
- 准备一张专用飞书多维表格，给予机器人编辑权限，并在应用权限中开通 `bitable:app` 或覆盖表和记录读写的等效权限，发布生效。
- 管理员 open_id 使用同一个飞书应用下的用户身份。不要提交 App Secret、登录凭据或生成的运行配置到 Git。

`fleet setup` 只创建 `Bridge电脑`、`Bridge路由`、`Bridge指令` 三张专用数据表，复用其他节点已经建好的同名表。不要把这三张表改作其他用途。共享表中的指令和元数据带来源校验，目标电脑仍执行本机权限检查。

## 第一台：已有 Windows Bridge

在本仓库的永久目录中操作。先备份现有运行配置，再通过旧版本的 `stop` 停止本机后台。`stop` 同时关闭自启动，最后的 `start` 会恢复。

```powershell
feishu-codex-bridge.cmd stop
node bin/feishu-codex-bridge.mjs fleet setup --name "Windows工作站" --base "https://你的租户.feishu.cn/base/表格token"
node bin/feishu-codex-bridge.mjs start
node bin/feishu-codex-bridge.mjs fleet status
```

使用本仓库的 `node bin/...`，避免误调用尚未升级的全局 CLI。当前电脑复用已有机器人配置，无需再次输入密钥。已有项目与会话在首次启用时归属本机，原 chatId、threadId、sessionId 和 cwd 保留。已有文档评论会话也从本地评论工作目录恢复路由。

自启动器会引用这个构建目录；启用后保留该目录及 Node.js 安装路径。

## 第二台：wangyidemacbookair

在 Mac 本机拉取同一分支，安装依赖并构建。以下为 macOS 默认 zsh 的示例；App ID、管理员 open_id 和 Base 链接使用你自己已有的值。

```zsh
git clone --branch feat/multi-computer-routing https://github.com/b55585wy/codex-hot-switch.git ~/codex-bridge
cd ~/codex-bridge
npm ci --ignore-scripts
npm run build
```

私有仓库需要 Mac 本机已有 GitHub 访问权限。然后安全读取密钥，避免将密钥写成命令参数或保存进 shell 历史：

```zsh
read -rs 'FLEET_APP_SECRET?飞书 App Secret: '; printf '\n'
printf '%s' "$FLEET_APP_SECRET" | node bin/feishu-codex-bridge.mjs fleet setup \
  --name wangyidemacbookair --base 'https://你的租户.feishu.cn/base/表格token' \
  --app-id 'cli_已有应用ID' --owner 'ou_管理员ID' --secret-stdin
unset FLEET_APP_SECRET
node bin/feishu-codex-bridge.mjs start
```

密钥写入 Mac 本地加密密钥库。设备 ID 在 Mac 上新建，不复制 Windows 的设备身份或整个运行数据目录。Mac 的后台与登录自启动继续使用原 launchd 实现。

配置中断时留下禁用的设备配置，重新执行 setup 会复用该身份；只有共享目录初始化完成才启用。已经运行中的本机后台须先停止，避免配置被另一进程覆盖。

## 在飞书里使用

| 操作 | 方式 |
| --- | --- |
| 查看电脑并选择私聊管理目标 | 私聊发送 `/电脑`，点击在线电脑的选择按钮 |
| 文本选择 Mac | 私聊发送 `/电脑 wangyidemacbookair` |
| 在 Mac 建项目 | 选中 Mac 后，发任意消息打开原管理台，再使用原来的新建项目流程 |
| 绑定已有群到 Mac | 在尚未绑定的群里发送 `/电脑 绑定 wangyidemacbookair`，再在私聊配置卡中选择 Mac 上的目录 |
| 绑定新的文档评论执行电脑 | 私聊先选择电脑，再发送 `/电脑 文档 docx 文件token` |
| 查看本机多电脑配置 | CLI：`node bin/feishu-codex-bridge.mjs fleet status` |

选择电脑只改变之后的私聊管理操作。电脑选择卡显示名称和在线状态，只允许选择在线且协议兼容的电脑；只有重名时才显示完整设备 ID 以区分目标。项目群按固定所属电脑执行；已有卡片、回复引用和运行中的会话不跟随私聊选择改变。卡片显示执行电脑，停止、审批、继续和结束目标仍交给原节点的处理逻辑。

新版 CardKit 2.0 卡片使用独立组件标识更新电脑页脚，保留原正文。旧版 Card 1.0 卡片仅在同一内存对象上跟踪页脚归属；序列化后再次改名并渲染时可能保留旧页脚，优先保护原有内容。

账号和额度管理使用选中电脑的账号池，不同步或搬运其他电脑的凭据。每台电脑分别安装和配置所需的 Codex 及账号切换工具。

## 状态与故障边界

- “已转交”只表示指令写入投递队列，不表示目标已经执行，更不表示模型任务完成。目标原有运行卡和完成通知仍回到原对话。
- 目标离线、版本不兼容、项目未绑定或设备名重复时明确反馈，不在接收事件的其他电脑上执行。
- 指令有效期为 10 分钟。重复投递由目标机的持久收件账本拦截；重启不会自动重放已接收或状态不明的操作。长任务不会因超过两分钟而被重复启动。
- 网络断开可能导致投递或执行回执不明确。这时先查看原话题或目标电脑状态，不把不明确的操作自动重发。
- 默认基础轮询间隔 15 秒，空闲时逐步退避到最多 60 秒；有新指令后回到基础间隔。可在 setup 中用 `--poll-ms 5000` 调整基础间隔，允许 5000–60000 毫秒。较短间隔增加飞书 API 使用量；默认每台活跃时约 5760 轮/日，另加心跳、路由和记录更新请求。
- 电脑必须开机、联网并运行 Bridge。本方案不迁移代码和会话，不自动接管离线电脑的计算。
- API 权限不足、共享表改名、并发写冲突或限流会使控制面暂时不可用；保留原错误且不转到别的电脑执行。已完成的指令会从投递表移除，收件账本保留在本机供去重。
- 尚未登记归属的旧卡片和表情事件不会猜测目标电脑。重新打开对应电脑的管理台或原话题生成新卡片。共享元数据有来源校验；更换 App Secret 需要协调重新初始化，不能直接混用新旧签名。

## 停用与回退

先停止连接同一机器人的其他节点，然后在本机停止后台，执行：

```text
node bin/feishu-codex-bridge.mjs fleet disable
node bin/feishu-codex-bridge.mjs start
```

停用不删除项目、会话或账号数据。不要让原单机版本与多电脑版本同时连接同一机器人，否则事件仍可能落到没有设备路由能力的实例上。

## 验证

```text
npm run test:fleet
npm run typecheck
npm run build
npm test
npm run test:extensions
```

自动测试包括两个独立 Node 进程、跨机转交、持久去重、原卡片归属、目的机权限检查、离线/未知目标、过期与篡改指令、长任务不重发和旧记录迁移。它们使用模拟控制面，不调用真实模型或飞书接口。

真实 Windows + Mac 验收仍需两台都完成配置：确认 `/电脑` 同时列出两台、在 Mac 项目群执行一项可观察任务、回原话题收到结果，并确认旧运行卡不会操作另一台电脑。
