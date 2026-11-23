import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { randomBytes } from 'node:crypto';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: '../wrangler.toml' },
      miniflare: {
        bindings: {
          PROXY_SECRET: randomBytes(16).toString('hex'),
          PROXY_BASE_PATH: 'My-Relay/v2',
          RELAY_DEBUG: '0',
          __carrierTimeouts: { initMs: 500, idleMs: 1000 },
        },
      },
    }),
  ],
  test: {
    include: ['runtime-test/**/*.worker.js'],
    testTimeout: 15_000,
  },
});
