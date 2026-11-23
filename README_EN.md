# Telegram WEB Proxy — Cloudflare Workers

> Zero-cost, single-user Telegram WEB Proxy on **Cloudflare Workers Free + SQLite Durable Objects** — WebSocket carrier, MTProxy obfuscation translation, bounded multiplexed relay.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Workers](https://img.shields.io/badge/Cloudflare-Workers%20Free-orange)](https://developers.cloudflare.com/workers/)
[![Node](https://img.shields.io/badge/node-%3E%3D22.12-green)](https://nodejs.org)

Pinned upstream: [`telegramdesktop/tproxy-server@52a5feb7`](https://github.com/telegramdesktop/tproxy-server/tree/52a5feb7fac38f68da5afef9cedd9b3bfc8473ca) / `Telegram Desktop v7.1.2@3772337d`.

> **Current verification boundary:** local unit tests, real `workerd` carrier/session, close-handshake and protocol-error cleanup tests, pinned-source assertions, and both Wrangler dry-run entry points pass. Public `req_pq_multi → resPQ`, real Telegram Desktop text/media, 1 GB transfer, throughput, and the 24-hour soak are still pending and must not be treated as verified.

> **⚠️ Disclaimer — Cloudflare Violation Risk**
>
> This project is for **educational and research purposes only**. The authors assume no liability for any consequences. Users must ensure compliance with local laws, Telegram ToS and Cloudflare policies. **Cloudflare-specific risk: Workers used as a proxy may be flagged as abusive under Cloudflare Terms / Self-Serve Subscription Agreement, leading to throttling, suspension of Workers/routes, or account termination. This risk scales with traffic and public sharing. Use cautiously: personal low-volume self-use only, do not share publicly or use commercially, and accept that service may become unavailable at any time.** The full Chinese disclaimer in [`README.md`](README.md) shall prevail.

[中文 README](README.md) · [Architecture](#architecture) · [Deploy](#deploy) · [Cost](#cost)

---

## Why

Host a personal Telegram WEB Proxy without a VPS, containers, or paid backends.

- **$0 target** — Workers Free (100k req/day) + SQLite Durable Objects Free (100k req/day, 13k GB-s/day); final feasibility depends on real usage analytics
- **Native WEB Proxy v1** — WebSocket carrier multiplexing `OPEN / DATA / WINDOW / CLOSE`
- **Opaque data plane** — the architecture can carry text, updates, photos, video, and file bytes; real Desktop/media/1 GB E2E remains unverified
- **Privacy-preserving** — proxy only terminates the outer MTProxy layer; MTProto payloads are treated as opaque bytes, never logged or persisted

> Voice/video calls are out of scope — WEB Proxy v1 does not relay UDP.

---

## Architecture

```
Telegram Desktop (pinned WEB Proxy v1 client)
        │  HTTPS / WSS  wss://proxy.example.com/api/v1/ws  tproxy-v1.<token>
        ▼
  Cloudflare Worker  ── capability check (HMAC) + bridge page
        │
        ▼
  Relay Durable Object (SQLite)  ── single DO: personal-telegram-relay-v1
        │  WEB Proxy session │ multiplexed logical streams
        │  MTProxy outer decrypt → direct Telegram obfuscation re-encrypt (streaming AES-256-CTR)
        │
        └──► Telegram DC1–DC5 official WSS /apiws
             host map: shared/telegram-dc.js   Sec-WebSocket-Protocol: binary
```

**Worker** = routing + bridge capability + bootstrap/session + WSS upgrade.  
**RelayDO** = long-lived state (stream windows, CTR ciphers, tombstones) + outbound Telegram WSS.

Single DO billing: `0.128 GB × 86 400 s = 11 059 GB-s/day` → **85% of the Free 13 000 GB-s/day** budget.

---

## Features

- **Bridge compatibility** — path-bound bridge v2, with opt-in root bridge v1; both accept plain 16-byte and `dd` + 16-byte secrets
- **Secure handshake** — short-lived bootstrap/session tokens bound to the host, base path and purpose; constant-time checks, `no-store` responses, and a nonce-based CSP
- **Bounded relay** — 32 streams/session; DO-wide 32 MiB/32K-item pending and outstanding budgets; 4 MiB/4K-item pending per direction and a 4 MiB initial window per stream; 64 KiB DATA chunks; 2 MiB carrier hard max
- **Streaming crypto** — 4 independent AES-256-CTR contexts per stream; never resets CTR on `DATA` boundaries; arbitrary fragmentation safe
- **Resilience** — a bounded session-wide used-ID bitmap (up to 2 MiB), recent tombstones, per-stream failure isolation, carrier `1002` on protocol violation, four concurrent dials and at most 256 cancellable queued dials
- **Lifecycle-aware** — bounded bootstrap/session registries and whole-session rebuild after carrier close or error

---

## Quick Start

### 1. Prerequisites

- Node.js ≥ 22.12, Wrangler 4, and a Cloudflare Free account

### 2. Install

```bash
git clone <your-repo> telegram-web-proxy
cd telegram-web-proxy/app
npm ci
npm test          # protocol / MTProxy / relay / carrier / config tests
npm run test:runtime # real workerd session, close and protocol-error tests
```

### 3. Configure secret

Generate a 16-byte secret (32 hex chars) or `dd` + 16-byte for padded-intermediate:

```bash
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"

npx wrangler secret put PROXY_SECRET --config ../wrangler.toml
# paste the hex string (dd + 32 hex is also accepted)
```

> Use a fresh random secret for each deployment and keep it out of source. The old published example and repeated-byte values are rejected. The public relay probe computes the bridge capability without printing it.

### 4. Configure the base path and deploy (Free)

In the root [`wrangler.toml`](wrangler.toml), set these values under the existing `[vars]` section:

```toml
[vars]
PROXY_ALLOW_ROOT_V1 = false
PROXY_BASE_PATH = "my-relay"
```

Use `your-host/my-relay` as the Telegram WEB Proxy address. Root bridge v1 is disabled by default. Leaving the path unset with v1 disabled exposes only `/healthz`. Set the flag to `true` only if you need to support hostname-only clients.

```bash
npm run deploy:dry   # validate the bundle, root config, and RELAY binding
npm run deploy       # → https://telegram-web-cloudflare-workers.<your-subdomain>.workers.dev
```

For Workers Builds, use the repository root, build command `npm --prefix app ci`, and deploy command `npm --prefix app run deploy`. After the initial deployment, set `PROXY_SECRET` under the Worker’s **Settings → Variables & Secrets** and save/deploy. Build variables and secrets are build-only and do not configure the runtime. [Cloudflare configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)

Custom domain: add a Cloudflare zone route — domain cost is outside the `$0` infra constraint. Once the custom domain works, set `workers_dev = false` and redeploy so that the `workers.dev` URL cannot bypass zone WAF rules. Version preview URLs are disabled by default.

### 5. Verify

```bash
curl https://<your-host>/healthz  # liveness only
# /readyz is not public; the probe below checks the runtime secret and relay path.
TASK_PROXY_SECRET=<same-hex> TASK_PROXY_HOST=<your-host>/my-relay npm run probe
# equivalent: TASK_PROXY_SECRET=<same-hex> npm run probe -- https://<your-host>/my-relay
# expect: {"result":"public-respq-pass", ...}
```

The probe uses abridged for a plain secret and padded-intermediate for a `dd` secret. It validates the resPQ structure and nonce for this DC2 media (`-2`) connection. A pass does not replace real Desktop, other DCs, media, reconnect or soak verification.

---

## Use with Telegram Desktop

> The steps below are experimental. A real Desktop text/media/file E2E pass has not yet been recorded.

1. Complete the health check and the public data-plane probe.
2. In Telegram Desktop: **Settings → Data and Storage → Proxy → Add Proxy → WEB Proxy** → enter `your-host/my-relay` (no `https://` or trailing slash) and the same secret. Use just the hostname only if root v1 is explicitly enabled.
3. The client must load the bridge and initialize its trusted MessagePort or injected WebView boundary. Only then does the bridge create the session and WebSocket.

Do not open or share the complete bridge URL; use the credential-safe probe instead. Real Desktop verification remains required.

> **Telegram Desktop v7.1.2** is the transport protocol source baseline, not a base-path compatibility claim. Bridge v2 requires a client that accepts a `host/path` address. Official Android 12.10.4 source supports this, but this project has not been tested on a real Android device.

---

## Configuration

| Variable | Where | Purpose |
|---|---|---|
| `PROXY_SECRET` | `wrangler secret` | Fresh 16-byte random secret encoded as 32 hex characters, optionally prefixed with `dd` |
| `PROXY_BASE_PATH` | Wrangler vars / Worker variable | Case-sensitive bridge v2 path, e.g. `my-relay` or `team/Relay`. No leading or trailing slash, max 128 characters. Each segment starts with an ASCII letter or digit and can also contain `-` or `_`. |
| `PROXY_ALLOW_ROOT_V1` | Wrangler vars / Worker variable | Defaults to `false`. Only `true` enables root bridge v1. Accepts booleans or the exact strings `true` and `false`. |
| `RELAY_ALLOWED_IPS` | Worker variable | Optional comma-separated public IPv4/IPv6 addresses (not CIDRs). Leave unset to allow all sources; recommended for a fixed public egress IP. Keep it in your Wrangler config or set `keep_vars = true` to retain the dashboard value on redeploy. |
| `RELAY_DEBUG` | `wrangler vars / env` | `"1"` enables verbose relay logs (`wrangler tail`) |

The root [`wrangler.toml`](wrangler.toml) is the only Wrangler configuration; deployment, development, runtime tests, and CI explicitly consume it.

The Worker deliberately uses the standard WebSocket API: active AES-CTR state is memory-only and is never resumed through Durable Object hibernation.

---

## Development

```bash
npm --prefix app test
npm --prefix app run test:runtime
npm --prefix validation test
npm --prefix app run lint
npm --prefix app run dev  # → http://127.0.0.1:8792
```

The bridge implementation is in `app/src/bridge.js`; session creation has a 90-second total deadline and aborts when the client closes. Server session body reads have a 10-second deadline and recheck bootstrap validity before committing.

Tracked executable evidence lives in `app/test/`, `app/runtime-test/`, and `validation/test/`.

---

## Cost

| Resource | Free quota | This project |
|---|---|---|
| Workers requests | 100k / day | HTTP requests and WebSocket upgrades; WebSocket messages are not Worker requests |
| Durable Objects requests | 100k / day | incoming WebSocket messages use the 20:1 billing ratio; actual batching determines usage |
| Durable Objects duration | 13k GB-s / day | One 128 MB DO all day = 11.06k (85%) |

---

## Security Model

- Root bridge v1 binds to the hostname; bridge v2 also binds to the configured path. Both capabilities are deterministic and **do not expire**. Keep full bridge URLs private; rotate `PROXY_SECRET` if a URL leaks. Both modes use the existing `/api/v1` transport and `tproxy-v1` WebSocket subprotocol, under the prefix for v2.
- The Worker checks signed 43-character bootstrap/session bearers before contacting the DO. They bind to the hostname, path and purpose and expire after about 120 seconds; the DO also checks issuance and revocation. The bootstrap is revoked on carrier attach; token expiry does not interrupt an established carrier.
- Host canonicalization: `domainToASCII`, reject IPs
- Frame validation: immediate `1002` on violation
- No payload persistence
- Invocation logs and traces are disabled. Exclude full URLs and credential-bearing `Authorization`, `X-Bootstrap-Token`, `X-Session-Token` and `Sec-WebSocket-Protocol` headers from Logpush, Tail captures and diagnostics.
- Per Cloudflare location: approximately 30 DO-bound requests per source IP per minute, and 120 combined. These are not global hard quotas and do not protect the Worker request quota. With a custom domain, zone WAF rules can limit requests before they reach the Worker. At most eight sessions; a carrier closes after 20 seconds without a valid MTProxy initialization, four invalid initializations, or 15 minutes without forwarded traffic. Each session also closes if it exceeds 8 MiB/s per direction or the 8,192 frames/s limit.
- Outbound WebSocket handshakes reject redirects. The separate validation Worker is not part of production deployment; if needed, give it its own random `PROBE_TOKEN` (`randomBytes(32).toString('base64url')`) and only enable it while testing.
- Bridge CSP: `default-src 'none'`, `script-src 'nonce-…'` etc.

---

## Limitations

- No voice/video calls, single-user, no `ee` secrets
- Shared PING/PONG remain codec constants; the carrier does not emit PING and rejects unsupported stream-zero controls
- No cipher recovery through hibernation; eviction or carrier loss requires a new session. Upstream `1006` closes its logical stream
- Cloudflare outbound WebSocket `send()` exposes no drain/ack signal. The relay checks `bufferedAmount` when available, and limits throughput and application queues regardless; runtime buffering and large-file reliability still require a real soak.
- Public `resPQ`, Desktop, media, performance, quota, and 24-hour gates remain unverified

---

## Docs

- `app/test/` — Node unit and regression specifications
- `app/runtime-test/` — real Workers runtime carrier/session specification
- `validation/test/` — pinned-upstream, Cloudflare probe, and config-parity specifications
- `app/src/capability.js` — production source of truth for capability and public-host rules
- `shared/telegram-dc.js` — source of truth for Telegram DC-to-WSS host mapping
- root `wrangler.toml` — the only deployment, development, runtime-test, and CI contract

## License

MIT — see [LICENSE](LICENSE).
