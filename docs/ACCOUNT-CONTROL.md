# 飞书原生账号入口

此入口由 Bridge 在消息进入模型前处理。额度耗尽时仍能列账号、调用本机 CC Switch 适配器并管理后台；不使用 `codex exec`，不发送推理或续跑任务。

## 私聊命令

仅 Bridge 管理员可使用，群内请求引导到私聊。

| 命令 | 行为 |
| --- | --- |
| `/account` | 列出 CC Switch 已存 Codex OAuth 账号，显示稳定代号和脱敏邮箱 |
| `/account status` | 只读查询共享 Codex daemon 当前账号 |
| `/account setup` | 创建本机控制密钥并验证 CC Switch 适配器；不切账号 |
| `/account switch ccs-xxxxxxxxxxxx --restart` | 经 CC Switch 正常切卡流程换号，再刷新并核验 Codex 后台 |
| `/account recover ccs-xxxxxxxxxxxx --restart` | 核验已经切好的账号并刷新后台，不再次切卡 |

列表中的“CC Switch 默认”是管理器默认标记，不代表运行中的 Codex 已使用该账号。账号代号来自本地账号 ID 的摘要，不按列表顺序编号。不要用邮箱或上游 workspace ID 替代代号。

## 需要 CC Switch 适配版

**原版 CC Switch 4.0.21 没有外部切号 CLI，也没有本入口使用的控制接口。** `/account` 与 `/account status` 可以独立使用；真正切号需要先构建并部署 [CC Switch 4.0.21 适配补丁](../integrations/cc-switch/v4.0.21/README.md)。未安装时命令会说明适配器未响应，不会报告换号成功。

适配器必须通过 CC Switch 自身的账号管理器和提供商切换流程刷新凭据、写入原生配置。Bridge 不导出或复制令牌，不修改 CC Switch 数据库指针，也不使用 `logout` 强制刷新认证。

通信使用本机 `ccswitch://v1/bridge` 请求与本机回执文件。签名、时间窗口、请求随机 ID 和目标账号必须匹配。控制密钥只在用户显式运行 `/account setup` 时生成，保留在本机 `.cc-switch/bridge-control/`，不纳入源码。账号列表和飞书回执不包含凭据。

## 切号与恢复

1. Bridge 检查管理员身份、账号代号和 `--restart` 标记；有执行中或排队任务时拒绝开始。
2. 原生入口锁住新 Codex 任务，调用 CC Switch 适配器。适配器只选择唯一绑定所选账号的现有官方提供商卡；缺失或歧义时停止。
3. 新独立 app-server 只读查询本机凭据对应的账号。匹配所选账号后，清理当前 Bridge 的 Codex 会话连接与预热、工具客户端，再重启共享 daemon。
4. 从共享 daemon 再次只读查询账号，匹配后才返回“已核验”。原项目、话题映射与 session ID 保留。
5. 用户回原话题发“继续”。Bridge 不发送续跑指令；原生 goal 是否恢复取决于 Codex 自身状态。

身份核验不试跑模型，也不消耗推理额度；它不代表新账号的所有模型都仍有剩余额度。

当前按邮箱摘要核验个人账号身份，不用于验证同邮箱下不同组织或 workspace 的切换。运行时管理按 Codex 0.166.0 验证。

共享 daemon 重启可能中断其他原生窗口的请求。独立运行的外部终端进程不受 Bridge 控制，可能仍需自己重新连接或按原 ID resume；无需关闭整个终端窗口。多个 Bridge 进程分别持有的独立缓存不由当前进程统一管理。

切卡已成功而后台核验失败时，消息会明确显示中间状态，并给出 `/account recover`。适配器超时只表示结果未确认，不等同于证明登录文件没发生变化。操作未核验成功前不要继续工作任务。

## 本次交付边界

2026-11-02 编写并用模拟外部调用、临时账号库和协议夹具验证。未执行真实换号、`logout` 或 daemon 重启，未替换本机 CC Switch。部署适配版与重启 Bridge 加载新代码后，才具备完整实际切号能力。
