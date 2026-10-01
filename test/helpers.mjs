import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { startProxy } from '../src/main.mjs';
import { createOwnerCheck } from '../src/owner.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

/** A wrapper executable that runs the fake Claude CLI with a scenario (the proxy strips env). */
export function makeFake(scenario = { turns: [] }, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lcp-test-'));
  const scenarioPath = join(dir, 'scenario.json');
  const recordPath = join(dir, 'record.jsonl');
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const vars = { FAKE_SCENARIO: scenarioPath, FAKE_RECORD: recordPath, ...env };
  const exports = Object.entries(vars)
    .map(([k, v]) => `${k}='${String(v).replace(/'/g, `'\\''`)}'`)
    .join(' ');
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/bin/sh\nexport ${exports}\nexec '${process.execPath}' '${FAKE}' "$@"\n`);
  chmodSync(bin, 0o755);
  return {
    bin,
    dir,
    record: () => (existsSync(recordPath) ? readFileSync(recordPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * A fake ChatGPT Codex backend: /backend-api/codex/models, an echoing HTTP
 * route, and the Responses WebSocket. Everything it receives is recorded.
 */
export async function fakeUpstream({ models = [{ slug: 'gpt-test', display_name: 'GPT Test', visibility: 'list' }], wsReject = null, wsRejectEncoding = null, modelsEncoding = null, modelsRaw = null, wsCompleteDelayMs = 0 } = {}) {
  const seen = { http: [], ws: [], wsHeaders: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.http.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url.startsWith('/backend-api/codex/models')) {
        let out = Buffer.from(modelsRaw ?? JSON.stringify({ models }));
        const h = { 'content-type': 'application/json', etag: '"up-etag"', 'x-upstream': 'yes' };
        if (modelsEncoding === 'gzip') out = zlib.gzipSync(out);
        if (modelsEncoding === 'zstd') out = zlib.zstdCompressSync(out);
        if (modelsEncoding === 'br') out = zlib.brotliCompressSync(out);
        if (modelsEncoding) h['content-encoding'] = modelsEncoding;
        res.writeHead(200, h);
        return res.end(out);
      }
      if (req.url.startsWith('/backend-api/codex/responses') && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_up', output: [], echoBytes: body.length } })}\n\n`);
        return res.end();
      }
      res.writeHead(207, { 'content-type': 'application/octet-stream', 'x-echo-method': req.method });
      res.end(body);
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    seen.wsHeaders.push(req.headers);
    if (wsReject) {
      const body = wsRejectEncoding === 'gzip' ? zlib.gzipSync('{"error":"no"}\n') : Buffer.from('{"error":"no"}\n');
      const enc = wsRejectEncoding ? `content-encoding: ${wsRejectEncoding}\r\n` : '';
      socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 ${wsReject} Nope\r\ncontent-type: application/json\r\n${enc}content-length: ${body.length}\r\nx-reason: test\r\n\r\n`, 'latin1'), body]));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data, isBinary) => {
        const text = data.toString('utf8');
        seen.ws.push(text);
        if (isBinary) return ws.send(data, { binary: true });
        let msg = null;
        try {
          msg = JSON.parse(text);
        } catch {
          return ws.send(`echo:${text}`);
        }
        if (msg.type === 'response.create') {
          const id = `resp_up_${seen.ws.length}`;
          ws.send(JSON.stringify({ type: 'response.created', response: { id, status: 'in_progress' } }));
          ws.send(JSON.stringify({ type: 'codex.rate_limits', plan: 'pro', weird: { nested: [1, 2, 3] } }));
          const complete = () => ws.send(JSON.stringify({ type: 'response.completed', response: { id, status: 'completed', model: msg.model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `upstream:${msg.model}` }] }] } }));
          if (wsCompleteDelayMs) setTimeout(complete, wsCompleteDelayMs);
          else complete();
        }
      });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/backend-api/codex`,
    seen,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

/** Start the real proxy (router + backends) against a fake upstream and a fake Claude CLI. */
export const TEST_ACCOUNT = 'acct-test-0000';
export const TEST_TOKEN = 'chatgpt-token-for-tests-0123456789';
export const CODEX_HEADERS = { authorization: `Bearer ${TEST_TOKEN}`, 'chatgpt-account-id': TEST_ACCOUNT };

/** A Codex home whose auth.json holds the test sign-in (what the owner check compares with). */
export function testCodexHome(auth = { auth_mode: 'chatgpt', tokens: { access_token: TEST_TOKEN, account_id: TEST_ACCOUNT, id_token: 'id-token-not-sent' } }) {
  const dir = mkdtempSync(join(tmpdir(), 'lcp-codex-'));
  if (auth) writeFileSync(join(dir, 'auth.json'), JSON.stringify(auth), { mode: 0o600 });
  return dir;
}

export async function withProxy({ scenario = { turns: [] }, fakeEnv = {}, settings = {}, upstreamOptions = {}, ollamaFetch, upstreamUrl = null, availability = false, rawSettings = null, auth = undefined, routerOptions = {}, isOwner = null } = {}, fn) {
  const fake = makeFake(scenario, fakeEnv);
  const cfgDir = mkdtempSync(join(tmpdir(), 'lcp-cfg-'));
  const s = {
    claude: { bin: fake.bin, accounts: [{ id: '1', label: '', configDir: null }, { id: '2', label: 'サブ', configDir: join(cfgDir, 'acct2') }] },
    ollama: { enabled: true, baseUrl: 'http://127.0.0.1:9', models: [{ id: 'qwen-test:1b', name: 'Qwen Test', contextWindow: 8192, numCtx: null }] },
    ...settings,
  };
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'settings.json'), rawSettings ?? JSON.stringify(s));
  const up = upstreamUrl ? null : await fakeUpstream(upstreamOptions);
  const logLines = [];
  const logger = { event: (name, fields) => logLines.push({ ev: name, ...fields }) };
  const env = { ...process.env, LCP_CONFIG_DIR: cfgDir, LCP_LOG_DIR: join(cfgDir, 'logs') };
  const codexHome = testCodexHome(auth);
  const owner = isOwner ?? createOwnerCheck({ codexHome, retryDelaysMs: [] });
  const proxy = await startProxy({ env, port: 0, logger, upstream: upstreamUrl ?? up.url, claudeOptions: { limits: { killGraceMs: 300, ...(settings.limits ?? {}) } }, ollamaFetch, availability, isOwner: owner, routerOptions });
  try {
    return await fn({ proxy, port: proxy.port, up, fake, logLines, cfgDir, codexHome });
  } finally {
    await proxy.close();
    await up?.close();
    fake.cleanup();
    rmSync(cfgDir, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
}

export function parseSse(raw) {
  const events = [];
  for (const block of raw.split('\n\n')) {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6))
      .join('\n');
    if (data) events.push(JSON.parse(data));
  }
  return events;
}

/** A WebSocket client like Codex's: collects events per response. */
export async function wsClient(port, headers = {}, path = '/responses') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { ...CODEX_HEADERS, 'thread-id': 'thread-1', ...headers } });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (_r, res) => reject(Object.assign(new Error(`status ${res.statusCode}`), { status: res.statusCode, headers: res.headers })));
  });
  const frames = [];
  let waiter = null;
  ws.on('message', (data, isBinary) => {
    frames.push({ data, isBinary });
    waiter?.();
  });
  /** Send one response.create and wait for its terminal event. */
  async function create(body) {
    const start = frames.length;
    ws.send(JSON.stringify({ type: 'response.create', ...body }));
    const deadline = Date.now() + 15_000;
    for (;;) {
      const events = frames.slice(start).filter((f) => !f.isBinary).map((f) => JSON.parse(f.data.toString('utf8')));
      const done = events.find((e) => e.type === 'response.completed' || e.type === 'response.failed' || e.type === 'error');
      if (done) return { events, done, raw: frames.slice(start).map((f) => f.data.toString('utf8')) };
      if (Date.now() > deadline) throw new Error('timeout waiting for response');
      await new Promise((r) => {
        waiter = r;
        setTimeout(r, 50);
      });
    }
  }
  return { ws, frames, create, close: () => ws.close() };
}

export const TOOLS = [
  { type: 'function', name: 'exec_command', description: 'Runs a command.', strict: false, parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'], additionalProperties: false } },
  { type: 'custom', name: 'apply_patch', description: 'Apply a patch.', format: { type: 'grammar', syntax: 'lark', definition: 'start: "*** Begin Patch" /(.|\\n)*/ "*** End Patch"' } },
  { type: 'namespace', name: 'mcp__app', description: 'An app.', tools: [{ type: 'function', name: 'search', description: 'Search.', parameters: { type: 'object', properties: { q: { type: 'string' } } } }] },
  { type: 'web_search', external_web_access: false },
  { type: 'some_future_kind', name: 'x' },
];

export function userMsg(text) {
  return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] };
}

export function until(pred, ms = 3000) {
  return (async () => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await pred()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  })();
}
