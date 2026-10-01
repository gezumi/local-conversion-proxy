// install / uninstall / on / off / status / restore-after-recovery.
//
// Safety order for install: wait until Codex is idle (an update restarts the
// proxy), copy the runtime, start the service and its watchdog, check a real
// Codex app-server THROUGH the proxy (account + model list, no model usage)
// with a one-off override, and only then add the line to config.toml — then
// check again without the override, rolling back on any failure. `on` and the
// watchdog's automatic restore verify the same way.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog } from './catalog.mjs';
import { LOCAL_MODEL, configTarget, disableText, enableText, failOpenText, readConfigState, topLevelModel, unswapText, updateConfig } from './codex-config.mjs';
import { PROXY_LABEL, WATCHDOG_LABEL, installAgent, isLoaded, notify, plistXml, removeAgent, restartAgent } from './launchd.mjs';
import { paths } from './paths.mjs';
import { loadSettings, saveSettings } from './settings.mjs';
import { readCodexCredentials } from './owner.mjs';
import { codexProbe, proxyHealth, upstreamThrough } from './verify.mjs';
import { SAFE_VALUE, readWatchdog, withStateLock, writeWatchdog } from './watchdog-state.mjs';

export { readWatchdog } from './watchdog-state.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIN_NODE = [22, 15];

function nodeVersionOk(bin) {
  try {
    const v = execFileSync(bin, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 10_000 }).trim();
    const [a, b] = v.split('.').map(Number);
    return a > MIN_NODE[0] || (a === MIN_NODE[0] && b >= MIN_NODE[1]);
  } catch {
    return false;
  }
}

/** A node that is new enough (zstd), preferring stable symlinks over versioned paths. */
export function stableNode() {
  for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node', process.execPath]) if (existsSync(p) && nodeVersionOk(p)) return p;
  return null;
}

/**
 * The service's environment: the same Codex home, settings and logs this
 * install used (also for the watchdog's node), and a PATH that has the chosen
 * node and the Claude launcher's own directory (an npm/nvm launcher runs
 * `env node`).
 */
export function serviceEnv(p, { node = null, claudeBin = null } = {}) {
  const own = [node, claudeBin].filter((x) => typeof x === 'string' && x.startsWith('/')).map((x) => dirname(x));
  return {
    HOME: p.home,
    PATH: [...new Set([...own, join(p.home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':'),
    LANG: process.env.LANG || 'en_US.UTF-8',
    CODEX_HOME: p.codexHome,
    LCP_CONFIG_DIR: p.configDir,
    LCP_LOG_DIR: p.logDir,
  };
}

function configPath(p) {
  return join(p.codexHome, 'config.toml');
}

/** The `claude` the user's own shell finds (npm/nvm/other installs are invisible to launchd's PATH). */
function claudeFromLoginShell() {
  const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
  const r = spawnSync(shell, ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 15_000 });
  const found = String(r.stdout ?? '').trim().split('\n').pop();
  return r.status === 0 && found && found.startsWith('/') && existsSync(found) ? found : null;
}

/** Remember the GPT default model, so the watchdog can fall back to it if the default is a local model. */
function recordFallback(p) {
  const st = readWatchdog(p);
  const t = configTarget(configPath(p));
  const model = existsSync(t) ? topLevelModel(readFileSync(t, 'utf8')) : null;
  if (model && !LOCAL_MODEL.test(model) && SAFE_VALUE.test(model)) st.fallback = model;
  writeWatchdog(p, st);
}

/**
 * Codex without the proxy (lcp off, uninstall, a failed enable): our line out
 * and a proxy-only default model set aside, as the watchdog does. The model
 * is remembered so that turning the proxy back on restores it. Call with the
 * state lock held.
 */
function disableWithSwap(p, extra = {}) {
  const st = readWatchdog(p);
  let swapped = '';
  const r = updateConfig(configPath(p), p.backupsDir, (t) => {
    const out = failOpenText(t, st.fallback);
    swapped = out.swapped;
    return out.text;
  });
  writeWatchdog(p, { ...readWatchdog(p), ...extra, swapped: swapped || st.swapped });
  return r.changed;
}

// ---- runtime ---------------------------------------------------------------------

/** Copy the runtime (src, bin, node_modules, package.json) to its stable location; swap atomically. */
export function copyRuntime(p) {
  mkdirSync(p.runtimeDir, { recursive: true, mode: 0o700 });
  const next = join(p.runtimeDir, `app.new-${process.pid}`);
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { mode: 0o700 });
  for (const part of ['src', 'bin', 'node_modules', 'package.json']) {
    cpSync(join(PROJECT_ROOT, part), join(next, part), { recursive: true, dereference: true });
  }
  const app = join(p.runtimeDir, 'app');
  const old = join(p.runtimeDir, `app.old-${Date.now()}`);
  if (existsSync(app)) renameSync(app, old);
  renameSync(next, app);
  rmSync(old, { recursive: true, force: true });
  return app;
}

/**
 * ~/.local/bin/lcp: a tiny wrapper that runs the installed command with the
 * node chosen at install (so it works where `node` is not on PATH). Only
 * written if the name is free or already ours.
 */
function linkCommand(p, app, node) {
  const binDir = join(p.home, '.local', 'bin');
  const link = join(binDir, 'lcp');
  const target = join(app, 'bin', 'lcp.mjs');
  mkdirSync(binDir, { recursive: true });
  let ours = true;
  try {
    const st = lstatSync(link);
    if (st.isSymbolicLink()) ours = readlinkSync(link).includes('local-conversion-proxy');
    else ours = readFileSync(link, 'utf8').includes('# local-conversion-proxy');
  } catch {
    ours = true; // nothing there
  }
  if (!ours) return false;
  rmSync(link, { force: true });
  writeFileSync(link, `#!/bin/sh\n# local-conversion-proxy\nexec ${shellQuote(node)} ${shellQuote(target)} "$@"\n`, { mode: 0o755 });
  chmodSync(link, 0o755);
  return true;
}

/** A value as one single-quoted shell word: nothing in it is expanded. */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** watchdog.sh with this Mac's paths filled in (as quoted shell literals). */
export function renderWatchdogScript(source, { node, app, port, configDir, codexConfig, label = PROXY_LABEL, notify: notifyOn = true }) {
  const values = { __NODE__: node, __APP__: app, __PORT__: String(port), __CONFIG_DIR__: configDir, __CODEX_CONFIG__: codexConfig, __LABEL__: label, __NOTIFY__: notifyOn ? '1' : '0' };
  return source.replace(/^([A-Z_]+)=(__[A-Z_]+__)$/gm, (all, name, key) => (key in values ? `${name}=${shellQuote(values[key])}` : all));
}

/** The watchdog is a shell script outside the runtime: it keeps working even if node or the runtime is gone. */
function writeWatchdogScript(p, node, app, port) {
  const script = renderWatchdogScript(readFileSync(join(app, 'src', 'watchdog.sh'), 'utf8'), { node, app, port, configDir: p.configDir, codexConfig: configPath(p) });
  mkdirSync(p.configDir, { recursive: true, mode: 0o700 });
  const target = join(p.configDir, 'watchdog.sh');
  writeFileSync(target, script, { mode: 0o700 });
  chmodSync(target, 0o700);
  return target;
}

function writeAgents(p, app, node, port, claudeBin = null) {
  mkdirSync(p.logDir, { recursive: true, mode: 0o700 });
  const env = serviceEnv(p, { node, claudeBin });
  const script = writeWatchdogScript(p, node, app, port);
  installAgent(p.launchAgentsDir, PROXY_LABEL, plistXml({ label: PROXY_LABEL, programArguments: [node, join(app, 'src', 'main.mjs')], env, stdout: join(p.logDir, 'proxy.stdout.log'), stderr: join(p.logDir, 'proxy.stderr.log'), keepAlive: true }));
  installAgent(p.launchAgentsDir, WATCHDOG_LABEL, plistXml({ label: WATCHDOG_LABEL, programArguments: ['/bin/sh', script], env, stdout: join(p.logDir, 'watchdog.log'), stderr: join(p.logDir, 'watchdog.log'), startInterval: 60 }));
}

async function waitHealthy(port, ms = 20_000) {
  const until = Date.now() + ms;
  for (;;) {
    const h = await proxyHealth(port, 1500);
    if (h.ok) return h;
    if (Date.now() > until) return h;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** The local models the running service offers once its first availability check is done. */
async function offeredSlugs(port, ms = 45_000) {
  const until = Date.now() + ms;
  let health = null;
  for (;;) {
    health = await proxyHealth(port, 2000);
    const a = health.availability;
    if (health.ok && a && a.claude_cli !== null && a.ollama !== null) break;
    if (Date.now() > until) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/lcp/models`, { signal: AbortSignal.timeout(3000) });
    return { slugs: (await res.json()).models.map((m) => m.slug), availability: health?.availability ?? null };
  } catch {
    return { slugs: [], availability: health?.availability ?? null };
  }
}

/**
 * A real Codex engine sees the ChatGPT account, the GPT models and every
 * offered local model; and GPT comes through the proxy now (Codex may answer
 * from its model cache, or with bundled models after a failed refresh).
 */
async function verifyThrough(p, port, overrides, want) {
  const r = await codexProbe({ overrides });
  const gpt = r.models.some((m) => /^gpt-/.test(m.slug));
  const local = want.every((s) => r.models.some((m) => m.slug === s));
  const up = r.ok ? await upstreamThrough(port, { codexHome: p.codexHome }) : { ok: false, error: null };
  return { ok: r.ok && gpt && local && up.ok, account: r.account, gpt, local, upstream: up.ok, error: r.error ?? up.error };
}

/**
 * Codex turns that ran on this Mac in the last `windowS` seconds, from Codex's
 * own trace log (every log line of a running turn carries its turn_input span).
 * Covers the desktop app (also when driven from the phone) and the CLI.
 * null when the log cannot be read.
 */
export function codexTurnActivity(p, windowS = 120) {
  const db = join(p.codexHome, 'logs_2.sqlite');
  if (!existsSync(db)) return null;
  const since = Math.floor(Date.now() / 1000) - windowS;
  const r = spawnSync('/usr/bin/sqlite3', ['-readonly', db, `SELECT count(DISTINCT thread_id) FROM logs WHERE ts >= ${since} AND feedback_log_body LIKE '%turn_input%';`], { encoding: 'utf8', timeout: 20_000 });
  const n = Number.parseInt(String(r.stdout).trim(), 10);
  return r.status === 0 && Number.isFinite(n) ? n : null;
}

/**
 * Before replacing a running proxy: wait (bounded) until nothing is streaming
 * through it and no Codex turn is running on this Mac (a restart would cut
 * them off). A fresh install (no proxy yet) never waits.
 */
export async function waitIdle(p, ports, log, maxMs = 10 * 60 * 1000, pollMs = 15_000) {
  const until = Date.now() + maxMs;
  let told = false;
  for (;;) {
    // every port a proxy may be serving Codex on (the one in config.toml, and the configured one)
    const hs = await Promise.all(ports.map((port) => proxyHealth(port, 2000)));
    const up = hs.some((h) => h.ok);
    const streaming = hs.reduce((n, h) => n + (h.ok && h.inflight > 0 ? h.inflight : 0), 0);
    const turns = up ? (codexTurnActivity(p) ?? 0) : 0;
    if (!streaming && !turns) return true;
    if (!told) {
      log(`   Codex で実行中の作業があるため（応答 ${streaming} 件・スレッド ${turns} 件）、終わるまで待っています…`);
      told = true;
    }
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function describeUnavailable(a) {
  const notes = [];
  if (a?.claude_cli && !a.claude_cli.ok) notes.push(a.claude_cli.version ? `Claude Code ${a.claude_cli.version} に必要な機能がありません（${a.claude_cli.missing_flags.join(' ')}）。claude update で更新してください。` : 'Claude Code が見つかりません。');
  for (const [id, acc] of Object.entries(a?.claude_accounts ?? {})) {
    if (!acc.logged_in || !acc.subscription) notes.push(`アカウント${id}が未ログインです: lcp account login ${id}`);
  }
  if (a?.ollama && !a.ollama.ok) notes.push('Ollama がないため Qwen は出しません。');
  return notes;
}

// ---- commands ------------------------------------------------------------------

export async function install({ log = console.log, enable = true, force = false, waitMs = 10 * 60 * 1000 } = {}) {
  const p = paths();
  const settings = loadSettings();
  const node = stableNode();
  if (!node) throw new Error(`Node.js ${MIN_NODE.join('.')} 以上が必要です（brew install node などで入れてください）。`);
  // the local models check every request against this sign-in; without it they could not be used at all
  if (!readCodexCredentials(p.codexHome)) throw new Error(`Codex のログイン情報（${join(p.codexHome, 'auth.json')}）が見つかりません。Codex アプリで ChatGPT にサインインしてから実行してください。何も変更していません。`);
  if (!settings.claude.bin) {
    const found = claudeFromLoginShell();
    if (found && !found.startsWith(join(p.home, '.local', 'bin')) && !found.startsWith('/opt/homebrew/bin') && !found.startsWith('/usr/local/bin')) settings.claude.bin = found;
  }
  saveSettings(settings);
  const cfg = configPath(p);
  const st = readConfigState(cfg);
  if (st.foreign) throw new Error('config.toml に別の openai_base_url が既に設定されています。先にそれを外してください。');
  const ports = [...new Set([st.port, settings.port].filter(Boolean))];
  if (!force && !(await waitIdle(p, ports, log, waitMs))) throw new Error('Codex の作業が続いているため中止しました（あとでもう一度、今すぐなら lcp install --now）。');

  try {
    log('1/5 実行用コピーを配置しています…');
    const app = copyRuntime(p);
    linkCommand(p, app, node);
    log('2/5 常駐サービス（自動再起動つき）と見張り役を登録しています…');
    writeAgents(p, app, node, settings.port, settings.claude.bin);
    restartAgent(PROXY_LABEL);
    const h = await waitHealthy(settings.port);
    if (!h.ok) throw new Error(`プロキシが起動しませんでした（${p.logDir} のログを確認してください）。`);

    log('3/5 本物の Codex エンジンでプロキシ経由の動作を確認しています（モデル利用なし）…');
    const offered = await offeredSlugs(settings.port);
    const via = await verifyThrough(p, settings.port, [`openai_base_url="http://127.0.0.1:${settings.port}"`], offered.slugs);
    if (!via.ok) throw new Error(`プロキシ経由の確認に失敗しました（account=${via.account}, gpt=${via.gpt}, local=${via.local}, upstream=${via.upstream}, error=${via.error}）。`);
    if (!enable) return { enabled: false, offered: offered.slugs, notes: describeUnavailable(offered.availability) };

    log('4/5 Codex の設定に1行追加しています（バックアップあり）…');
    // the config as it was before this tool ever touched it: kept outside the rotating backups
    const original = join(p.backupsDir, 'original-config.toml');
    const target = configTarget(cfg);
    if (!existsSync(original) && existsSync(target)) {
      mkdirSync(p.backupsDir, { recursive: true, mode: 0o700 });
      writeFileSync(original, disableText(readFileSync(target, 'utf8')), { mode: 0o600 });
    }
    return await withStateLock(p, async () => {
      recordFallback(p);
      const res = await enableVerified(p, settings.port, offered.slugs, () => log('5/5 設定ファイル経由でもう一度確認しています…'));
      if (!res.ok) throw new Error(`設定反映後の確認に失敗しました（error=${res.check.error}）。`);
      return { enabled: true, offered: offered.slugs, notes: describeUnavailable(offered.availability) };
    });
  } catch (err) {
    // Anything failed once the runtime may have changed: Codex must not keep pointing at it (an update of an enabled install).
    if (readConfigState(cfg).enabled) {
      await withStateLock(p, () => disableWithSwap(p, { manual: 1, auto: 0 }));
      throw new Error(`${err.message} Codex を OpenAI 直結に戻しました（GPT はそのまま使えます。直したあと lcp install で戻せます）。`);
    }
    throw new Error(`${err.message} Codex は OpenAI 直結です（GPT はそのまま使えます）。`);
  }
}

/**
 * Turn the route on: our line first, and a default model set aside earlier
 * put back; then a real Codex engine must see the account and the models
 * through it, and GPT must come through. On failure Codex goes back to OpenAI
 * directly (model set aside). Call with the state lock held.
 */
async function enableVerified(p, port, slugs, written = () => {}) {
  const before = readWatchdog(p);
  const r = updateConfig(configPath(p), p.backupsDir, (t) => unswapText(enableText(t, port), before.swapped, before.fallback));
  written();
  const check = await verifyThrough(p, port, [], slugs);
  if (!check.ok) {
    disableWithSwap(p);
    return { ok: false, changed: r.changed, check };
  }
  writeWatchdog(p, { ...readWatchdog(p), failures: 0, healthy: 0, auto: 0, manual: 0, swapped: '', restore_fail: 0 });
  recordFallback(p);
  return { ok: true, changed: r.changed, check };
}

/** Re-enable after `lcp off` (or the watchdog's fallback): only with a healthy proxy and a running watchdog, verified, rolled back on failure. */
export async function on() {
  const p = paths();
  const settings = loadSettings();
  const h = await proxyHealth(settings.port, 3000);
  if (!h.ok) throw new Error('プロキシが動いていません。先に lcp install を実行してください。');
  if (!isLoaded(WATCHDOG_LABEL)) throw new Error('見張り役が登録されていません。先に lcp install を実行してください。');
  const offered = await offeredSlugs(settings.port, 10_000);
  return withStateLock(p, async () => {
    const res = await enableVerified(p, settings.port, offered.slugs);
    if (!res.ok) throw new Error(`有効化後の確認に失敗したため元に戻しました（account=${res.check.account}, upstream=${res.check.upstream}, error=${res.check.error}）。`);
    return res.changed;
  });
}

/** OpenAI directly (a proxy-only default model set aside, as the watchdog does); the watchdog leaves it so. */
export async function off({ manual = true } = {}) {
  const p = paths();
  return withStateLock(p, () => disableWithSwap(p, manual ? { manual: 1, auto: 0 } : {}));
}

/**
 * Run by watchdog.sh once the proxy has been healthy for a while after its
 * fallback: 'restored', or 'skipped' if that no longer applies (turned off by
 * hand meanwhile...). Throws if the verified restore failed.
 */
export async function restoreAfterRecovery() {
  const p = paths();
  const settings = loadSettings();
  const offered = await offeredSlugs(settings.port, 10_000);
  const result = await withStateLock(p, async () => {
    const st = readWatchdog(p);
    if (!st.auto || st.manual) return 'skipped';
    const res = await enableVerified(p, settings.port, offered.slugs);
    if (!res.ok) throw new Error(`restore check failed (${res.check.error})`);
    return 'restored';
  });
  if (result === 'restored') notify('プロキシが復旧したので、Claude / ローカルモデルの経路を元に戻しました。');
  return result;
}

export async function uninstall() {
  const p = paths();
  await off({ manual: true });
  removeAgent(p.launchAgentsDir, WATCHDOG_LABEL);
  removeAgent(p.launchAgentsDir, PROXY_LABEL);
}

export async function status() {
  const p = paths();
  const settings = loadSettings();
  const cfg = readConfigState(configPath(p));
  const port = cfg.port ?? settings.port;
  const health = await proxyHealth(port);
  return {
    port,
    config: cfg,
    proxyLoaded: isLoaded(PROXY_LABEL),
    watchdogLoaded: isLoaded(WATCHDOG_LABEL),
    health,
    watchdog: readWatchdog(p),
    runtime: existsSync(join(p.runtimeDir, 'app')) ? join(p.runtimeDir, 'app') : null,
    localModels: buildCatalog(settings).map((e) => ({ slug: e.slug, name: e.info.display_name })),
    offered: health.ok ? await fetch(`http://127.0.0.1:${port}/lcp/models`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).then((j) => j.models).catch(() => null) : null,
  };
}
