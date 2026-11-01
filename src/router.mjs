// Loopback router in front of the ChatGPT Codex backend.
//
// Codex keeps its built-in `openai` provider (ChatGPT sign-in, features and
// the GPT models are unchanged); only its base URL points here. Every request
// is passed through to the upstream untouched, except:
//   - GET /models: the upstream list plus the local models this Mac can run;
//   - a Responses request (HTTP POST or a WebSocket `response.create`) whose
//     model is one of this proxy's configured models: served locally, and
//     only for this Mac's own Codex sign-in (see owner.mjs). A model of the
//     proxy's own (claude-… / local-…) that is disabled, unavailable or no
//     longer configured is refused here: such a conversation never goes to
//     OpenAI. A slug that OpenAI's own model list has always goes upstream;
//   - our own compaction items on their way to OpenAI become plain text.
// Other models, unknown paths and every other frame go upstream, so GPT
// behaves exactly as it does without the proxy. No request handler may take
// the process down: every path is guarded.

import { writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { WebSocket, WebSocketServer } from 'ws';
import { LOCAL_SLUG, injectModels } from './catalog.mjs';
import { rewriteForUpstream } from './compaction.mjs';
import { createOwnerCheck } from './owner.mjs';
import { ResponseStream, SseSink, WsSink } from './responses.mjs';

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate']);
// The subprotocol header is rebuilt by the WebSocket client from the offered list (see openUpstream).
const WS_REQ_SKIP = new Set([...HOP, 'host', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol', 'content-length']);
const WS_RES_SKIP = new Set([...HOP, 'sec-websocket-accept', 'sec-websocket-extensions', 'sec-websocket-protocol', 'content-length', 'date']);
const MAX_BODY = 256 * 1024 * 1024;
const MAX_WS_PAYLOAD = 512 * 1024 * 1024;
const RETRYABLE = new Set(['ECONNRESET', 'EPIPE']);
/**
 * The model list always exists upstream: a 404 there means a wrong upstream (a
 * 404 elsewhere can be a real answer, e.g. a model that does not exist).
 */
const CATALOG_PATH = /^\/models$/;
/** Failures in a row (no answer at all, or a core-path 404) after which OpenAI counts as unreachable from here. */
const UPSTREAM_FAILURES_DOWN = 3;
/** Upstream connection set-up, and the wait for response headers (streams after that have no time limit). */
const UPSTREAM_CONNECT_MS = 30_000;
const UPSTREAM_HEADERS_MS = 5 * 60 * 1000;

function decodeBody(buf, encoding, max = MAX_BODY) {
  const enc = String(encoding ?? '').trim().toLowerCase();
  const opts = { maxOutputLength: max };
  if (!enc || enc === 'identity') return buf;
  if (enc === 'gzip') return zlib.gunzipSync(buf, opts);
  if (enc === 'deflate') return zlib.inflateSync(buf, opts);
  if (enc === 'br') return zlib.brotliDecompressSync(buf, opts);
  if (enc === 'zstd') return zlib.zstdDecompressSync(buf, opts);
  throw new Error('unsupported content-encoding');
}

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.once('end', () => resolve(Buffer.concat(chunks, size)));
    req.once('error', reject);
    req.once('aborted', () => reject(new Error('aborted')));
  });
}

/**
 * The JSON object of a request body: { body } (null if it is not one), or
 * { tooLarge } when it does not fit the decoded-size limit — then nobody can
 * tell whose request it is, and it must not go to OpenAI by default.
 */
function readJsonBody(raw, encoding, max = MAX_BODY) {
  let text;
  try {
    text = decodeBody(raw, encoding, max).toString('utf8');
  } catch (err) {
    return { body: null, tooLarge: err?.code === 'ERR_BUFFER_TOO_LARGE' };
  }
  try {
    const v = JSON.parse(text);
    return { body: v && typeof v === 'object' && !Array.isArray(v) ? v : null, tooLarge: false };
  } catch {
    return { body: null, tooLarge: false };
  }
}

const TOO_LARGE = { error: { type: 'invalid_request_error', code: 'request_too_large', message: '会話が大きすぎて扱えません（展開後 256MB 超）。新しいスレッドで続けてください。' } };

function filterHeaders(headers, skip) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!skip.has(k.toLowerCase())) out[k] = v;
  return out;
}

/** Path below the base URL (fragment dropped); tolerate a base URL configured with a trailing /v1. */
function subPath(url) {
  let u = String(url || '/').split('#')[0];
  if (!u.startsWith('/')) u = `/${u}`;
  return u.startsWith('/v1/') || u === '/v1' || u.startsWith('/v1?') ? u.slice(3) || '/' : u;
}

function pathOnly(u) {
  return u.split('?')[0].replace(/\/+$/, '') || '/';
}

function sendJson(res, status, body) {
  if (res.headersSent || res.destroyed) return void res.end?.();
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

let dumpSeq = 0;
/** Local debugging only (LCP_DUMP_DIR): write a local-model request body to disk. */
function dumpRequest(body, raw = null) {
  try {
    writeFileSync(`${process.env.LCP_DUMP_DIR}/${raw ? 'models' : 'req'}-${Date.now()}-${++dumpSeq}.json`, raw ?? JSON.stringify(body), { mode: 0o600 });
  } catch {
    // debugging aid only
  }
}

function wsCloseCode(code) {
  if (code === 1005 || !Number.isInteger(code)) return 1000;
  if (code === 1006 || code === 1015 || code < 1000 || code >= 5000) return 1011;
  return code;
}

const UPSTREAM = Object.freeze({ kind: 'upstream' });
const FORBIDDEN = { code: 'forbidden', message: 'この Mac の Codex（同じ ChatGPT ログイン）以外からはローカルモデルを使えません。' };
const REFUSALS = {
  model_disabled: 'このモデル（Claude アカウントまたはローカルモデル）は無効になっているか、いまこの Mac で使えません。lcp status で確認するか、別のモデルを選んでください。',
  model_not_configured: 'このモデルはローカル変換プロキシの設定にありません（アカウントやモデルが外された可能性があります）。別のモデルを選んでください。',
};

/**
 * opts: {
 *   upstream: 'https://chatgpt.com/backend-api/codex',
 *   getRoutes: () => every configured local entry (routing),
 *   getCatalog: () => the entries this Mac can run now (listing),
 *   backends: { claude?: { handle(body, sink, ctx) }, ollama?: {...} },
 *   logger, version, health: () => object,
 *   isOwner?: (headers) => Promise<boolean>   (who may use local models; default: owner.mjs)
 * }
 */
export function createRouter(opts) {
  const logger = opts.logger;
  const up = new URL(opts.upstream);
  const upPrefix = up.pathname.replace(/\/+$/, '');
  const upMod = up.protocol === 'https:' ? https : http;
  const agent = new upMod.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16, timeout: 60_000 });
  const wsBase = `${up.protocol === 'https:' ? 'wss:' : 'ws:'}//${up.host}${upPrefix}`;
  /** req -> the subprotocol the upstream chose (Codex gets the same one, or none). */
  const chosenProtocol = new WeakMap();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_WS_PAYLOAD, handleProtocols: (offered, req) => (chosenProtocol.get(req) && offered.has(chosenProtocol.get(req)) ? chosenProtocol.get(req) : false) });
  const extraHeaders = new WeakMap(); // req -> upstream handshake response headers to mirror
  const isOwner = opts.isOwner ?? createOwnerCheck();
  const maxBody = opts.maxBodyBytes ?? MAX_BODY;
  const connectMs = opts.upstreamConnectMs ?? UPSTREAM_CONNECT_MS;
  const headersMs = opts.upstreamHeadersMs ?? UPSTREAM_HEADERS_MS;

  /**
   * Whether OpenAI can be reached from this process, judged from real traffic,
   * in two kinds: `network` — failures in a row with no answer at all (or none
   * in time); `misrouted` — 404s in a row for the model list or the Responses
   * socket, which only a wrong upstream gives. Either past the threshold makes
   * /healthz say upstream_ok:false, and the watchdog then sends Codex to OpenAI
   * directly. Any answer clears `network` (an unauthenticated request checks
   * every 30 s while it is down); only a real model list or socket clears
   * `misrouted` (the next install or verified restore).
   */
  const upstreamHealth = { network: 0, misrouted: 0, lastOkAt: null, lastError: null };
  let reprobe = null;
  const upstreamOk = () => upstreamHealth.network < UPSTREAM_FAILURES_DOWN && upstreamHealth.misrouted < UPSTREAM_FAILURES_DOWN;
  /** kind: 'answer' (any HTTP answer), 'catalog' (a real model list or socket), 'misrouted', 'network'. */
  function noteUpstream(kind, code = null) {
    if (kind === 'answer' || kind === 'catalog') {
      upstreamHealth.network = 0;
      upstreamHealth.lastOkAt = Date.now();
      if (kind === 'catalog') upstreamHealth.misrouted = 0;
      clearInterval(reprobe);
      reprobe = null;
      return;
    }
    upstreamHealth.lastError = String(code ?? kind).slice(0, 40);
    if (kind === 'misrouted') {
      upstreamHealth.network = 0;
      upstreamHealth.misrouted += 1;
    } else {
      upstreamHealth.network += 1;
    }
    if (!upstreamOk()) logger.event('upstream_unreachable', { kind, code: upstreamHealth.lastError });
    if (upstreamHealth.network >= UPSTREAM_FAILURES_DOWN && !reprobe) {
      reprobe = setInterval(probeUpstream, opts.upstreamProbeMs ?? 30_000);
      reprobe.unref?.();
    }
  }
  function probeUpstream() {
    try {
      const r = upMod.request({ protocol: up.protocol, host: up.hostname, port: up.port || undefined, method: 'GET', path: `${upPrefix}/models`, headers: { host: up.host }, agent, timeout: 10_000 }, (res) => {
        res.resume();
        logger.event('upstream_reachable_again', { status: res.statusCode });
        noteUpstream('answer');
      });
      r.on('timeout', () => r.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      r.on('error', (err) => {
        upstreamHealth.lastError = String(err?.code ?? 'error').slice(0, 40);
      });
      r.end();
    } catch {
      // the next interval tries again
    }
  }
  /** Slugs OpenAI's own model list has (learned from /models): those always go upstream. */
  let upstreamSlugs = new Set();
  let allowedHosts = new Set();
  let connSeq = 0;
  const conns = new Set();
  /** Responses still streaming: upstream (per WebSocket, by response.create sent vs. terminal events seen) and local. */
  const inflight = { http: 0 };
  const inflightTotal = () => inflight.http + [...conns].reduce((n, c) => n + c.upstreamPending + c.local, 0);
  const startedAt = Date.now();

  wss.on('headers', (headers, req) => {
    const extra = extraHeaders.get(req);
    if (!extra) return;
    for (const [k, v] of Object.entries(extra)) {
      for (const one of Array.isArray(v) ? v : [v]) headers.push(`${k}: ${one}`);
    }
  });

  /** A list provider that can never throw: GPT must not depend on local settings being sane. */
  function safeList(fn, label) {
    try {
      const v = fn();
      return Array.isArray(v) ? v : [];
    } catch {
      logger.event('catalog_error', { which: label });
      return [];
    }
  }
  const routes = () => safeList(opts.getRoutes ?? opts.getCatalog, 'routes');
  const catalog = () => safeList(opts.getCatalog, 'catalog');

  /**
   * Where a request for `model` goes: upstream, { kind: 'local', entry }, or
   * { kind: 'refuse', code } for a model of ours that cannot be served now.
   */
  function routeFor(model) {
    if (typeof model !== 'string' || !model || upstreamSlugs.has(model)) return UPSTREAM;
    const entry = routes().find((e) => e.slug === model);
    if (entry && !entry.disabled) return { kind: 'local', entry };
    if (entry) return { kind: 'refuse', code: 'model_disabled' };
    return LOCAL_SLUG.test(model) ? { kind: 'refuse', code: 'model_not_configured' } : UPSTREAM;
  }

  function rememberUpstreamModels(body) {
    if (Array.isArray(body?.models)) upstreamSlugs = new Set(body.models.map((m) => m?.slug).filter((x) => typeof x === 'string'));
  }

  /** A refused local request: one failed response with a readable message (nothing goes upstream). */
  function refuse(sink, model, { code, message = REFUSALS[code] }) {
    logger.event('local_refused', { code });
    const stream = new ResponseStream(sink, { model: typeof model === 'string' ? model.slice(0, 100) : '' });
    stream.created();
    stream.failed({ code, message });
    stream.end();
  }

  function hostOk(req) {
    return allowedHosts.has(String(req.headers.host ?? '').toLowerCase()) && req.headers.origin === undefined;
  }

  /** Count a response as in flight until it is finished or its connection closed. */
  function track(res) {
    inflight.http += 1;
    let counted = true;
    const done = () => {
      if (counted) {
        counted = false;
        inflight.http -= 1;
      }
    };
    res.once('close', done);
    res.once('finish', done);
  }

  // ---- HTTP -----------------------------------------------------------------

  /** Pass a request (body already buffered) upstream; retry once if a reused keep-alive socket was dead. */
  function forwardHttp(req, res, body, { rewrite = null } = {}) {
    track(res);
    const headers = filterHeaders(req.headers, HOP);
    headers.host = up.host;
    if (body && body.length) headers['content-length'] = String(body.length);
    else if (req.method !== 'GET' && req.method !== 'HEAD') headers['content-length'] = '0';

    const attempt = (retried) => {
      /** Codex closed its side before the upstream answer was passed on. */
      let clientGone = false;
      const catalogPath = CATALOG_PATH.test(pathOnly(subPath(req.url)));
      const upReq = upMod.request({ protocol: up.protocol, host: up.hostname, port: up.port || undefined, method: req.method, path: upPrefix + subPath(req.url), headers, agent }, (upRes) => {
        clearTimeout(headersTimer);
        if (catalogPath && upRes.statusCode === 404) noteUpstream('misrouted', 'http_404');
        else noteUpstream(catalogPath && upRes.statusCode === 200 ? 'catalog' : 'answer');
        if (rewrite && upRes.statusCode === 200) {
          const chunks = [];
          upRes.on('data', (c) => chunks.push(c));
          upRes.on('end', () => {
            const rawBody = Buffer.concat(chunks);
            const enc = upRes.headers['content-encoding'];
            let out = null;
            try {
              out = Buffer.from(JSON.stringify(rewrite(JSON.parse(decodeBody(rawBody, enc).toString('utf8')))));
            } catch {
              out = null;
            }
            if (out) {
              if (process.env.LCP_DUMP_DIR) dumpRequest({ models_response: true }, out);
              logger.event('models_injected', { encoding: enc ? String(enc).slice(0, 20) : 'identity' });
              const h = filterHeaders(upRes.headers, new Set([...HOP, 'content-length', 'content-encoding']));
              res.writeHead(200, { ...h, 'content-length': out.length });
              res.end(out);
            } else {
              // Not the JSON we expected: the original response, byte for byte, with its own headers.
              logger.event('models_rewrite_skipped', { encoding: enc ? String(enc).slice(0, 20) : 'identity' });
              res.writeHead(200, upRes.statusMessage, { ...filterHeaders(upRes.headers, new Set([...HOP, 'content-length'])), 'content-length': rawBody.length });
              res.end(rawBody);
            }
          });
          upRes.on('error', () => res.destroy());
          return;
        }
        res.writeHead(upRes.statusCode, upRes.statusMessage, filterHeaders(upRes.headers, HOP));
        upRes.pipe(res);
        upRes.on('error', () => res.destroy());
      });
      // No answer in time counts as no answer (a stalled upstream must not hold Codex here forever).
      const timedOut = () => upReq.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' }));
      const headersTimer = setTimeout(timedOut, headersMs);
      upReq.once('close', () => clearTimeout(headersTimer));
      upReq.once('socket', (sock) => {
        if (!sock.connecting) return;
        const connectTimer = setTimeout(timedOut, connectMs);
        sock.once(up.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer));
        upReq.once('close', () => clearTimeout(connectTimer));
      });
      upReq.on('error', (err) => {
        // Codex left first (Esc, a closed window) and we cut the upstream request: that says nothing about OpenAI.
        if (clientGone) return logger.event('upstream_http_cancelled');
        if (!retried && upReq.reusedSocket && RETRYABLE.has(err.code) && !res.headersSent && !res.destroyed) {
          logger.event('upstream_http_retry', { code: err.code });
          return attempt(true);
        }
        logger.event('upstream_http_error', { code: err.code ?? 'error' });
        noteUpstream('network', err.code);
        if (!res.headersSent) sendJson(res, 502, { error: { type: 'proxy_error', code: 'upstream_unreachable', message: 'ローカル変換プロキシから OpenAI に接続できませんでした。' } });
        else res.destroy();
      });
      res.once('close', () => {
        if (res.writableFinished) return;
        clientGone = true;
        upReq.destroy();
      });
      upReq.end(body && body.length ? body : undefined);
    };
    attempt(false);
  }

  async function serveLocalHttp(req, res, route, body) {
    track(res);
    const sink = new SseSink(res);
    if (route.kind === 'refuse') return refuse(sink, body?.model, route);
    // Codex leaving at any point (also during the owner check) stops the work.
    const ac = new AbortController();
    const off = sink.onClose(() => ac.abort());
    try {
      if (!(await isOwner(req.headers))) return refuse(sink, body?.model, FORBIDDEN);
      if (sink.closed) return;
      const { entry } = route;
      logger.event('local_request', { transport: 'http', backend: entry.backend });
      await opts.backends[entry.backend].handle(body, sink, { entry, key: threadKey(req.headers, body), transport: 'http', signal: ac.signal });
    } finally {
      off();
    }
  }

  /** To OpenAI: our compaction summaries as plain text; everything else byte for byte. */
  function forwardResponsesBody(req, res, raw, body, transport) {
    const rewritten = body ? rewriteForUpstream(body) : null;
    if (!rewritten) return forwardHttp(req, res, raw);
    delete req.headers['content-encoding'];
    logger.event('upstream_rewrite_compaction', { transport });
    return forwardHttp(req, res, Buffer.from(JSON.stringify(rewritten)));
  }

  async function handleResponsesPost(req, res) {
    const raw = await readBody(req, maxBody);
    const { body, tooLarge } = readJsonBody(raw, req.headers['content-encoding'], maxBody);
    if (tooLarge) return sendJson(res, 413, TOO_LARGE);
    const route = routeFor(body?.model);
    if (route.kind !== 'upstream') return serveLocalHttp(req, res, route, body);
    return forwardResponsesBody(req, res, raw, body, 'http');
  }

  async function handleCompactPost(req, res) {
    const raw = await readBody(req, maxBody);
    const { body, tooLarge } = readJsonBody(raw, req.headers['content-encoding'], maxBody);
    if (tooLarge) return sendJson(res, 413, TOO_LARGE);
    const route = routeFor(body?.model);
    if (route.kind === 'upstream') return forwardResponsesBody(req, res, raw, body, 'compact');
    if (route.kind === 'refuse') return sendJson(res, 400, { error: { type: 'invalid_request_error', code: route.code, message: REFUSALS[route.code] } });
    return sendJson(res, 400, { error: { type: 'invalid_request_error', code: 'compact_unsupported', message: 'このモデルではこの方式の圧縮に対応していません。' } });
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostOk(req)) return sendJson(res, 403, { error: { message: 'forbidden' } });
      const path = pathOnly(subPath(req.url));
      if (path === '/healthz' || path === '/lcp/health') {
        let extra = {};
        try {
          extra = opts.health?.() ?? {};
        } catch {
          extra = {};
        }
        return sendJson(res, 200, {
          ok: true,
          service: 'local-conversion-proxy',
          version: opts.version,
          pid: process.pid,
          uptime_s: Math.round((Date.now() - startedAt) / 1000),
          connections: conns.size,
          inflight: inflightTotal(),
          local_models: catalog().length,
          // false: OpenAI cannot be reached from here (the watchdog then sends Codex there directly)
          upstream_ok: upstreamOk(),
          upstream: { network_failures: upstreamHealth.network, misrouted: upstreamHealth.misrouted, last_ok_s_ago: upstreamHealth.lastOkAt ? Math.round((Date.now() - upstreamHealth.lastOkAt) / 1000) : null, last_error: upstreamHealth.lastError },
          ...extra,
        });
      }
      if (path === '/lcp/models' && req.method === 'GET') {
        return sendJson(res, 200, { models: catalog().map((e) => ({ slug: e.slug, name: e.info?.display_name ?? e.slug, backend: e.backend })) });
      }
      if (path === '/models' && req.method === 'GET') {
        logger.event('models_list');
        return forwardHttp(req, res, null, {
          rewrite: (j) => {
            rememberUpstreamModels(j);
            return injectModels(j, catalog());
          },
        });
      }
      if (path === '/responses' && req.method === 'POST') return await handleResponsesPost(req, res);
      if (path === '/responses/compact' && req.method === 'POST') return await handleCompactPost(req, res);
      const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req, maxBody);
      return forwardHttp(req, res, body);
    } catch (err) {
      logger.event('http_error', { status: err?.status ?? 500 });
      if (!res.headersSent) sendJson(res, err?.status ?? 500, { error: { type: 'proxy_error', message: 'ローカル変換プロキシ内部のエラーです。' } });
      else res.destroy();
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  server.on('clientError', (_err, socket) => socket.destroy());

  // ---- WebSocket ------------------------------------------------------------

  function threadKey(headers, body) {
    const pick = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null);
    return pick(body?.prompt_cache_key) ?? pick(headers['thread-id']) ?? pick(headers['session-id']) ?? null;
  }

  function rejectUpgrade(socket, status, reason) {
    try {
      socket.end(`HTTP/1.1 ${status} ${reason}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
    } catch {
      socket.destroy();
    }
  }

  function mirrorRejection(socket, upRes) {
    const chunks = [];
    let size = 0;
    upRes.on('data', (c) => {
      size += c.length;
      if (size <= 1024 * 1024) chunks.push(c);
    });
    upRes.on('end', () => {
      // The body goes byte for byte with its own encoding; one too large to keep goes empty.
      const whole = size <= 1024 * 1024;
      const body = whole ? Buffer.concat(chunks) : Buffer.alloc(0);
      let head = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage ?? ''}\r\n`;
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (HOP.has(k) || k === 'content-length' || (k === 'content-encoding' && !whole)) continue;
        for (const one of Array.isArray(v) ? v : [v]) head += `${k}: ${one}\r\n`;
      }
      head += `content-length: ${body.length}\r\nconnection: close\r\n\r\n`;
      socket.end(Buffer.concat([Buffer.from(head, 'latin1'), body]));
    });
    upRes.on('error', () => socket.destroy());
  }

  function openUpstream(path, headers, protocols = []) {
    return new WebSocket(`${wsBase}${path}`, protocols.length ? protocols : undefined, { headers, perMessageDeflate: true, maxPayload: MAX_WS_PAYLOAD, handshakeTimeout: 30_000 });
  }

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    try {
      if (!hostOk(req)) return rejectUpgrade(socket, 403, 'Forbidden');
      const path = subPath(req.url);
      // Only /responses carries Responses traffic we may serve locally; any other socket is a pure relay.
      const routeLocal = pathOnly(path) === '/responses';
      const upHeaders = filterHeaders(req.headers, WS_REQ_SKIP);
      const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      let upstream;
      try {
        upstream = openUpstream(path, upHeaders, protocols);
      } catch {
        return rejectUpgrade(socket, 400, 'Bad Request');
      }
      let decided = false;
      let upgradeHeaders = null;
      // Codex gave up before we answered: do not leave the upstream socket open.
      socket.once('close', () => {
        if (!decided) {
          decided = true;
          upstream.terminate();
        }
      });
      upstream.once('upgrade', (res) => {
        upgradeHeaders = res.headers;
      });
      upstream.once('open', () => {
        noteUpstream('catalog');
        if (decided) return;
        decided = true;
        if (upgradeHeaders) extraHeaders.set(req, filterHeaders(upgradeHeaders, WS_RES_SKIP));
        if (upstream.protocol) chosenProtocol.set(req, upstream.protocol);
        wss.handleUpgrade(req, socket, head, (client) => wire(client, upstream, { req, path, upHeaders, routeLocal, protocols }));
      });
      upstream.once('unexpected-response', (_r, upRes) => {
        noteUpstream(upRes.statusCode === 404 ? 'misrouted' : 'answer', 'ws_404');
        if (decided) return upRes.resume();
        decided = true;
        logger.event('ws_upstream_rejected', { status: upRes.statusCode });
        mirrorRejection(socket, upRes);
      });
      upstream.on('error', (err) => {
        logger.event('ws_upstream_error', { code: err?.code ?? 'error', decided });
        // Before the handshake: answer like an unreachable server, so Codex can fall back to HTTP
        // (where local models are served too).
        if (!decided) {
          noteUpstream('network', err?.code);
          decided = true;
          rejectUpgrade(socket, 502, 'Bad Gateway');
        }
      });
    } catch {
      logger.event('ws_upgrade_error');
      rejectUpgrade(socket, 400, 'Bad Request');
    }
  });

  function wire(client, upstream, { req, path, upHeaders, routeLocal, protocols }) {
    const conn = { id: ++connSeq, upstream: null, local: 0, upstreamPending: 0, pendingClose: null, closed: false, queue: [], localResponses: new Map(), localAborts: new Set(), owner: null };
    conns.add(conn);
    // Checked with the credentials this socket was opened with (a token refreshed later is still the owner's).
    if (routeLocal) conn.owner = isOwner(req.headers);
    const key = threadKey(req.headers, null);
    logger.event('ws_open', { conn: conn.id, local: routeLocal });

    const attachUpstream = (ws) => {
      conn.upstream = ws;
      let opened = ws.readyState === WebSocket.OPEN;
      ws.once('open', () => {
        opened = true;
        noteUpstream('catalog');
      });
      ws.on('message', (data, isBinary) => {
        if (conn.upstream !== ws) return;
        // A terminal event ends one upstream response (cheap prefix check; the frame itself is untouched).
        if (!isBinary && conn.upstreamPending > 0) {
          const headText = data.subarray(0, 80).toString('latin1');
          if (headText.includes('"response.completed"') || headText.includes('"response.failed"') || headText.includes('"response.incomplete"') || headText.includes('"type":"error"')) conn.upstreamPending -= 1;
        }
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      ws.on('close', (code, reason) => {
        if (conn.upstream !== ws) return; // an older, superseded upstream finishing its close
        conn.upstream = null;
        conn.upstreamPending = 0;
        if (conn.closed) return;
        logger.event('ws_upstream_close', { conn: conn.id, code });
        const close = { code: wsCloseCode(code), reason: reason?.toString('utf8').slice(0, 120) ?? '' };
        if (conn.local > 0) conn.pendingClose = close;
        else if (client.readyState === WebSocket.OPEN) client.close(close.code, close.reason);
      });
      ws.on('error', (err) => {
        logger.event('ws_upstream_error', { conn: conn.id, code: err?.code ?? 'error' });
        // closed by us because Codex left while it was still connecting: not an upstream failure
        if (!opened && !conn.closed) noteUpstream('network', err?.code);
      });
    };
    attachUpstream(upstream);

    const flush = () => {
      const ws = conn.upstream;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      for (const m of conn.queue.splice(0)) ws.send(m.data, { binary: m.isBinary });
    };

    const toUpstream = (data, isBinary) => {
      conn.queue.push({ data, isBinary });
      const ws = conn.upstream;
      if (ws && ws.readyState === WebSocket.OPEN) return flush();
      if (ws && ws.readyState === WebSocket.CONNECTING) return;
      // No upstream (closed): reconnect with the original handshake headers.
      logger.event('ws_upstream_reconnect', { conn: conn.id });
      let fresh;
      try {
        fresh = openUpstream(path, upHeaders, protocols);
      } catch {
        conn.queue.length = 0;
        if (client.readyState === WebSocket.OPEN) client.close(1011, 'upstream unavailable');
        return;
      }
      attachUpstream(fresh);
      fresh.once('open', flush);
      fresh.once('unexpected-response', (_r, upRes) => {
        logger.event('ws_upstream_rejected', { conn: conn.id, status: upRes.statusCode });
        noteUpstream(upRes.statusCode === 404 ? 'misrouted' : 'answer', 'ws_404');
        conn.queue.length = 0;
        upRes.resume();
        if (client.readyState === WebSocket.OPEN) client.close(1011, 'upstream rejected');
      });
    };

    client.on('message', (data, isBinary) => {
      try {
        if (routeLocal && !isBinary) {
          let msg = null;
          try {
            msg = JSON.parse(data.toString('utf8'));
          } catch {
            msg = null;
          }
          if (msg?.type === 'response.create') {
            const route = routeFor(msg.model);
            if (route.kind !== 'upstream') {
              if (process.env.LCP_DUMP_DIR) dumpRequest(msg);
              return void runLocal(route, msg);
            }
            conn.upstreamPending += 1;
            const rewritten = rewriteForUpstream(msg);
            if (rewritten) {
              logger.event('upstream_rewrite_compaction', { transport: 'ws' });
              return toUpstream(Buffer.from(JSON.stringify(rewritten)), false);
            }
          } else if (msg?.type === 'response.interrupt' && typeof msg.response_id === 'string' && conn.localResponses.has(msg.response_id)) {
            // Esc on a Claude/Qwen turn: stop it here; OpenAI never knew this response.
            logger.event('local_interrupt', { conn: conn.id });
            conn.localResponses.get(msg.response_id).abort();
            return;
          }
        }
        toUpstream(data, isBinary);
      } catch {
        logger.event('ws_message_error', { conn: conn.id });
      }
    });

    const runLocal = async (route, body) => {
      conn.local += 1;
      const sink = new WsSink(client);
      const ac = new AbortController();
      // Codex leaving at any point (also during the owner check) stops the work.
      conn.localAborts.add(ac);
      if (conn.closed) ac.abort();
      let responseId = null;
      const { entry } = route;
      try {
        if (route.kind === 'refuse') return refuse(sink, body?.model, route);
        conn.owner ??= isOwner(req.headers);
        if (!(await conn.owner) && !(await isOwner(req.headers))) return refuse(sink, body?.model, FORBIDDEN);
        if (ac.signal.aborted) return;
        logger.event('local_request', { transport: 'ws', backend: entry.backend, conn: conn.id });
        await opts.backends[entry.backend].handle(body, sink, {
          entry,
          key: threadKey(req.headers, body) ?? key,
          transport: 'ws',
          signal: ac.signal,
          onResponseId: (id) => {
            responseId = id;
            conn.localResponses.set(id, ac);
          },
        });
      } catch {
        logger.event('local_unhandled', { backend: entry?.backend ?? 'none' });
        // Codex acts on an `error` frame only when it carries a status; without one it would wait for its idle timeout.
        sink.send({ type: 'error', status: 500, error: { type: 'proxy_error', code: 'local_backend_failed', message: 'ローカル変換プロキシ内部のエラーです。' } });
      } finally {
        conn.localAborts.delete(ac);
        if (responseId) conn.localResponses.delete(responseId);
        conn.local -= 1;
        if (conn.local === 0 && conn.pendingClose && client.readyState === WebSocket.OPEN) client.close(conn.pendingClose.code, conn.pendingClose.reason);
      }
    };

    client.on('close', (code) => {
      conn.closed = true;
      conns.delete(conn);
      logger.event('ws_close', { conn: conn.id, code });
      for (const ac of conn.localAborts) ac.abort();
      const ws = conn.upstream;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try {
          ws.close(1000);
        } catch {
          ws.terminate();
        }
      }
    });
    client.on('error', () => {});
  }

  return {
    server,
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const p = server.address().port;
          allowedHosts = new Set([`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`]);
          resolve(p);
        });
      });
    },
    async close() {
      clearInterval(reprobe);
      for (const c of wss.clients) c.terminate();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
      agent.destroy();
    },
  };
}
