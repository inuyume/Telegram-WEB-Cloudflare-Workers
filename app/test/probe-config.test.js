import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveProbeConfig } from '../scripts/probe-config.mjs';

const SECRET = '000102030405060708090a0b0c0d0e0f';

test('probe config accepts dd secrets and targets the caller-selected host', () => {
  assert.deepEqual(resolveProbeConfig({
    argv: ['https://proxy.example.com/'],
    env: { TASK_PROXY_SECRET: `dd${SECRET}` },
  }), {
    secretHex: `dd${SECRET}`,
    host: 'proxy.example.com',
    basePath: '',
    base: 'https://proxy.example.com',
    transportTag: 0xdddddddd,
  });

  assert.deepEqual(resolveProbeConfig({
    argv: [],
    env: { TASK_PROXY_SECRET: SECRET, TASK_PROXY_HOST: 'fork.example.com' },
  }), {
    secretHex: SECRET,
    host: 'fork.example.com',
    basePath: '',
    base: 'https://fork.example.com',
    transportTag: 0xefefefef,
  });
});

test('probe config accepts a case-sensitive base path and rejects normalized alternatives', () => {
  const env = { TASK_PROXY_SECRET: SECRET };
  for (const address of ['proxy.example.com/A/b', 'https://proxy.example.com/A/b/']) {
    const config = resolveProbeConfig({ argv: [address], env });
    assert.equal(config.basePath, 'A/b');
    assert.equal(config.base, 'https://proxy.example.com/A/b');
  }
  for (const address of ['proxy.example.com//', 'proxy.example.com/a/../b', 'proxy.example.com/%62',
    'proxy.example.com/a?x=1', 'proxy.example.com/a#frag', 'proxy.example.com:443/a']) {
    assert.throws(() => resolveProbeConfig({ argv: [address], env }), /TASK_PROXY_HOST/);
  }
});

test('probe config rejects malformed secrets and non-HTTPS targets', () => {
  assert.throws(() => resolveProbeConfig({
    argv: [],
    env: { TASK_PROXY_SECRET: SECRET },
  }), /host/i);
  assert.throws(() => resolveProbeConfig({
    argv: ['proxy.example.com'],
    env: { TASK_PROXY_SECRET: `ee${SECRET}` },
  }), /secret/i);
  assert.throws(() => resolveProbeConfig({
    argv: ['http://proxy.example.com'],
    env: { TASK_PROXY_SECRET: SECRET },
  }), /host/i);
});
