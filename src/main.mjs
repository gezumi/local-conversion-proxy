#!/usr/bin/env node
// Proxy process: router + Claude backend + Ollama backend.
// Run by launchd (KeepAlive) after `lcp install`; `lcp run` runs it in the foreground.

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAvailability } from './availability.mjs';
import { buildCatalog } from './catalog.mjs';
import { createClaudeBackend } from './claude/backend.mjs';
import { createLogger } from './log.mjs';
import { createOllamaBackend } from './ollama.mjs';
import { createOwnerCheck } from './owner.mjs';
import { paths } from './paths.mjs';
import { createRouter } from './router.mjs';
import { loadSettings } from './settings.mjs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

function mtimeOf(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Start the proxy. Settings are re-read when the settings file changes, so
 * adding an account or a model needs no restart (Codex refreshes /models on
 * its own schedule; restarting the Codex app shows changes immediately).
 */
export async function startProxy({ env = process.env, port = null, logger = createLogger(), upstream = null, claudeOptions = {}, ollamaFetch, availability = null, isOwner = null, routerOptions = {} } = {}) {
  const p = paths(env);
  let settings = loadSettings(env);
  let seen = mtimeOf(p.settingsFile);
  let checkedAt = Date.now();
  const avail = availability === false ? null : (availability ?? createAvailability({ getSettings: () => settings, logger, env, fetchImpl: ollamaFetch ?? fetch }));
  let lastRoutes = [];
  let lastCatalog = [];
  const reloadIfChanged = () => {
    if (Date.now() - checkedAt <= 2000) return;
    checkedAt = Date.now();
    const m = mtimeOf(p.settingsFile);
    if (m === seen) return;
    seen = m;
    try {
      settings = loadSettings(env);
      logger.event('settings_reloaded');
      avail?.refresh();
    } catch {
      logger.event('settings_reload_failed'); // keep the last good settings
    }
  };
  /** Every configured local model, turned off or not: requests for these never go to OpenAI. */
  const getRoutes = () => {
    reloadIfChanged();
    try {
      lastRoutes = buildCatalog(settings, null, { includeDisabled: true });
    } catch {
      logger.event('catalog_error', { which: 'routes' });
    }
    return lastRoutes;
  };
  /** The local models this Mac can run right now (what /models lists). */
  const getCatalog = () => {
    reloadIfChanged();
    try {
      lastCatalog = buildCatalog(settings, avail);
    } catch {
      logger.event('catalog_error', { which: 'catalog' });
    }
    return lastCatalog;
  };
  avail?.start();
  const claude = await createClaudeBackend({ logger, claudeBin: settings.claude.bin || undefined, envSource: env, onAuthFailure: () => avail?.refresh(), ...claudeOptions });
  const ollama = createOllamaBackend({ logger, baseUrl: settings.ollama?.baseUrl, fetchImpl: ollamaFetch });
  const router = createRouter({ upstream: upstream ?? settings.upstream, getRoutes, getCatalog, backends: { claude, ollama }, logger, version: VERSION, health: () => ({ ...claude.health(), availability: avail?.snapshot() ?? null }), isOwner: isOwner ?? createOwnerCheck({ codexHome: p.codexHome }), ...routerOptions });
  let listened;
  try {
    listened = await router.listen(port ?? settings.port);
  } catch (err) {
    avail?.stop();
    await claude.close();
    throw err;
  }
  logger.event('proxy_listening', { port: listened, local_models: getCatalog().length });
  return {
    port: listened,
    router,
    claude,
    async close() {
      avail?.stop();
      await router.close();
      await claude.close();
    },
  };
}

async function main() {
  const p = paths();
  const logger = createLogger({ dir: p.logDir, echo: process.env.LCP_LOG_ECHO === '1' });
  process.on('unhandledRejection', () => logger.event('unhandled_rejection'));
  process.on('uncaughtException', (err) => {
    logger.event('uncaught_exception', { code: err?.code ?? 'error' });
    process.stderr.write(`local-conversion-proxy: ${err?.stack ?? err}\n`);
    process.exit(1); // launchd restarts us within seconds
  });
  let proxy;
  try {
    proxy = await startProxy({ logger, port: process.env.LCP_PORT ? Number(process.env.LCP_PORT) : null });
  } catch (err) {
    logger.event('proxy_start_failed', { code: err?.code ?? 'error' });
    process.stderr.write(`local-conversion-proxy: could not start: ${err?.message ?? err}\n`);
    process.exit(1);
  }
  process.stderr.write(`local-conversion-proxy ${VERSION} listening on http://127.0.0.1:${proxy.port}\n`);
  const stop = async () => {
    logger.event('proxy_stopping');
    const t = setTimeout(() => process.exit(0), 8000);
    t.unref();
    await proxy.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main();
