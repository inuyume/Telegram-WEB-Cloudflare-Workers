/**
 * Telegram WEB Proxy — Cloudflare Worker entry + Relay Durable Object
 *
 * Compatible with telegramdesktop/tproxy-server@52a5feb7 and
 * Telegram Desktop v7.1.2 WEB Proxy v1 (websocket carrier).
 *
 * - Validates bridge capability (HMAC) and mints bootstrap tokens
 * - Terminates MTProxy outer obfuscation and relays to Telegram official WSS
 * - Enforces bounded flow control and constant-time secret comparison
 */
import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { DurableObject } from 'cloudflare:workers';

import { isProxyBasePath, matchesBridgeCapability } from './capability.js';
import { bridgePage } from './bridge.js';
import { deployableSecret, mintToken, TOKEN_TTL_MS, verifyToken } from './credentials.js';
import { decodeFrames, encodeFrame, FRAME_TYPES } from './protocol.js';
import {
  DialLimiter,
  openTelegramWss,
  RelayBudget,
  RelayEngine,
  sendBounded,
} from './relay.js';

export { encodeFrame, FRAME_TYPES } from './protocol.js';
export { computeCapability, normalizeWebProxyHost } from './capability.js';

const MAX_BOOTSTRAPS = 64;
const MAX_SESSIONS = 8;
const CARRIER_INIT_MS = 20_000;
const CARRIER_IDLE_MS = 15 * 60_000;
/** Singleton DO name for the personal relay */
const PROXY_OBJECT_NAME = 'personal-telegram-relay-v1';

function json(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(value), { ...init, headers });
}

function notFound() {
  return new Response('Not found', {
    status: 404,
    headers: { 'cache-control': 'no-store' },
  });
}

function busy() {
  return new Response('Service unavailable', {
    status: 503,
    headers: { 'cache-control': 'no-store', 'retry-after': '1' },
  });
}

async function limitRelayRequest(request, env) {
  try {
    // CF-Connecting-IP is supplied by the edge. Never key on a presented token
    // or X-Forwarded-For, and share limits across all hostnames of this Worker.
    const ip = normalizedIp(request.headers.get('CF-Connecting-IP') || '') || 'unknown';
    const client = await env.RELAY_CLIENT_LIMIT.limit({ key: ip });
    if (client.success && (await env.RELAY_EDGE_LIMIT.limit({ key: PROXY_OBJECT_NAME })).success) return null;
    return new Response('Too many requests', {
      status: 429, headers: { 'cache-control': 'no-store', 'retry-after': '60' },
    });
  } catch { return busy(); }
}

function normalizedIp(value) {
  if (value.includes('%')) return ''; // No IPv6 zone IDs in a public source address.
  const family = isIP(value);
  if (family === 4) return value;
  if (family === 6) return new URL(`http://[${value}]/`).hostname;
  return '';
}

function permitsClient(request, env) {
  if (env.RELAY_ALLOWED_IPS === undefined) return true;
  const client = normalizedIp(request.headers.get('CF-Connecting-IP') || '');
  const allowed = String(env.RELAY_ALLOWED_IPS).split(',').map(value => normalizedIp(value.trim()));
  return Boolean(client) && allowed.every(Boolean) && allowed.includes(client);
}

function proxyRoute(pathname, env) {
  const flag = env.PROXY_ALLOW_ROOT_V1;
  const allowRoot = flag === true || flag === 'true';
  if (!allowRoot && flag !== undefined && flag !== false && flag !== 'false') return null;
  const configured = env.PROXY_BASE_PATH === undefined ? '' : env.PROXY_BASE_PATH;
  if (configured !== '' && !isProxyBasePath(configured)) return null;
  // Check exact endpoint paths, including the bridge's required trailing slash.
  for (const basePath of [configured || null, allowRoot ? '' : null]) {
    if (basePath === null) continue;
    const prefix = basePath ? `/${basePath}` : '';
    if (!pathname.startsWith(`${prefix}/`)) continue;
    const endpoint = pathname.slice(prefix.length);
    if (endpoint === '/' || endpoint === '/api/v1/session' || endpoint === '/api/v1/ws') {
      return { basePath, endpoint };
    }
  }
  return null;
}

function validApiRequest(request, endpoint) {
  if (endpoint === '/api/v1/session') {
    if (request.headers.has('Cookie') || !bearer(request.headers.get('Authorization'))) return false;
    if (request.method === 'DELETE') return true;
    if (request.method !== 'POST'
      || request.headers.get('Content-Type') !== 'application/octet-stream') return false;
    const length = request.headers.get('Content-Length');
    return length === null || (/^\d+$/.test(length) && Number(length) <= 64);
  }
  if (endpoint === '/api/v1/ws') {
    return request.method === 'GET'
      && request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
      && parseCarrierProtocol(request.headers.get('Sec-WebSocket-Protocol') || '') !== null;
  }
  return false;
}

export async function readBodyAtMost(request, maxBytes, timeoutMs = 10_000) {
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    void request.body?.cancel('body too large').catch(() => {});
    return null;
  }
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  let timer;
  const read = async () => {
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return Buffer.concat(chunks, total);
        if (total + value.byteLength > maxBytes) {
          void reader.cancel('body too large').catch(() => {});
          return null;
        }
        const bytes = Buffer.from(value);
        total += bytes.length;
        chunks.push(bytes);
      }
    } catch { return null; }
  };
  try {
    return await Promise.race([read(), new Promise(resolve => {
      timer = setTimeout(() => {
        resolve(null);
        void reader.cancel('body deadline exceeded').catch(() => {});
      }, timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function parseCarrierProtocol(protocol) {
  if (typeof protocol !== 'string' || !protocol.startsWith('tproxy-v1.')) return null;
  const token = protocol.slice('tproxy-v1.'.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return { token };
}

function validBridgeCapability(url, secret, basePath) {
  if (!secret) return false;
  const { searchParams } = url;
  return searchParams.size === 1
    && matchesBridgeCapability(searchParams.get('bridge'), url.hostname, secret.toString('hex'), basePath);
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/healthz' && request.method === 'GET') {
    return json({ ok: true, service: 'telegram-web-proxy' });
  }
  if (url.protocol !== 'https:') return notFound();
  if (!permitsClient(request, env)) return notFound();
  const route = proxyRoute(url.pathname, env);
  if (!route) return notFound();
  const { basePath, endpoint } = route;
  if (endpoint === '/' && request.method === 'GET') {
    const secret = url.search ? deployableSecret(env.PROXY_SECRET) : null;
    if (!validBridgeCapability(url, secret, basePath)) {
      if (basePath) return notFound();
      return new Response('<!doctype html><title>Telegram WEB Proxy</title><p>Telegram WEB Proxy</p>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    const limited = await limitRelayRequest(request, env);
    if (limited) return limited;
    const bootstrap = mintToken(secret, 'bootstrap', url.hostname, basePath);
    const relay = env.RELAY.getByName(PROXY_OBJECT_NAME);
    const response = await relay.fetch(new Request('https://relay/internal/bootstrap', {
      method: 'POST',
      headers: { 'X-Bootstrap-Token': bootstrap },
    }));
    if (!response.ok) return response.status === 503 ? busy() : notFound();
    const nonce = randomBytes(18).toString('base64url');
    const page = bridgePage(url.hostname, bootstrap, nonce, basePath);
    return new Response(page.body, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': page.csp,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'x-dns-prefetch-control': 'off',
      },
    });
  }
  if (url.search || !validApiRequest(request, endpoint)) return notFound();
  const token = endpoint === '/api/v1/ws'
    ? parseCarrierProtocol(request.headers.get('Sec-WebSocket-Protocol')).token
    : bearer(request.headers.get('Authorization'));
  const purpose = request.method === 'POST' ? 'bootstrap' : 'session';
  if (!verifyToken(token, deployableSecret(env.PROXY_SECRET), purpose, url.hostname, basePath)) return notFound();
  const limited = await limitRelayRequest(request, env);
  if (limited) return limited;
  return env.RELAY.getByName(PROXY_OBJECT_NAME).fetch(request);
}

export default { fetch: handleRequest };

export class RelayDO extends DurableObject {
  constructor(ctx, env = {}) {
    super(ctx, env);
    // A live Telegram upstream carries non-persistable AES-CTR state. Keep the
    // carrier on the standard in-memory WebSocket API; on eviction/restart the
    // socket closes and Telegram rebuilds the stream instead of reusing cipher
    // state in a new object instance.
    this.bootId = randomBytes(16).toString('hex');
    this.bootstraps = new Map();
    this.sessions = new Map();
    this.sessionSet = new Set();
    this.sockets = new Map();
    this.relayBudget = new RelayBudget({
      onOutstandingAvailable: () => this.flushRelayDown(),
    });
    this.dialLimiter = new DialLimiter();
    this.schedule = env.__setTimeout ?? setTimeout;
    this.cancelTimer = env.__clearTimeout ?? clearTimeout;
    this.initMs = env.__carrierTimeouts?.initMs ?? CARRIER_INIT_MS;
    this.idleMs = env.__carrierTimeouts?.idleMs ?? CARRIER_IDLE_MS;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/internal/bootstrap') return this.issueBootstrap(request);
    const route = proxyRoute(url.pathname, this.env);
    if (route?.endpoint === '/api/v1/session') return this.session(request, route.basePath);
    if (route?.endpoint === '/api/v1/ws') return this.attachWebSocket(request);
    if (url.pathname === '/healthz') return json({ ok: true, bootId: this.bootId });
    return notFound();
  }

  issueBootstrap(request) {
    const token = request.headers.get('X-Bootstrap-Token') || '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return notFound();
    this.sweepExpiredBootstraps();
    this.sweepExpiredSessions();
    const hash = tokenHash(token);
    if (!this.bootstraps.has(hash) && this.bootstraps.size >= MAX_BOOTSTRAPS) return busy();
    this.bootstraps.set(hash, {
      tokenHash: hash,
      createdAt: Date.now(),
    });
    return new Response(null, { status: 204 });
  }

  async session(request, basePath = '') {
    this.sweepExpiredBootstraps();
    this.sweepExpiredSessions();
    const token = bearer(request.headers.get('Authorization'));
    if (!token) return notFound();
    const hash = tokenHash(token);
    if (request.method === 'DELETE') {
      const session = this.sessions.get(hash);
      if (!session || session.hash !== hash) return notFound();
      this.disposeSession(session, 'session deleted');
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    }
    if (request.method !== 'POST' || request.headers.get('Content-Type') !== 'application/octet-stream') return notFound();
    const bootstrap = this.bootstraps.get(hash);
    if (!bootstrap || Date.now() - bootstrap.createdAt >= TOKEN_TTL_MS) return notFound();
    const body = await readBodyAtMost(request, 64);
    if (body === null || this.bootstraps.get(hash) !== bootstrap
      || Date.now() - bootstrap.createdAt >= TOKEN_TTL_MS) return notFound();
    let frames;
    try { frames = decodeFrames(body); } catch { return notFound(); }
    if (frames.length !== 1 || frames[0].type !== FRAME_TYPES.HELLO || frames[0].streamId !== 0 || Buffer.compare(frames[0].payload, Buffer.of(1)) !== 0) return notFound();
    const fingerprint = Buffer.from(body).toString('base64url');
    const existing = this.sessions.get(hash);
    if (existing) {
      if (existing.socket || existing.fingerprint !== fingerprint) return notFound();
      return this.sessionResponse(existing.token, existing.welcome);
    }
    if (this.sessionSet.size >= MAX_SESSIONS) return busy();
    const secret = deployableSecret(this.env.PROXY_SECRET);
    if (!secret) return notFound();
    const sessionToken = mintToken(secret, 'session', new URL(request.url).hostname, basePath);
    const welcome = encodeFrame(FRAME_TYPES.WELCOME, 0);
    const session = {
      token: sessionToken,
      hash: tokenHash(sessionToken),
      bootstrapHash: hash,
      fingerprint,
      welcome,
      createdAt: Date.now(),
      socket: null,
    };
    this.sessions.set(hash, session);
    this.sessions.set(session.hash, session);
    this.sessionSet.add(session);
    return this.sessionResponse(sessionToken, welcome);
  }

  sessionResponse(token, welcome) {
    return new Response(welcome, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'cache-control': 'no-store',
        'x-session-token': token,
        'x-down-cursor': '0',
        'x-carrier-mode': 'websocket',
      },
    });
  }

  sweepExpiredBootstraps(now = Date.now()) {
    for (const [hash, bootstrap] of this.bootstraps) {
      if (now - bootstrap.createdAt >= TOKEN_TTL_MS) this.bootstraps.delete(hash);
    }
  }

  sweepExpiredSessions(now = Date.now()) {
    for (const session of this.sessionSet) {
      if (!session.socket && now - session.createdAt >= TOKEN_TTL_MS) {
        this.disposeSession(session, 'session expired');
      }
    }
  }

  attachWebSocket(request) {
    this.sweepExpiredBootstraps();
    this.sweepExpiredSessions();
    const parsed = parseCarrierProtocol(request.headers.get('Sec-WebSocket-Protocol') || '');
    if (!parsed) return notFound();
    const session = this.sessions.get(tokenHash(parsed.token));
    if (!session || session.token !== parsed.token || session.socket) return notFound();
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return notFound();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    session.socket = server;
    this.bootstraps.delete(session.bootstrapHash);
    this.sessions.delete(session.bootstrapHash);
    const dialTelegram = this.env.__dialTelegram
      ?? ((target, options) => openTelegramWss(target, { ...options, fetchImpl: this.env.__fetch ?? fetch }));
    session.engine = new RelayEngine({
      secret: this.env.PROXY_SECRET,
      randomBytes: this.env.__randomBytes,
      dialTelegram,
      sendCarrier: (frame) => sendBounded(server, frame),
      closeCarrier: (code, reason) => {
        try { server.close?.(code, reason); }
        finally { this.disposeSession(session, reason, false); }
      },
      debug: this.env.RELAY_DEBUG === '1',
      budget: this.relayBudget,
      dialLimiter: this.dialLimiter,
      onAuthenticated: () => this.markAuthenticated(session),
      onTraffic: () => { session.lastTrafficAt = Date.now(); },
    });
    this.sockets.set(server, session);
    try { server.binaryType = 'arraybuffer'; } catch {}
    if (typeof server.accept === 'function') {
      server.accept();
      server.addEventListener?.('message', (event) => {
        const idle = this.webSocketMessage(server, event.data);
        if (idle && typeof this.ctx.waitUntil === 'function') this.ctx.waitUntil(idle);
      });
    }
    server.addEventListener?.('close', () => this.detach(server));
    server.addEventListener?.('error', () => this.detach(server));
    this.armCarrierTimer(session, this.initMs);
    const protocol = `tproxy-v1.${session.token}`;
    try {
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: { 'sec-websocket-protocol': protocol },
      });
    } catch (error) {
      // Node's standard Response rejects 101, while the Workers runtime
      // provides the WebSocket upgrade response extension.
      if (!(error instanceof RangeError)) throw error;
      return {
        status: 101,
        webSocket: client,
        headers: new Headers({ 'sec-websocket-protocol': protocol }),
      };
    }
  }

  webSocketMessage(socket, message) {
    const session = this.sockets.get(socket);
    if (!session) return;
    const work = [];
    let frames;
    try {
      frames = decodeFrames(message);
    } catch (error) {
      const msg = String(error?.message ?? error).slice(0, 80);
      if (this.env.RELAY_DEBUG === '1') console.log(JSON.stringify({ diag: 'ws-decode-fail', error: msg }));
      session.engine.protocolError(msg || 'protocol error');
      return;
    }
    if (!session.engine.acceptCarrierBatch(message.byteLength, frames.length)) return;
    for (const frame of frames) {
      if (frame.streamId === 0) {
        session.engine.protocolError('unsupported frame');
        return work.length ? Promise.all(work) : undefined;
      }
      const pending = session.engine.handleFrame(frame);
      if (pending) work.push(pending);
      if (!session.engine || session.engine.carrierClosed) {
        return work.length ? Promise.all(work) : undefined;
      }
    }
    return work.length ? Promise.all(work) : undefined;
  }

  webSocketClose(socket) {
    this.detach(socket);
  }

  webSocketError(socket) {
    this.detach(socket);
  }

  detach(socket) {
    const session = this.sockets.get(socket);
    if (!session) return;
    this.disposeSession(session, 'carrier detached');
  }

  markAuthenticated(session) {
    if (session.lastTrafficAt !== undefined) return;
    session.lastTrafficAt = Date.now();
    this.armCarrierTimer(session, this.idleMs);
  }

  armCarrierTimer(session, delay) {
    this.cancelTimer(session.timer);
    session.timer = this.schedule(() => {
      if (!session.engine) return;
      if (session.lastTrafficAt === undefined) {
        session.engine.terminateCarrier(1008, 'MTProxy initialization deadline');
        return;
      }
      const remaining = session.lastTrafficAt + this.idleMs - Date.now();
      if (remaining > 0) this.armCarrierTimer(session, remaining);
      else session.engine.terminateCarrier(1008, 'carrier idle');
    }, delay);
    session.timer?.unref?.();
  }

  disposeSession(session, reason, closeSocket = true) {
    const engine = session.engine, socket = session.socket;
    this.cancelTimer(session.timer);
    session.timer = undefined;
    session.engine = null;
    session.socket = null;
    if (socket) this.sockets.delete(socket);
    this.sessions.delete(session.hash);
    this.sessions.delete(session.bootstrapHash);
    this.sessionSet.delete(session);
    this.bootstraps.delete(session.bootstrapHash);
    try { engine?.shutdown(reason); }
    finally {
      if (closeSocket) {
        try { socket?.close?.(1000, reason); } catch { try { socket?.close?.(); } catch {} }
      }
    }
  }

  flushRelayDown() {
    for (const session of this.sessionSet) session.engine?.flushAllDown();
  }
}

function bearer(value) {
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return '';
  const token = value.slice(7);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : '';
}
