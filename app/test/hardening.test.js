import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import test from 'node:test';

import * as entry from '../src/index.js';
import { deployableSecret, mintToken, TOKEN_TTL_MS, verifyToken } from '../src/credentials.js';
import { DialLimiter, RelayBudget, RelayEngine, openTelegramWss } from '../src/relay.js';
import { deriveProxyKeyMaterial } from '../src/mtproxy.js';
import { decodeFrames, encodeFrame, FRAME_TYPES } from '../src/protocol.js';

const SECRET = '000102030405060708090a0b0c0d0e0f';
const DEPLOY_SECRET = randomBytes(16).toString('hex');
const HOST = 'relay.example.com';
const request = (path, init) => new Request(`https://${HOST}${path}`, init);
const allow = { limit: async () => ({ success: true }) };
const frame = (type, streamId, payload = Buffer.alloc(0)) => ({ type, streamId, payload });
const turn = () => new Promise(resolve => setImmediate(resolve));
const socket = () => ({ send() {}, close() {}, addEventListener() {} });

function clientInit() {
  const raw = Buffer.from(Array.from({ length: 64 }, (_, i) => i + 1));
  raw.writeUInt32LE(0xefefefef, 56);
  raw.writeInt16LE(2, 60);
  const keys = deriveProxyKeyMaterial(raw.subarray(0, 56), SECRET);
  const encrypted = createCipheriv('aes-256-ctr', keys.clientToProxyKey, keys.clientToProxyIv).update(raw);
  return Buffer.concat([raw.subarray(0, 56), encrypted.subarray(56)]);
}

test('dial queue rejects excess waiting work and removes cancelled entries immediately', async () => {
  const limiter = new DialLimiter(1, 2);
  let release;
  const active = limiter.run(() => new Promise(resolve => { release = resolve; }));
  await turn();
  const abort = new AbortController();
  let cancelledRan = false;
  const cancelled = limiter.run(() => { cancelledRan = true; }, { signal: abort.signal }).catch(() => 'cancelled');
  const waiting = limiter.run(() => 'waiting');
  const overflow = limiter.run(() => 'overflow').catch(() => 'rejected');
  try {
    assert.equal(limiter.queue.length, 2);
    abort.abort();
    assert.equal(limiter.queue.length, 1);
    assert.equal(await cancelled, 'cancelled');
    assert.equal(await overflow, 'rejected');
    assert.equal(cancelledRan, false);
  } finally {
    abort.abort();
    release();
    await Promise.allSettled([active, cancelled, waiting, overflow]);
  }
});

test('closed streams cannot retain a backlog behind a busy dialer', async () => {
  const limiter = new DialLimiter(1);
  let release;
  const active = limiter.run(() => new Promise(resolve => { release = resolve; }));
  await turn();
  const engine = new RelayEngine({ secret: SECRET, dialLimiter: limiter,
    dialTelegram: async () => socket(), sendCarrier() {}, closeCarrier() {} });
  try {
    for (let id = 1; id <= 200; id++) {
      engine.handleFrame(frame(FRAME_TYPES.OPEN, id));
      engine.handleFrame(frame(FRAME_TYPES.DATA, id, clientInit()));
      engine.handleFrame(frame(FRAME_TYPES.CLOSE, id));
    }
    assert.equal(limiter.queue.length, 0);
    await turn();
    assert.equal(engine.tasks.size, 0);
    assert.equal(engine.budget.pendingBytes, 0);
  } finally {
    release();
    await active;
    await engine.whenIdle();
    engine.shutdown();
  }
});

test('closing a stream aborts its in-flight handshake', async () => {
  let signal;
  let release;
  const engine = new RelayEngine({ secret: SECRET, sendCarrier() {}, closeCarrier() {},
    dialTelegram: (_target, options = {}) => {
      signal = options.signal;
      return new Promise(resolve => { release = () => resolve(socket()); });
    } });
  engine.handleFrame(frame(FRAME_TYPES.OPEN, 1));
  engine.handleFrame(frame(FRAME_TYPES.DATA, 1, clientInit()));
  await turn();
  try {
    engine.handleFrame(frame(FRAME_TYPES.CLOSE, 1));
    assert.equal(signal?.aborted, true);
  } finally { release(); await engine.whenIdle(); engine.shutdown(); }
});

for (const operation of ['CLOSE', 'DATA', 'WINDOW']) {
  test(`carrier ${operation} send failure releases streams and every budget`, () => {
    const closes = [];
    const engine = new RelayEngine({ secret: SECRET, dialTelegram: async () => socket(),
      sendCarrier() { throw new Error('closed carrier'); }, closeCarrier: code => closes.push(code) });
    engine.handleFrame(frame(FRAME_TYPES.OPEN, 1));
    const stream = engine.streams.get(1);
    engine.queueUp(stream, Buffer.alloc(8), 8);
    try {
      assert.doesNotThrow(() => {
        if (operation === 'CLOSE') engine.failStream(stream, 'upstream closed');
        else if (operation === 'DATA') engine.enqueueDown(stream, Buffer.alloc(16));
        else { stream.socket = socket(); engine.flushUp(stream); }
      });
      assert.equal(engine.carrierClosed, true);
      assert.equal(engine.streams.size, 0);
      assert.equal(engine.budget.pendingBytes, 0);
      assert.equal(engine.budget.pendingItems, 0);
      assert.equal(engine.budget.outstandingBytes, 0);
      assert.equal(engine.budget.outstandingItems, 0);
      assert.deepEqual(closes, [1011]);
    } finally { engine.shutdown(); }
  });
}

test('failed carrier flush during shared-budget release cannot strand either engine', () => {
  const budget = new RelayBudget({ maxOutstandingBytes: 8 });
  const engines = [false, true].map(fails => new RelayEngine({ secret: SECRET, budget,
    sendCarrier() { if (fails) throw new Error('closed'); }, closeCarrier() {} }));
  budget.onOutstandingAvailable = () => engines.forEach(engine => engine.flushAllDown());
  for (const engine of engines) engine.handleFrame(frame(FRAME_TYPES.OPEN, 1));
  engines[0].enqueueDown(engines[0].streams.get(1), Buffer.alloc(8));
  engines[1].enqueueDown(engines[1].streams.get(1), Buffer.alloc(8));
  try {
    assert.doesNotThrow(() => engines[0].shutdown());
    assert.equal(engines[1].streams.size, 0);
    assert.equal(budget.pendingBytes, 0);
    assert.equal(budget.outstandingBytes, 0);
  } finally { engines.forEach(engine => { try { engine.shutdown(); } catch {} }); }
});

test('used stream IDs remain forbidden after tombstone eviction, without requiring monotonic IDs', () => {
  const engine = new RelayEngine({ secret: SECRET, maxTombstones: 2, sendCarrier() {}, closeCarrier() {} });
  for (const id of [10, 2, 9]) {
    engine.handleFrame(frame(FRAME_TYPES.OPEN, id));
    assert.equal(engine.streams.has(id), true);
    engine.handleFrame(frame(FRAME_TYPES.CLOSE, id));
  }
  assert.equal(engine.tombstones.has(10), false);
  engine.handleFrame(frame(FRAME_TYPES.OPEN, 10));
  assert.equal(engine.carrierClosed, true);
  engine.shutdown();
});

test('carrier decoder rejects text, including strings containing a valid OPEN', () => {
  assert.throws(() => decodeFrames(encodeFrame(FRAME_TYPES.OPEN, 1).toString('utf8')), /binary/i);
});

test('upstream text cannot be converted into bytes and fed to stream ciphers', () => {
  const engine = new RelayEngine({ secret: SECRET, sendCarrier() {}, closeCarrier() {} });
  engine.handleFrame(frame(FRAME_TYPES.OPEN, 1));
  const stream = engine.streams.get(1);
  stream.direct = { telegramRx: { update() { assert.fail('must reject text before crypto'); } } };
  assert.doesNotThrow(() => engine.handleTelegramData(stream, 'not binary'));
  assert.equal(engine.streams.size, 0);
});

test('downstream crypto processes at most a DATA chunk at a time', () => {
  const engine = new RelayEngine({ secret: SECRET, sendCarrier() {}, closeCarrier() {} });
  engine.handleFrame(frame(FRAME_TYPES.OPEN, 1));
  const stream = engine.streams.get(1);
  const lengths = [];
  stream.direct = { telegramRx: { update(bytes) { lengths.push(bytes.length); return bytes; } } };
  stream.parsed = { clientTx: { update: bytes => bytes } };
  engine.handleTelegramData(stream, new Uint8Array(200000).buffer);
  assert.ok(lengths.length > 1);
  assert.ok(lengths.every(length => length <= 65536));
  assert.equal(lengths.reduce((a, b) => a + b, 0), 200000);
  engine.shutdown();
});

test('session rejects a bootstrap expired or revoked while its request body was pending', async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const relay = new entry.RelayDO({}, { PROXY_SECRET: SECRET });
    const token = 'A'.repeat(43);
    relay.issueBootstrap(new Request('https://relay/internal/bootstrap', {
      headers: { 'X-Bootstrap-Token': token } }));
    let source;
    const pending = relay.session(new Request('https://relay/api/v1/session', {
      method: 'POST', duplex: 'half',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: new ReadableStream({ start(controller) { source = controller; } }),
    }));
    now += 121000;
    relay.sweepExpiredBootstraps();
    source.enqueue(encodeFrame(FRAME_TYPES.HELLO, 0, Buffer.of(1)));
    source.close();
    assert.equal((await pending).status, 404);
    assert.equal(relay.sessionSet.size, 0);
  } finally { Date.now = realNow; }
});

test('session body reader cancels a stalled body under a hard deadline', async () => {
  assert.equal(typeof entry.readBodyAtMost, 'function');
  let cancelled = false;
  const request = new Request('https://relay', { method: 'POST', duplex: 'half',
    body: new ReadableStream({ cancel() { cancelled = true; } }) });
  assert.equal(await entry.readBodyAtMost(request, 64, 10), null);
  assert.equal(cancelled, true);
});

test('public readiness is disabled, while health stays live without a Durable Object', async () => {
  const health = await entry.handleRequest(new Request('https://relay.example.com/healthz'), {});
  assert.equal(health.status, 200);
  const response = await entry.handleRequest(new Request('https://relay.example.com/readyz'), {
    get RELAY() { assert.fail('public readiness must not access relay'); },
  });
  assert.equal(response.status, 404);
});

test('server bearer is short lived and bound to its purpose, host and deployment key', () => {
  const secret = deployableSecret(DEPLOY_SECRET);
  const now = 1_000_000;
  const token = mintToken(secret, 'bootstrap', HOST, '', now);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(verifyToken(token, secret, 'bootstrap', HOST, '', now + TOKEN_TTL_MS - 1), true);
  assert.equal(verifyToken(token, secret, 'bootstrap', HOST, '', now + TOKEN_TTL_MS), false);
  assert.equal(verifyToken(token, secret, 'session', HOST, '', now), false);
  assert.equal(verifyToken(token, secret, 'bootstrap', 'other.example.com', '', now), false);
  assert.equal(verifyToken(token, randomBytes(16), 'bootstrap', HOST, '', now), false);
  const changed = Buffer.from(token, 'base64url');
  changed[31] ^= 1;
  assert.equal(verifyToken(changed.toString('base64url'), secret, 'bootstrap', HOST, '', now), false);
});

test('production never signs a bearer under the documented sample or an all-repeated key', async () => {
  for (const value of [SECRET, `dd${SECRET}`, '00'.repeat(16), 'ff'.repeat(16)]) {
    assert.equal(deployableSecret(value), null);
    const capability = entry.computeCapability(HOST, value);
    const response = await entry.handleRequest(request(`/?bridge=${capability}`), {
      PROXY_SECRET: value, PROXY_ALLOW_ROOT_V1: true, get RELAY() { assert.fail('must not contact relay'); },
    });
    assert.doesNotMatch(await response.text(), /bootstrap=/);
  }
});

test('unverified edge tokens never enter limiters or the DO; valid ones are rate limited first', async () => {
  const secret = deployableSecret(DEPLOY_SECRET);
  const token = mintToken(secret, 'session', HOST);
  const calls = [];
  const env = {
    PROXY_SECRET: DEPLOY_SECRET,
    PROXY_ALLOW_ROOT_V1: true,
    RELAY_CLIENT_LIMIT: { async limit({ key }) { calls.push(key); return { success: true }; } },
    RELAY_EDGE_LIMIT: { async limit({ key }) { calls.push(key); return { success: false }; } },
    get RELAY() { assert.fail('must not contact relay'); },
  };
  const session = t => request('/api/v1/session', {
    method: 'DELETE', headers: { Authorization: `Bearer ${t}`, 'CF-Connecting-IP': '192.0.2.9', 'X-Forwarded-For': '192.0.2.4' },
  });
  for (const invalid of ['A'.repeat(43), mintToken(secret, 'bootstrap', HOST),
    mintToken(secret, 'session', 'other.example.com'), mintToken(secret, 'session', HOST, '', Date.now() - 121_000)]) {
    assert.equal((await entry.handleRequest(session(invalid), env)).status, 404);
  }
  assert.deepEqual(calls, []);
  assert.equal((await entry.handleRequest(session(token), env)).status, 429);
  assert.deepEqual(calls, ['192.0.2.9', 'personal-telegram-relay-v1']);
  assert.equal((await entry.handleRequest(session(token), { PROXY_SECRET: DEPLOY_SECRET, PROXY_ALLOW_ROOT_V1: true })).status, 503);
});

test('an IP allowlist restricts credential-bearing routes across hostnames but not health', async () => {
  const hits = [];
  const env = {
    PROXY_SECRET: DEPLOY_SECRET, RELAY_ALLOWED_IPS: '2001:db8::1,192.0.2.9',
    PROXY_ALLOW_ROOT_V1: true,
    RELAY_CLIENT_LIMIT: allow, RELAY_EDGE_LIMIT: allow,
    RELAY: { getByName: () => ({ fetch: async () => { hits.push(1); return new Response(null, { status: 204 }); } }) },
  };
  for (const host of [HOST, 'alternate.example.com']) {
    const url = `https://${host}/?bridge=${entry.computeCapability(host, DEPLOY_SECRET)}`;
    assert.equal((await entry.handleRequest(new Request(url), env)).status, 404);
    assert.equal((await entry.handleRequest(new Request(url, { headers: { 'X-Forwarded-For': '192.0.2.9' } }), env)).status, 404);
    const headers = { 'CF-Connecting-IP': '2001:0db8:0000:0000:0000:0000:0000:0001' };
    assert.equal((await entry.handleRequest(new Request(url, { headers }), env)).status, 200);
    assert.equal((await entry.handleRequest(new Request(url, { headers }), { ...env, RELAY_ALLOWED_IPS: '' })).status, 404);
  }
  assert.equal(hits.length, 2);
  assert.equal((await entry.handleRequest(request('/healthz'), env)).status, 200);
});

test('carrier rate exhaustion closes the session and releases outstanding relay resources', () => {
  let now = 0;
  const closes = [];
  const engine = new RelayEngine({ secret: SECRET, now: () => now, bytesPerSecond: 128,
    framesPerSecond: 2, sendCarrier() {}, closeCarrier: code => closes.push(code) });
  engine.handleFrame(frame(FRAME_TYPES.OPEN, 1));
  engine.enqueueDown(engine.streams.get(1), Buffer.alloc(8));
  assert.equal(engine.acceptCarrierBatch(128, 2), true);
  now = 500;
  assert.equal(engine.acceptCarrierBatch(64, 1), true);
  assert.equal(engine.acceptCarrierBatch(1, 1), false);
  assert.deepEqual(closes, [1008]);
  assert.equal(engine.budget.outstandingBytes, 0);
  assert.equal(engine.streams.size, 0);
});

test('slow upstream cannot retain queued bytes or earn WINDOW credit when its socket is full', async () => {
  let upstreamWrites = 0;
  let upstreamClosed = 0;
  const frames = [];
  const engine = new RelayEngine({ secret: SECRET,
    dialTelegram: async () => ({
      bufferedAmount: 4 * 1024 * 1024,
      send() { upstreamWrites++; }, close() { upstreamClosed++; }, addEventListener() {},
    }),
    sendCarrier: value => frames.push(...decodeFrames(value)), closeCarrier: () => assert.fail('stream only'),
  });
  engine.handleFrame(frame(FRAME_TYPES.OPEN, 1));
  await engine.handleFrame(frame(FRAME_TYPES.DATA, 1, clientInit()));
  assert.equal(upstreamWrites, 0);
  assert.equal(upstreamClosed, 1);
  assert.deepEqual(frames.map(({ type }) => type), [FRAME_TYPES.CLOSE]);
  assert.equal(engine.budget.pendingBytes, 0);
  assert.equal(engine.budget.pendingItems, 0);
  assert.equal(engine.streams.size, 0);
});

test('repeated invalid MTProxy initializations terminate the carrier without dialing or refreshing idle', () => {
  const closes = [];
  const engine = new RelayEngine({ secret: SECRET, sendCarrier() {}, closeCarrier: code => closes.push(code),
    dialTelegram: () => assert.fail('invalid init must not dial'), onAuthenticated: () => assert.fail('must not authenticate') });
  for (let id = 1; id <= 4; id++) {
    engine.handleFrame(frame(FRAME_TYPES.OPEN, id));
    engine.handleFrame(frame(FRAME_TYPES.DATA, id, Buffer.alloc(64)));
  }
  assert.deepEqual(closes, [1008]);
  assert.equal(engine.streams.size, 0);
});

test('outbound handshake never follows a redirect', async () => {
  const seen = [];
  await assert.rejects(openTelegramWss({ host: 'venus.web.telegram.org' }, {
    fetchImpl: async (url, { redirect }) => {
      seen.push([url, redirect]);
      return Response.redirect('https://example.com');
    },
  }), /handshake failed/);
  assert.deepEqual(seen, [['https://venus.web.telegram.org/apiws', 'manual']]);
});

test('outbound handshake propagates caller cancellation to fetch', async () => {
  const abort = new AbortController();
  const pending = openTelegramWss({ host: 'venus.web.telegram.org' }, {
    signal: abort.signal,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), timeoutMs: 30,
  });
  const expected = new Error('stream closed');
  abort.abort(expected);
  await assert.rejects(pending, error => error === expected);
});
