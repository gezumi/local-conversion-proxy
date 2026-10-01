import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildCatalog } from '../src/catalog.mjs';
import { startProxy } from '../src/main.mjs';
import { DEFAULTS, normalizeSettings } from '../src/settings.mjs';
import { proxyHealth } from '../src/verify.mjs';

const norm = (over) => normalizeSettings({ ...structuredClone(DEFAULTS), ...over });

test('settings: a URL that does not parse falls back to the default (the proxy must always start)', () => {
  for (const bad of ['https://[', 'ftp://example.com', 'https://', 'not a url', 42]) {
    assert.equal(norm({ upstream: bad }).upstream, DEFAULTS.upstream, String(bad));
    assert.equal(norm({ ollama: { ...DEFAULTS.ollama, baseUrl: bad } }).ollama.baseUrl, DEFAULTS.ollama.baseUrl, String(bad));
  }
  assert.equal(norm({ upstream: 'http://127.0.0.1:9/backend-api/codex' }).upstream, 'http://127.0.0.1:9/backend-api/codex');
});

test('a malformed upstream in settings.json does not stop the proxy from starting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcp-set-'));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ upstream: 'https://[' }));
  const proxy = await startProxy({ env: { ...process.env, LCP_CONFIG_DIR: dir, LCP_LOG_DIR: join(dir, 'logs') }, port: 0, logger: { event() {} }, availability: false });
  try {
    assert.equal((await proxyHealth(proxy.port)).ok, true);
  } finally {
    await proxy.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('catalog: numCtx null keeps the model\'s own context; absent means the catalog window', () => {
  const s = norm({ ollama: { enabled: true, baseUrl: DEFAULTS.ollama.baseUrl, models: [{ id: 'a:1b', contextWindow: 8192, numCtx: null }, { id: 'b:1b', contextWindow: 8192 }, { id: 'c:1b', contextWindow: 8192, numCtx: 4096 }] } });
  const by = Object.fromEntries(buildCatalog(s).filter((e) => e.backend === 'ollama').map((e) => [e.target.model, e.target.numCtx]));
  assert.deepEqual(by, { 'a:1b': null, 'b:1b': 8192, 'c:1b': 4096 });
});

test('catalog: turned-off accounts and Ollama are not listed, but stay routable as disabled', () => {
  const s = norm({ claude: { ...DEFAULTS.claude, accounts: [{ id: '1' }, { id: '2', disabled: true }] }, ollama: { ...DEFAULTS.ollama, enabled: false } });
  const listed = buildCatalog(s).map((e) => e.slug);
  assert.ok(!listed.some((x) => x.endsWith('-a2') || x.startsWith('local-')));
  const routes = buildCatalog(s, null, { includeDisabled: true });
  assert.ok(routes.filter((e) => e.slug.endsWith('-a2')).every((e) => e.disabled));
  assert.ok(routes.filter((e) => e.slug.startsWith('local-')).every((e) => e.disabled));
  assert.ok(routes.filter((e) => e.target.account?.id === '1').every((e) => !e.disabled));
});

test('health: another service answering on the port is never taken for the proxy', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'something-else' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    assert.equal((await proxyHealth(server.address().port)).ok, false);
  } finally {
    server.close();
  }
});

test('catalog: every slug names one entry (colliding Ollama ids get a short hash; repeated ids collapse)', () => {
  const s = norm({ ollama: { enabled: true, baseUrl: DEFAULTS.ollama.baseUrl, models: [{ id: 'qwen:27b' }, { id: 'qwen-27b' }, { id: 'qwen:27b' }] } });
  const slugs = buildCatalog(s).filter((e) => e.backend === 'ollama').map((e) => e.slug);
  assert.equal(slugs.length, 2, 'a repeated id is one model');
  assert.equal(new Set(slugs).size, 2);
  assert.equal(slugs[0], 'local-qwen-27b');
  assert.match(slugs[1], /^local-qwen-27b-[0-9a-f]{6}$/);
  // the same slugs whatever is available at the moment
  const availOnlySecond = { claudeAccount: () => true, ollamaModel: (id) => id === 'qwen-27b' };
  assert.deepEqual(buildCatalog(s, availOnlySecond).filter((e) => e.backend === 'ollama').map((e) => e.slug), [slugs[1]]);
});

test('the service and its watchdog run with the Codex home and settings this install used', async () => {
  const { serviceEnv } = await import('../src/service.mjs');
  const env = serviceEnv({ home: '/Users/x', codexHome: '/custom/codex', configDir: '/custom/cfg', logDir: '/custom/logs' });
  assert.equal(env.CODEX_HOME, '/custom/codex');
  assert.equal(env.LCP_CONFIG_DIR, '/custom/cfg');
  assert.equal(env.LCP_LOG_DIR, '/custom/logs');
  assert.equal(env.HOME, '/Users/x');
});

test('catalog: a hashed Ollama slug that is itself taken is extended until it is unique', async () => {
  const { createHash } = await import('node:crypto');
  const h6 = createHash('sha256').update('q/a').digest('hex').slice(0, 6);
  const s = norm({ ollama: { enabled: true, baseUrl: DEFAULTS.ollama.baseUrl, models: [{ id: 'q:a' }, { id: `q-a-${h6}` }, { id: 'q/a' }] } });
  const slugs = buildCatalog(s).filter((e) => e.backend === 'ollama').map((e) => e.slug);
  assert.equal(slugs.length, 3);
  assert.equal(new Set(slugs).size, 3, JSON.stringify(slugs));
});

test('the service PATH reaches the chosen node and the Claude launcher (an nvm launcher runs `env node`)', async () => {
  const { serviceEnv } = await import('../src/service.mjs');
  const env = serviceEnv({ home: '/Users/x', codexHome: '/c', configDir: '/g', logDir: '/l' }, { node: '/Users/x/.nvm/versions/node/v24.1.0/bin/node', claudeBin: '/Users/x/.nvm/versions/node/v24.1.0/bin/claude' });
  assert.equal(env.PATH.split(':')[0], '/Users/x/.nvm/versions/node/v24.1.0/bin');
  assert.equal(env.PATH.split(':').filter((d) => d.includes('.nvm')).length, 1, 'no duplicates');
});

test('the Codex check settles once whatever the app-server does (no crash on a broken pipe)', async () => {
  const { codexProbe } = await import('../src/verify.mjs');
  const { chmodSync, mkdtempSync, writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'lcp-probe-'));
  const bin = join(dir, 'fake-codex');
  // answers initialize, then exits: later writes hit a closed pipe
  writeFileSync(bin, `#!/bin/sh\nread line\necho '{"id":1,"result":{}}'\nexit 0\n`);
  chmodSync(bin, 0o755);
  const r = await codexProbe({ bin, timeoutMs: 5000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /^app_server_(closed|exited)$/);
});
