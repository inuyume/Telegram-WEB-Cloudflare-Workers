import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseProxySecret } from './mtproxy.js';

export const TOKEN_TTL_MS = 120_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// Reject the published README example (including dd mode) and repeated bytes.
export function deployableSecret(value) {
  try {
    const { key, credential } = parseProxySecret(value);
    if (key.toString('hex') === '000102030405060708090a0b0c0d0e0f'
      || key.every(byte => byte === key[0])) return null;
    return credential;
  } catch { return null; }
}

function authenticator(secret, purpose, host, basePath, claims) {
  return createHmac('sha256', secret)
    .update(`telegram-web-proxy/edge-token-v1\n${purpose}\n${host}\n`)
    // Preserve already-issued root tokens; prefixed scopes add a delimited path.
    .update(basePath ? `${basePath}\n` : '')
    .update(claims)
    .digest().subarray(0, 16);
}

// Keep the existing 43-character bearer and WebSocket subprotocol wire format.
// The DO registry still decides whether a signed token has been issued/revoked.
export function mintToken(secret, purpose, host, basePath = '', now = Date.now()) {
  const claims = randomBytes(16);
  claims.writeUInt32BE(Math.ceil((now + TOKEN_TTL_MS) / 1000));
  return Buffer.concat([claims, authenticator(secret, purpose, host, basePath, claims)]).toString('base64url');
}

export function verifyToken(token, secret, purpose, host, basePath = '', now = Date.now()) {
  if (!secret || typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return false;
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== token) return false;
  if (now >= bytes.readUInt32BE(0) * 1000) return false;
  return timingSafeEqual(bytes.subarray(16), authenticator(secret, purpose, host, basePath, bytes.subarray(0, 16)));
}
