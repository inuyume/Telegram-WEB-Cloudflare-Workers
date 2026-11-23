import { isProxyBasePath, normalizeWebProxyHost } from '../src/capability.js';

export function resolveProbeConfig({
  argv = process.argv.slice(2),
  env = process.env,
} = {}) {
  const secretHex = String(env.TASK_PROXY_SECRET ?? '').trim().toLowerCase();
  if (!/^(?:[0-9a-f]{32}|dd[0-9a-f]{32})$/.test(secretHex)) {
    throw new Error('TASK_PROXY_SECRET is missing or invalid');
  }

  const input = String(argv[0] ?? env.TASK_PROXY_HOST ?? '').trim();
  if (!input) throw new Error('TASK_PROXY_HOST or a CLI host argument is required');
  // Check the raw path before URL parsing can normalize dot segments or escapes.
  const match = /^(?:https:\/\/)?([^/\\:@?#%\s]+)(?:\/(.*))?$/i.exec(input);
  const host = match ? normalizeWebProxyHost(match[1]) : '';
  const basePath = match?.[2]?.replace(/\/$/, '') ?? '';
  if (!host || (match[2] && !isProxyBasePath(basePath))) {
    throw new Error('TASK_PROXY_HOST must be a public HTTPS hostname with an optional valid base path');
  }

  return {
    secretHex,
    host,
    basePath,
    base: `https://${host}${basePath ? `/${basePath}` : ''}`,
    transportTag: secretHex.length === 34 ? 0xdddddddd : 0xefefefef,
  };
}
