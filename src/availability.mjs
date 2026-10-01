// What this Mac can actually run right now, so the model list only offers
// models that will work: a Claude account appears only while its Claude Code
// login is a subscription login and the CLI supports every flag we use; a
// local model appears only while Ollama serves it. Checked at start and then
// every minute. Until the first check finishes, everything counts as available
// (a startup race must not hide models that work).

import { execFile } from 'node:child_process';
import { parseAuthStatus } from './claude/claude-cli.mjs';
import { defaultClaudeBin } from './claude/config.mjs';

/**
 * Flags buildClaudeArgs passes; a CLI without them cannot run a session.
 * Each entry lists the spellings `claude --help` may use (it shows
 * --system-prompt-file only as "--system-prompt[-file]").
 */
export const REQUIRED_CLAUDE_FLAGS = [['--effort'], ['--include-partial-messages'], ['--system-prompt-file', '--system-prompt[-file]'], ['--strict-mcp-config'], ['--setting-sources'], ['--disable-slash-commands'], ['--tools'], ['--mcp-config']];

/** Required flags `helpText` does not mention (by their first spelling). */
export function missingClaudeFlags(helpText) {
  return REQUIRED_CLAUDE_FLAGS.filter((alts) => !alts.some((f) => helpText.includes(f))).map((alts) => alts[0]);
}

function run(execFileImpl, bin, args, env, timeout) {
  return new Promise((resolve) => {
    execFileImpl(bin, args, { env, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout ?? '') }));
  });
}

function claudeEnv(base, account) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!/^ANTHROPIC_|^CLAUDE_CODE_USE_|^CLAUDE_CODE_OAUTH|^CLAUDE_CONFIG_DIR$/.test(k)) env[k] = v;
  if (account.configDir) env.CLAUDE_CONFIG_DIR = account.configDir;
  return env;
}

export function createAvailability({ getSettings, logger = { event() {} }, env = process.env, execFileImpl = execFile, fetchImpl = fetch, intervalMs = 60_000 } = {}) {
  const state = {
    claudeCli: null, // { ok, version, missing: [] }
    accounts: new Map(), // id -> { loggedIn, subscription, plan }
    ollama: null, // { ok, models: Set }
  };
  let timer = null;
  let running = null;
  let lastKey = '';

  async function checkClaude(settings) {
    const bin = settings.claude.bin || defaultClaudeBin(env);
    const [ver, help] = await Promise.all([run(execFileImpl, bin, ['--version'], env, 15_000), run(execFileImpl, bin, ['--help'], env, 15_000)]);
    const version = ver.ok ? ver.stdout.trim().split(/\s+/)[0] : null;
    const missing = help.ok ? missingClaudeFlags(help.stdout) : REQUIRED_CLAUDE_FLAGS.map((alts) => alts[0]);
    state.claudeCli = { ok: Boolean(version) && missing.length === 0, version, missing };
    if (!state.claudeCli.ok) return;
    await Promise.all(
      settings.claude.accounts.map(async (a) => {
        if (a.disabled) return;
        const r = await run(execFileImpl, bin, ['auth', 'status', '--json'], claudeEnv(env, a), 20_000);
        const s = parseAuthStatus(r.stdout);
        state.accounts.set(a.id, { loggedIn: s.loggedIn, subscription: s.subscription, plan: s.plan });
      }),
    );
  }

  async function checkOllama(settings) {
    if (!settings.ollama?.enabled) {
      state.ollama = { ok: false, models: new Set() };
      return;
    }
    try {
      const res = await fetchImpl(`${settings.ollama.baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
      const body = res.ok ? await res.json() : null;
      const names = new Set((body?.models ?? []).flatMap((m) => [m.name, m.model].filter(Boolean)));
      state.ollama = { ok: res.ok, models: names };
    } catch {
      state.ollama = { ok: false, models: new Set() };
    }
  }

  function signature() {
    return JSON.stringify([state.claudeCli?.ok, [...state.accounts].map(([id, a]) => [id, a.loggedIn && a.subscription]), state.ollama?.ok, [...(state.ollama?.models ?? [])].sort()]);
  }

  async function refresh() {
    if (running) return running;
    running = (async () => {
      const settings = getSettings();
      await Promise.allSettled([checkClaude(settings), checkOllama(settings)]);
      const key = signature();
      if (key !== lastKey) {
        lastKey = key;
        logger.event('availability_changed', { claude_cli: Boolean(state.claudeCli?.ok), accounts_ready: [...state.accounts.values()].filter((a) => a.loggedIn && a.subscription).length, ollama: Boolean(state.ollama?.ok) });
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    refresh,
    start() {
      refresh();
      timer = setInterval(refresh, intervalMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
    },
    claudeAccount(id) {
      if (state.claudeCli && !state.claudeCli.ok) return false;
      const a = state.accounts.get(id);
      return a ? a.loggedIn && a.subscription : true;
    },
    ollamaModel(model) {
      if (!state.ollama) return true;
      if (!state.ollama.ok) return false;
      return state.ollama.models.has(model) || state.ollama.models.has(`${model}:latest`);
    },
    snapshot() {
      return {
        claude_cli: state.claudeCli ? { ok: state.claudeCli.ok, version: state.claudeCli.version, missing_flags: state.claudeCli.missing } : null,
        claude_accounts: Object.fromEntries([...state.accounts].map(([id, a]) => [id, { logged_in: a.loggedIn, subscription: a.subscription, plan: a.plan }])),
        ollama: state.ollama ? { ok: state.ollama.ok, models: state.ollama.models.size } : null,
      };
    },
  };
}
