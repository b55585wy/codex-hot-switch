# 上游来源

- 上游项目：[modelzen/feishu-codex-bridge](https://github.com/modelzen/feishu-codex-bridge)
- 基准版本：`v0.6.14`
- 基准提交：`6698118352d7eca87887d3ee1b58736caca204bc`
- 上游许可证：MIT，见本仓库保留的 [LICENSE](LICENSE)
- 上游原始说明：[固定版本 README](https://github.com/modelzen/feishu-codex-bridge/blob/6698118352d7eca87887d3ee1b58736caca204bc/README.md)

本仓库为 `b55585wy` 使用的独立定制版本，保留上游源码和作者声明，另以 `extensions/` 实现当前定制功能。它不是上游官方发布版本。

扩展包括共享 daemon 原会话接入、模块列表、精确 `/resume`、持久完成追踪、绑定话题通知，以及超时与最终完成通知分开去重。实现和运行边界见 [私有版说明](docs/PRIVATE-EDITION.md)。

源码私有可见性由 GitHub 仓库设置控制；本机凭据、令牌、聊天记录和会话数据不属于源码分发内容。
