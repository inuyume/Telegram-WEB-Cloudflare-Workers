import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeCapability,
  isProxyBasePath,
  matchesBridgeCapability,
  normalizeWebProxyHost,
} from '../src/capability.js';

const SECRET_HEX = '000102030405060708090a0b0c0d0e0f';

test('canonical capability module normalizes the public host and preserves the fixed vector', () => {
  assert.equal(normalizeWebProxyHost(' RELAY.EXAMPLE.COM '), 'relay.example.com');
  assert.equal(
    computeCapability('RELAY.EXAMPLE.COM', SECRET_HEX),
    'aNQ8R-WMZNgKDbfI2vzmQ6lqpRq6BvcjxA2AbeKQ3YQ',
  );
});

test('base path capability matches upstream v2 vectors and is case-sensitive', () => {
  const path = 'dobry-cola-super-app';
  const cap = computeCapability('Proxy.Example.Com', SECRET_HEX, path);
  assert.equal(cap, 'hHz99Xs93EN1j91G9gpNepXwGNNt5YdAFkEVk_LlqdQ');
  assert.equal(computeCapability('proxy.example.com', `dd${SECRET_HEX}`, path),
    'TGUkZaevsavLbHvlNWipnRoYxgzZ51ioWvbxgGT3wHo');
  assert.equal(matchesBridgeCapability(cap, 'proxy.example.com', SECRET_HEX, path), true);
  assert.equal(matchesBridgeCapability(cap, 'proxy.example.com', SECRET_HEX, path.toUpperCase()), false);
  assert.equal(matchesBridgeCapability(cap, 'proxy.example.com', SECRET_HEX), false);
});

test('base path syntax is exact and bounded', () => {
  assert.equal(isProxyBasePath('my-Relay/v2_1'), true);
  assert.equal(isProxyBasePath('a'.repeat(128)), true);
  for (const invalid of ['/relay', 'relay/', 'a//b', 'a/../b', '%61', '_relay', 'a\n', 'a?b', 'a'.repeat(129)]) {
    assert.equal(isProxyBasePath(invalid), false, JSON.stringify(invalid));
    assert.throws(() => computeCapability('proxy.example.com', SECRET_HEX, invalid), /base path/);
  }
});

test('canonical capability module owns capability validation and comparison', () => {
  const capability = computeCapability('relay.example.com', SECRET_HEX);
  assert.equal(
    matchesBridgeCapability(capability, 'RELAY.EXAMPLE.COM', SECRET_HEX),
    true,
  );
  assert.equal(
    matchesBridgeCapability(`${capability.slice(0, -1)}A`, 'relay.example.com', SECRET_HEX),
    false,
  );
  assert.equal(matchesBridgeCapability('not-a-capability', 'relay.example.com', SECRET_HEX), false);
  assert.equal(matchesBridgeCapability(capability, 'relay.example.0x12', SECRET_HEX), false);
});
