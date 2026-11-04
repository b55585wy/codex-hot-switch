# Windows 本地运行与登录自启动

GitHub 保存源码；Bridge 和它启动的 Codex 在本机运行。使用远端模型时，模型推理由模型服务提供方完成；命令、文件操作、浏览器、构建和测试消耗各自执行环境的资源。把整套运行环境迁移到云服务器后，这些本地工具也会消耗服务器资源，并不能绕过服务器的 CPU、内存、磁盘和 GPU 限制。

本方案保留 Windows 本地运行。电脑关机、休眠或断网时，Bridge 无法保持在线。安装和账号热切换配置见 [HOT-SWITCH.md](../HOT-SWITCH.md)。

## 已安装 Bridge：启用自启动

在 PowerShell 中运行：

```powershell
feishu-codex-bridge.cmd start
feishu-codex-bridge.cmd status
```

如果没有全局命令，在已完成构建的仓库目录中使用：

```powershell
node bin/feishu-codex-bridge.mjs start
node bin/feishu-codex-bridge.mjs status
```

`start` 校验已有机器人配置，安装当前用户的登录自启动，并立即在后台隐藏启动。已运行时重复执行不会创建第二个后台进程。无需额外添加启动文件夹快捷方式。

Windows 自启动登记位置为：

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Run\feishu-codex-bridge
```

登记的启动器位于 `%USERPROFILE%\.feishu-codex-bridge\service-launcher.vbs`，不需要管理员权限。以后开机并登录这个 Windows 用户后，Bridge 会自动启动，无需先打开终端。此方式不在登录前启动，也不负责崩溃后的自动重启。

## 日常命令

| 目标 | PowerShell 命令 |
| --- | --- |
| 启动并启用登录自启动 | `feishu-codex-bridge.cmd start` |
| 手动重启后台 | `feishu-codex-bridge.cmd restart` |
| 查看运行与自启动状态 | `feishu-codex-bridge.cmd status` |
| 停止后台并关闭登录自启动 | `feishu-codex-bridge.cmd stop` |

`stop` 会移除自启动登记；之后需要再次执行 `start` 才能恢复。关闭终端窗口不等于执行 `stop`，已经后台启动的 Bridge 可以继续运行。

`status` 中的 `installed: yes` 表示已登记自启动，`running: yes` 表示后台进程存在。飞书连接是否成功，还需要查看日志中的 `ws client ready` 或“已连接”。默认日志为：

```text
%USERPROFILE%\.feishu-codex-bridge\service.log
%USERPROFILE%\.feishu-codex-bridge\service.err.log
```

如果启动显示“网络错误：fetch failed”，先确认本机能访问飞书开放平台及所需代理已经就绪，再重试一次。网络错误本身不能证明凭据失效，不应因此重新创建机器人。

## 源码同步与换机

GitHub 中的代码和文档可以在本机拉取；Windows 注册表启动项不会随 Git 同步。换机后需要单独准备 Node.js 24 或更新版本、Codex 登录、Bridge 机器人配置和项目文件，再在新机器执行 `start`。已有机器只需使用现有配置。

机器人密钥、Codex 登录凭据、控制台令牌、会话数据和运行日志保留在本机，不应提交到源码仓库。GitHub 仓库不是这些运行数据的备份。

## 已验证的范围

2026-11-04 在 Windows 实机验证：内置 `start` 成功登记自启动并启动后台，`status` 显示 `installed: yes` 和 `running: yes`，飞书长连接就绪；重复执行 `start` 返回成功，PID 保持不变且只有一个后台进程。

本次没有执行 Windows 重启或注销；实际开机登录后的启动结果仍需在下一次登录时确认。
