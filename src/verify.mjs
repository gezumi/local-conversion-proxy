// Checks that run without spending any model usage:
//  - proxyHealth: the proxy answers on loopback;
//  - codexProbe: a real `codex app-server` (the same engine as the desktop
//    app) reports the ChatGPT account and lists both GPT and local models;
//  - upstreamThrough: the upstream GPT model list, fetched now through the
//    proxy with this Mac's Codex sign-in (Codex itself may answer from its
//    model cache, or from bundled models after a failed refresh).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { readCodexCredentials } from './owner.mjs';

export const APP_CODEX_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';

export function codexBin() {
  return existsSync(APP_CODEX_BIN) ? APP_CODEX_BIN : 'codex';
}

export async function proxyHealth(port, timeoutMs = 3000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, status: res.status };
    const body = await res.json();
    // the identity check has the last word: a body of another service cannot claim ok
    return { ...(body && typeof body === 'object' ? body : {}), ok: body?.ok === true && body?.service === 'local-conversion-proxy' };
  } catch (err) {
    return { ok: false, error: err?.cause?.code ?? err?.name ?? 'error' };
  }
}

/**
 * Ask `codex app-server` for the account and the model list.
 * overrides: extra `-c key=value` strings (e.g. an openai_base_url to test before enabling).
 */
export function codexProbe({ overrides = [], timeoutMs = 60_000, bin = codexBin() } = {}) {
  return new Promise((resolve) => {
    const args = [];
    for (const o of overrides) args.push('-c', o);
    const child = spawn(bin, [...args, 'app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', () => {});
    const rl = createInterface({ input: child.stdout });
    const result = { ok: false, account: null, plan: null, models: [], error: null };
    let settled = false;
    // Exactly one verdict, whatever happens first (a reply, an exit, a broken pipe, the time limit).
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      result.error = error;
      result.ok = !error && result.account === 'chatgpt';
      try {
        child.kill();
      } catch {
        // already gone
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    const send = (m) => {
      if (!settled && child.stdin.writable) child.stdin.write(`${JSON.stringify(m)}\n`);
    };
    child.stdin.on('error', () => finish('app_server_closed'));
    // after its output is read to the end: a reply written just before exiting still counts
    child.on('close', () => finish('app_server_exited'));
    child.on('error', (e) => finish(e.code ?? 'spawn_failed'));
    rl.on('line', (line) => {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.id === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/read', params: { refreshToken: false } });
      } else if (m.id === 2) {
        if (m.error) return finish('account_read_failed');
        result.account = m.result?.account?.type ?? null;
        result.plan = m.result?.account?.planType ?? null;
        send({ id: 3, method: 'model/list', params: { includeHidden: false, limit: 200, cursor: null } });
      } else if (m.id === 3) {
        if (m.error) return finish('model_list_failed');
        result.models = (m.result?.data ?? []).map((x) => ({ slug: x.model ?? x.id, name: x.displayName }));
        finish(null);
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'lcp-verify', title: 'lcp', version: '1' } } });
  });
}

/** The version Codex sends as client_version (from the app's own codex), or null. */
export function codexClientVersion(bin = codexBin()) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  return /(\d+\.\d+\.\d+\S*)/.exec(String(r.stdout ?? ''))?.[1] ?? null;
}

/** { ok, status, error }: the upstream list reached through the proxy, with GPT models in it. */
export async function upstreamThrough(port, { codexHome, clientVersion = codexClientVersion(), timeoutMs = 20_000 } = {}) {
  const creds = readCodexCredentials(codexHome);
  if (!creds) return { ok: false, status: null, error: 'no_codex_credentials' };
  const query = clientVersion ? `?client_version=${encodeURIComponent(clientVersion)}` : '';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/models${query}`, { headers: { authorization: `Bearer ${creds.token}`, ...(creds.account ? { 'chatgpt-account-id': creds.account } : {}) }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) return { ok: false, status: res.status, error: `upstream_http_${res.status}` };
    const body = await res.json();
    const gpt = Array.isArray(body?.models) && body.models.some((m) => typeof m?.slug === 'string' && /^gpt-/.test(m.slug));
    return { ok: gpt, status: 200, error: gpt ? null : 'upstream_no_gpt_models' };
  } catch (err) {
    return { ok: false, status: null, error: err?.name === 'TimeoutError' ? 'upstream_timeout' : 'upstream_unreachable' };
  }
}
