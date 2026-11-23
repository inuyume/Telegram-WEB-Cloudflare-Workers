# Telegram WEB Proxy — Cloudflare Workers 免费版

> 基于 **Cloudflare Workers Free + SQLite Durable Objects** 的个人自用 Telegram WEB Proxy — 零服务器成本，无需 VPS/容器，WebSocket 多路复用 + MTProxy 透传 + 有界流控。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![English](https://img.shields.io/badge/English-README_EN-blue.svg)](README_EN.md)
[![Workers](https://img.shields.io/badge/Cloudflare-Workers%20Free-orange)](https://developers.cloudflare.com/workers/)
[![Node](https://img.shields.io/badge/node-%3E%3D22.12-green)](https://nodejs.org)

上游基线：[`telegramdesktop/tproxy-server@52a5feb7`](https://github.com/telegramdesktop/tproxy-server/tree/52a5feb7fac38f68da5afef9cedd9b3bfc8473ca) / `Telegram Desktop v7.1.2@3772337d`；固定源码断言由 [`validation/test/upstream.test.js`](validation/test/upstream.test.js) 执行。

> **当前验证边界：** 本地单元测试、真实 `workerd` carrier/session 建立、关闭握手与协议错误清理、固定上游源码断言和双入口 Wrangler dry-run 已通过；公网 `req_pq_multi → resPQ`、真实 Telegram Desktop 文本/媒体、1 GB 连续传输、吞吐和 24 小时 soak 仍待执行。未完成项不得视为已验证。

> **⚠️ 免责声明 / Disclaimer — 含 Cloudflare 违规风险提示**
>
> 本项目仅供**学习、研究与技术交流**使用。作者不对使用本项目产生的任何直接或间接后果承担责任。使用者需自行确保在**符合当地法律法规、Telegram 服务条款及 Cloudflare 使用政策**的前提下使用；严禁用于任何违法、违规或侵犯他人权益的用途。因使用或滥用本项目导致的封号、数据丢失、法律纠纷等风险均由使用者自行承担。请在部署前自行评估合规性与安全性。
>
> **Cloudflare 风险提示（请谨慎使用）：** 本项目依赖 Cloudflare Workers / Durable Objects 免费套餐承载代理流量。Cloudflare 对代理、隧道、超大流量、滥用行为有主动风控与投诉处置机制，将此类用途判定为违反 [Cloudflare Terms](https://www.cloudflare.com/terms/) / [Self-Serve Subscription Agreement](https://www.cloudflare.com/self-serve-subscription-agreement/) 或触发滥用检测时，可能导致 **Worker 被限流/暂停、workers.dev 域名被封、甚至整个 Cloudflare 账号被封禁**。该风险**无法通过代码规避**，且与流量大小、是否公开分享正相关。**强烈建议仅个人低频自用、勿公开分享链接、勿商用、勿用于高带宽/多用户分发**，并自行备份重要数据、接受随时可能不可用的后果。
>
> *This project is for **educational and research purposes only**. The authors assume no liability for any consequences. Users must comply with local laws, Telegram ToS and Cloudflare policies. **Cloudflare-specific risk: using Workers as a proxy may be flagged as abusive per Cloudflare Terms; Workers, routes or accounts may be throttled, suspended or terminated. Use cautiously, keep traffic low, do not share publicly or use commercially.***

---

## 目录

- [特性](#特性)
- [部署教程](#部署教程) — 控制台导入 / Wrangler / 控制台连接 Git
- [配置说明](#配置说明)
- [在 Telegram Desktop 中使用](#在-telegram-desktop-中使用)
- [本地开发与验证](#本地开发与验证)
- [项目结构](#项目结构)
- [安全模型](#安全模型)
- [限制与非目标](#限制与非目标)
- [常见问题](#常见问题)
- [文档索引](#文档索引)
- [免责声明](#免责声明)

---

## 特性

- **Free 目标** — Workers Free 100k 请求/天 + Durable Objects Free 100k 请求/天 + 13k GB-s/天；单 DO 全天 duration 理论值在额度内，最终以真实 analytics 为准
- **无 VPS / 无容器 / 无自建 TCP 后端** — 仅依赖 Cloudflare 免费资源
- **原生 WEB Proxy v1 frame contract** — WebSocket 载体，多路复用 `OPEN / DATA / WINDOW / CLOSE`，固定向量与 `tproxy-server` / Desktop 基线一致
- **不透明业务数据面** — 架构可承载文本、更新、图片、视频和文件字节；真实 Desktop/媒体/1 GB E2E 尚待验证
- **双 Secret 兼容** — 普通 16 字节（`abridged`）与 `dd` + 16 字节（`padded-intermediate`）
- **有界中继** — 单 session 32 流；DO 级共享 32 MiB/32K-item pending 与 outstanding 预算；每流每方向 pending 4 MiB/4K-item、初始双向窗口 4 MiB；DATA 分片 64 KiB；载体硬上限 2 MiB
- **流式加解密** — 每流 4 组独立 AES-256-CTR 上下文，任意碎片不重置 CTR，已通过随机碎片 bit-exact 测试
- **隐私** — 仅终止 MTProxy 外层混淆，MTProto 业务按不透明字节转发，不解析、不记录、不落盘
- **健壮** — 有界位图防整个 session 内流 ID 复用、近期 tombstone 处理关闭竞态、单流失败隔离、载体协议错 `1002`、4 路共享拨号与最多 256 个可取消等待任务、载体关闭/出错后整 session 重建

> PING/PONG 仅保留在协议枚举中；本版本不发送共享帧 PING，收到不支持的零流控制帧会关闭载体。
>
> 语音/视频通话不在范围内 — WEB Proxy v1 本身不承载 UDP。

---

## 部署教程

### 步骤 0 — 生成密钥

```bash
# 生成 16 字节随机密钥（32 位 hex）
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
# 如需 padded-intermediate，在本次生成的随机值前加 dd
```

> 每次部署使用新生成的随机值，不要复用其他代理的密钥。密钥 **永不进仓库**，仅通过 Cloudflare Secret 注入；公开示例值和所有字节重复的密钥会被拒绝。`dd` 前缀用于 `padded-intermediate`，普通 16 字节即 `abridged`。

### 步骤 1 — 设置代理路径

在仓库根目录的 [`wrangler.toml`](wrangler.toml) 的现有 `[vars]` 下配置：

```toml
[vars]
PROXY_ALLOW_ROOT_V1 = false
PROXY_BASE_PATH = "my-relay"
```

Telegram 的 WEB Proxy 地址填 `你的域名/my-relay`，密钥仍填 `PROXY_SECRET`。路径区分大小写，不是密码。默认关闭只填域名的根路径桥接 v1；**如果不配置路径，也不显式启用 v1，将不开放代理，只保留 `/healthz`**。需要兼容只支持域名的旧客户端时，才把开关设为 `true`。

---

### 方式一：控制台导入（推荐新手）

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create)

1. Fork 本仓库，打开上方按钮，在 Cloudflare 中连接 Git 并选择自己的 Fork。
2. 项目路径使用仓库根目录 `/`，构建命令设为 `npm --prefix app ci`，部署命令设为 `npm --prefix app run deploy`。这些命令使用锁定的工具版本和根配置。
3. 首次部署后进入该 Worker 的 **Settings → Variables & Secrets**，添加 **Secret**：`PROXY_SECRET` = 上一步生成的 hex，并保存发布。
4. 访问 `https://<your-worker>.<subdomain>.workers.dev/healthz`，确认 `200`，再执行下方数据面探针，验证密钥、中继绑定和上游连接。

> **运行时 Secret 必须设置在 Worker 的 Variables & Secrets 中。** Build variables and secrets 只供构建使用；仅在那里添加 `PROXY_SECRET`，运行时无法读取。未正确配置时，即使 `/healthz` 返回 `200`，也不会签发代理会话。[Cloudflare 官方说明](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)

> 导入部署会创建 `RELAY` Durable Object（`personal-telegram-relay-v1`），无需额外数据库。

---

### 方式二：Wrangler 命令行（推荐开发者，完全可控）

#### 1. 安装与登录

```bash
cd app
npm ci

# 登录 Cloudflare（会打开浏览器授权）
npx wrangler login
# 验证
npx wrangler whoami
```

直接跳转登录：[Cloudflare 登录](https://dash.cloudflare.com/login) / [Workers 控制台](https://dash.cloudflare.com/?to=/:account/workers-and-pages)

#### 2. 注入密钥

```bash
npx wrangler secret put PROXY_SECRET --config ../wrangler.toml
# 粘贴 32 位 hex 或 dd+32 位，回车

# 可选：在 wrangler.toml [vars] 或控制台普通 Variable 中设置 RELAY_DEBUG = "1"
```

#### 3. 预检与发布

```bash
npm run deploy:dry   # 预检 bundle、根配置与 RELAY 绑定
npm run deploy       # 发布到 https://telegram-web-cloudflare-workers.<你的子域>.workers.dev
# 查看地址
npx wrangler deployments list --config ../wrangler.toml
```

#### 4. 绑定自定义域名（可选）

- 控制台：[Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages) → 你的 Worker → **Settings → Triggers → Add Custom Domain**
- 或在 `wrangler.toml` 加 `routes` 后重新 `deploy`，详见 [自定义域名文档](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- 自定义域名生效后，在根配置设置 `workers_dev = false` 并重新部署，避免 `workers.dev` 入口绕过仅施加于自定义域名的 WAF 规则。预览 URL 已默认关闭。

> 域名费用不计入本项目 `$0` 基础设施约束。

---

### 方式三：Cloudflare 控制台连接 Git（不装 Wrangler）

1. 先 Fork 仓库，再打开 [Workers & Pages → Create](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create) → **Import from Git**，选择自己的 Fork。
2. 项目路径使用仓库根目录 `/`，构建命令为 `npm --prefix app ci`，部署命令为 `npm --prefix app run deploy`；根 `wrangler.toml` 声明 `RELAY` binding 与 SQLite DO migration。
3. 部署后在该 Worker 的 **Settings → Variables & Secrets** 添加运行时 Secret `PROXY_SECRET`，保存发布。
4. 检查 `/healthz`，再执行下方完整探针。

> 不支持只在在线编辑器粘贴 `app/src/*.js`：那样不会自动创建 Durable Object binding 和 migration。

---

### 验证部署是否成功

#### 基础健康检查

```bash
curl https://<你的host>/healthz  # 仅检查 Worker 入口存活
# /readyz 不对公网开放；运行时 Secret、中继和上游请用下方探针验证
```

#### 数据面往返探针（无需 Telegram 账号）

```bash
# 在 app 目录下
TASK_PROXY_SECRET=<你的PROXY_SECRET> TASK_PROXY_HOST=<你的host>/my-relay npm run probe
# 等价：TASK_PROXY_SECRET=<你的PROXY_SECRET> npm run probe -- https://<你的host>/my-relay
# 预期: {"result":"public-respq-pass","relay":{"ok":true,"constructor":85285459, ...}}
# 85285459 = 0x05162463 (resPQ)
```

PowerShell：

```powershell
$env:TASK_PROXY_SECRET = '<你的PROXY_SECRET>'
$env:TASK_PROXY_HOST = '<你的host>/my-relay'
npm run probe
```

该探针根据 Secret 选择 abridged 或 padded-intermediate，在你自己的载体上完成 `OPEN → MTProxy init → req_pq_multi → resPQ`，验证响应结构和 nonce。它证明本次 DC2 media（`-2`）连接的数据面往返，不替代所有 DC、真实客户端、媒体和重连验收。报告含 transport/DC 和阶段时延，不含凭证。

**失败排查：**

| 现象 | 原因 |
|---|---|
| `TASK_PROXY_HOST ... required` | 未提供自己的代理地址；设置 `TASK_PROXY_HOST` 或通过 CLI 传入 `域名/路径` |
| `bridge-failed` | 核对密钥、域名和路径（含大小写），以及目标桥接入口是否启用 |
| `session-failed` | 检查 bootstrap 是否过期（120 秒），重新跑探针 |
| `public-respq-fail` / 超时 | 出站 Telegram WSS 被网络拦截，等待 20s 后重试；检查 `wrangler tail` 日志 |

实时日志：

```bash
npx wrangler tail --config ../wrangler.toml   # 需 RELAY_DEBUG=1 才有详细 relay 日志
# 或控制台: Workers → 你的 Worker → Logs → Tail
```

---

## 在 Telegram Desktop 中使用

> **Telegram Desktop v7.1.2** 是传输协议源码的核对基线。默认的桥接 v2 需要支持 `域名/路径` 的 WEB Proxy 客户端；官方 Android 12.10.4 源码已包含这项功能，但本项目未做 Android 真机验证。只支持域名的客户端需要显式开启根路径 v1。
>
> 以下是当前实验性接入步骤；真实 Desktop 文本、媒体和文件 E2E 尚未形成通过证据。

1. 先完成健康检查与数据面探针。无需在普通浏览器打开桥接链接。
2. Telegram Desktop：**设置 → 数据和存储 → 代理 → 添加代理 → WEB Proxy**
3. 填入：
   - **地址**：`<你的host>/my-relay`（替换为你配置的路径，不含 `https://` 或末尾 `/`）；仅当启用根路径 v1 时才可只填域名。
   - **密钥**：与 `PROXY_SECRET` 完全相同的 hex（`dd` 前缀如有也填入）
4. 点击添加并启用；当前验收目标是状态变为 **已连接**，再依次验证 Saved Messages 文本、图片和文件，结果必须单独记录，不能由单元测试代替

> 桥接页、会话 API 和 WebSocket 都走同一个路径前缀，例如 `wss://<host>/my-relay/api/v1/ws`。桥接 v2 不更改 `tproxy-v1.<session-token>` 或现有帧协议。

---

## 配置说明

| 变量 | 位置 | 说明 |
|---|---|---|
| `PROXY_SECRET` | `wrangler secret` / 控制台 Secret | 必填；16 字节随机值的 32 位 hex，可加 `dd` 前缀 |
| `PROXY_BASE_PATH` | Wrangler vars / 控制台普通变量 | 桥接 v2 的入口路径，如 `my-relay` 或 `team/Relay`；无首尾 `/`，区分大小写，最多 128 字符。每段以英文字母或数字开头，后续可含 `-` 或 `_`。 |
| `PROXY_ALLOW_ROOT_V1` | Wrangler vars / 控制台普通变量 | 默认 `false`；设为 `true` 才允许根路径桥接。只接受 `true` / `false`（布尔值或同名字符串）。 |
| `RELAY_ALLOWED_IPS` | 控制台普通变量 / Wrangler vars | 可选；逗号分隔的公网 IPv4/IPv6 地址。不设置时不限制来源；不要填空字符串或 CIDR。固定公网出口时推荐启用，换网后需更新。用 Wrangler 重新部署时，请在配置中保留该变量，或配置 `keep_vars = true` 保留控制台变量。 |
| `RELAY_DEBUG` | `wrangler vars` / 控制台 Variable | `1` 开启详细中继日志（`wrangler tail` 可见） |

根目录 [`wrangler.toml`](wrangler.toml) 是部署、本地开发、运行时测试与 CI 的唯一 Wrangler 配置来源；`app/package.json` 与 `app/vitest.config.js` 均显式引用它。完整 binding、migration、兼容日期和日志策略直接以该文件为准。

---

## 本地开发与验证

```bash
# 可复现安装
npm --prefix app ci

# 单元 / Workers runtime / 固定上游验证
npm --prefix app test
npm --prefix app run test:runtime
npm --prefix validation test
npm --prefix app run lint

# 本地 Cloudflare 运行时
npm --prefix app run dev
# → http://127.0.0.1:8792；healthz 可直接访问
# capability 依赖公共 hostname；完整 bridge/session/WSS 本地合同由 test:runtime 覆盖

# 已部署 Worker 的公网探针
TASK_PROXY_SECRET=<hex> TASK_PROXY_HOST=<你的host>/my-relay npm --prefix app run probe
```

### 项目结构

```
app/
  src/
    capability.js     # capability 计算、主机规范化与常量时间校验
    index.js          # Worker 路由 + RelayDO
    bridge.js         # 桥接页、90 秒会话总期限与客户端取消
    protocol.js       # WEB Proxy 帧编解码
    mtproxy.js        # MTProxy 解析 / 直连 init / AES-CTR
    relay.js          # 有界多路中继 + Telegram WSS
    mtproto-probe.js  # req_pq_multi → resPQ 辅助
  test/               # 协议、产品、中继、加解密与配置单元测试
  runtime-test/       # 真实 workerd capability/session/WebSocket 测试
  scripts/            # syntax checker 与公网 resPQ probe
  package-lock.json   # CI 可复现依赖
shared/
  telegram-dc.js      # Telegram DC → 官方 WSS 主机的唯一映射
validation/
  src/ / test/ / scripts/   # 固定上游、配置、parity 与公网 WSS 验证
  cloudflare-probe/         # 最小 Free 运行时探针
wrangler.toml               # 唯一 Wrangler 配置；所有部署与测试入口显式引用
```

---

## 安全模型

- 桥接链接：根路径 v1 绑定主机名，带路径 v2 额外绑定路径；两种 `?bridge=…` 都由密钥确定性生成，**本身不过期**。不要把它放进浏览器、截图或日志；若泄漏，轮换密钥。有固定公网出口时可启用 `RELAY_ALLOWED_IPS`。
- 短期令牌：43 字符格式不变，约 120 秒有效，签名绑定主机、入口路径和用途；Worker 在访问 DO 前拒绝无效令牌，DO 再确认签发和撤销状态。接入 WebSocket 后，bootstrap 立即撤销；令牌过期不影响已建立的连接。
- 主机规范化：`domainToASCII`、小写、标签校验，拒绝 IP/纯数字 TLD/裸主机
- 帧校验：文本载体、未知类型、非法流 ID、超大载荷 → 立即 `1002` 关闭载体
- 无载荷持久化：`bootstrap / session / MTProto 字节` 绝不写入 Durable Storage
- 日志：默认关闭 invocation logs 和 traces。不要在 Logpush/Tail 或排障材料中留存完整 URL、`Authorization`、`X-Bootstrap-Token`、`X-Session-Token` 或含令牌的 `Sec-WebSocket-Protocol`。
- 资源边界：每个 Cloudflare 边缘位置约 30 次/分钟/来源 IP、合计 120 次/分钟进入 DO（不是全球硬配额，也不保护 Worker 入口请求额度）；最多 8 个会话。接入后 20 秒内须完成首个 MTProxy 初始化；4 次无效初始化或 15 分钟无转发流量会关闭载体。每会话每方向还有 8 MiB/s 的字节限制及每秒 8192 帧的限制，超限关闭载体。若用自定义域名，可另在 WAF 层限制请求进入 Worker。
- 出站只使用固定 Telegram 主机，拒绝重定向。独立验证 Worker 不随主项目部署；如有需要，使用独立的随机 `PROBE_TOKEN`（`randomBytes(32).toString('base64url')`），只在验证期间启用。
- 桥接页 CSP：`default-src 'none'`、`script-src 'nonce-…'`、`frame-ancestors http://127.0.0.1:*`（Desktop WebView）、`sandbox allow-same-origin allow-scripts`

---

## 限制与非目标

- 不支持语音/视频通话（UDP）— WEB Proxy v1 范围外
- 个人单用户使用，不做多租户/管理后台/付费扩容
- 不支持 `ee` TLS 伪装密钥与任意上游目标选择
- 活跃 cipher 状态只在内存；明确使用 standard WebSocket，不支持通过 hibernation 恢复 cipher；DO 驱逐或载体丢失需要重建整个 session；单个上游 `1006` 关闭对应逻辑流
- Cloudflare outbound WebSocket `send()` 不提供 drain/ack；能读取 `bufferedAmount` 时检查发送积压，其他情况下靠速率与应用队列限额降低风险。运行时缓冲和大文件可靠性仍需真实 soak 验证
- `websocket-lanes` 与 raw-TCP 回退为 deferred，仅在单载体 HOL/吞吐或 WSS 兼容门失败时启用

---

## 常见问题

**Q: 免费额度够用吗？**  
A: 单 128 MB DO 全天理论值约 11.06k GB-s，占 13k 日额度约 85%；剩余空间较小，且 incoming WebSocket message 计费取决于真实 batching。必须以部署后的 analytics/24h soak 判定，不能仅凭理论值承诺“够用”。

**Q: 用 `workers.dev` 还是自定义域名？**  
A: 均可。`workers.dev` 零成本即开；自定义域名需 Cloudflare 托管域，但更稳定、能力 host 更可控。

**Q: 部署后 Telegram 连不上？**  
A: 依次检查 `PROXY_SECRET`（含 `dd`）、代理主机名、当前出口是否在启用的 IP 白名单内，以及 bootstrap 是否在 120 秒内使用。先跑数据面探针，不要保存或共享包含完整请求 URL 或凭证的输出。

---

## 文档索引

- [`app/test/`](app/test/) — Node 单元与回归规格
- [`app/runtime-test/`](app/runtime-test/) — 真实 Workers runtime carrier/session 规格
- [`validation/test/`](validation/test/) — 固定上游、Cloudflare probe 与配置 parity 规格
- [`app/src/capability.js`](app/src/capability.js) — capability 与公开主机名规则的生产唯一来源
- [`shared/telegram-dc.js`](shared/telegram-dc.js) — Telegram DC → WSS 主机映射的唯一来源
- [`wrangler.toml`](wrangler.toml) — 部署、本地开发、运行时测试与 CI 的唯一 Wrangler 配置

---

## 致谢

- Telegram Desktop 与 [`tproxy-server`](https://github.com/telegramdesktop/tproxy-server) 的 WEB Proxy v1 协议
- Telegram 核心文档：[MTProto transports](https://core.telegram.org/mtproto/transports)
- Cloudflare Workers & Durable Objects 文档

---

## 免责声明

本项目**仅供学习、研究、技术交流与个人自用研究**，不得用于任何违反法律法规、Telegram 服务条款或 Cloudflare 可接受使用政策的用途。

- 作者及贡献者不对因部署、使用、配置错误或滥用本项目导致的任何直接/间接损失（包括但不限于账号封禁、数据丢失、网络中断、法律责任）承担责任。
- 使用者应自行评估并确保在所在地法律允许的范围内使用，自行承担合规与风控义务。
- 如当地法律禁止此类代理服务，请勿部署或使用。
- 本项目不提供任何 SLA、可用性或安全性保证，按 `MIT` 许可证“按现状”（AS IS）提供。

### Cloudflare 违规风险（务必谨慎使用）

本项目依赖 Cloudflare Workers / Durable Objects 承载代理流量，**存在明确的平台违规与封禁风险**：

- Cloudflare 对 **代理/隧道类用途、超大流量、免费套餐滥用** 有风控策略，相关行为可能被判定为违反 [Cloudflare Terms](https://www.cloudflare.com/terms/) / [Self-Serve Subscription Agreement](https://www.cloudflare.com/self-serve-subscription-agreement/)，进而导致 **Worker 被限流或暂停、workers.dev 子域被封、自定义域名路由失效、甚至账号级封禁**。
- 风险与**是否公开分享链接、是否多人共用、是否产生持续高带宽**强相关；公开传播会显著增加被检测/被投诉概率。
- Free 套餐无 SLA，上述处置可**无预先通知**发生，且**无法通过代码层面规避**。

**使用建议（降低风险）：**

- 仅**个人低频自用**，单账户单 Worker，不做公开服务或商业分发。
- 控制流量与并发，避免 7×24 满速跑流；必要时自备备用方案。
- 勿在公开频道/群组分享 `workers.dev` 链接，优先使用自有域名并了解可能牵连主域风险。
- 接受“随时可能不可用”的后果，重要数据自行备份。

如不能接受上述 Cloudflare 风险，**请勿部署**。如不同意本声明，请勿使用本项目。

---

## 许可证

MIT — 见 [LICENSE](LICENSE)
