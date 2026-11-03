# CC Switch 4.0.21 本机控制适配补丁

基于 [farion1231/cc-switch v4.0.21](https://github.com/farion1231/cc-switch/tree/v4.0.21)，对应 commit `c4db63c60d2a1ddcb4bd9f81152b9c6126413659`。保留上游来源与 MIT 许可证；此目录是可选的私有适配代码，并非上游现有功能。

`apply.cjs` 只编辑单独的源码 checkout，不安装程序、不读取账号或生成密钥。默认只预览；重复应用保持相同结果。运行中的原版 CC Switch 不会因此改变。

## 构建

先按上游要求准备 Rust、Node、pnpm 和平台构建依赖。示例中的目录需要替换为实际路径：

```powershell
git clone --branch v4.0.21 https://github.com/farion1231/cc-switch.git E:/src/cc-switch-bridge
node integrations/cc-switch/v4.0.21/apply.cjs E:/src/cc-switch-bridge
node integrations/cc-switch/v4.0.21/apply.cjs E:/src/cc-switch-bridge --apply
cd E:/src/cc-switch-bridge
pnpm install --frozen-lockfile
pnpm exec tauri build --features cc-bridge-control
```

补丁增加 `cc-bridge-control` Cargo feature，默认关闭。构建后需由用户选择部署适配版，并让 `ccswitch://` 协议指向该版本，再在机器人私聊执行 `/account setup`。本次仅交付源码，不替换当前安装或执行换号。

## 接口约定

- URL：`ccswitch://v1/bridge?payload=<base64url>&signature=<64位小写十六进制>`。
- 密钥：用户 home 下 `.cc-switch/bridge-control/key`，32 个原始随机字节。
- 签名：HMAC-SHA256，签名对象为 payload 的 base64url 字符串。
- 请求：`version:1`、`operation:status|activate`、32 位十六进制 `nonce`、Unix 毫秒 `issuedAt`、可选 `accountCode`。激活必须提供账号代号。
- 状态查询无账号代号时只报告接口就绪，不声称 daemon 已采用某账号。
- 成功账号回执包含 `accountCode`、`maskedEmail` 和规范化邮箱的 SHA-256 `emailHash`；后者仅供 Bridge 本机核验，不发送到飞书。
- 回执：本机 `bridge-control/responses/<nonce>.json`，同样采用 `{payload,signature}` 信封。

适配器在普通深链接日志和 import 解析前截获专用路径；不改变原有 import 行为。只有签名通过的请求才预留 nonce，时间偏差超过 60 秒会被拒绝。重复 nonce 不执行操作，也不覆盖第一次回执。

账号代号为 `ccs-` 加 SHA-256(`cc-switch/codex-account/v1\0` + 本地账号 ID) 前 12 位。激活只调用已有管理器和 `switch_provider` 正常链，不直接写数据库、不返回刷新令牌或其他认证材料。

## 验证

```powershell
cargo test --manifest-path integrations/cc-switch/v4.0.21/protocol-tests/Cargo.toml --locked
```

独立协议测试覆盖 Node/Rust 黄金向量、签名篡改、重复请求、时间窗口、账号与提供商歧义、只发布一次的回执和错误脱敏。它不代表真实账号切换或完整桌面程序端到端验证。
