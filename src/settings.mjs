// User settings (~/.config/local-conversion-proxy/settings.json, owner-only).
//
// Missing keys fall back to DEFAULTS, so an old or hand-edited file keeps working.
// Account 1 is the Claude Code login in ~/.claude (configDir null); further
// accounts each get their own CLAUDE_CONFIG_DIR under the config directory.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_PORT, paths } from './paths.mjs';

export const DEFAULTS = Object.freeze({
  version: 1,
  port: DEFAULT_PORT,
  upstream: 'https://chatgpt.com/backend-api/codex',
  claude: {
    bin: null,
    models: [
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
      { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
    ],
    accounts: [{ id: '1', label: '', configDir: null }],
    /** How a second account is shown in the model list: "{model} · {label}". */
    labelFormat: '{model} · {label}',
  },
  ollama: {
    enabled: true,
    baseUrl: 'http://127.0.0.1:11434',
    models: [{ id: 'qwen3.8:27b', name: 'Qwen 3.8 27B (ローカル)', contextWindow: 65536 }],
  },
});

function merge(base, over) {
  if (over === undefined || over === null) return structuredClone(base);
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over;
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

export function loadSettings(env = process.env) {
  const p = paths(env);
  let raw = null;
  if (existsSync(p.settingsFile)) {
    try {
      raw = JSON.parse(readFileSync(p.settingsFile, 'utf8'));
    } catch {
      raw = null; // unreadable: run on defaults rather than fail the GPT path
    }
  }
  return normalizeSettings(merge(DEFAULTS, raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null));
}

const str = (v, fallback) => (typeof v === 'string' && v.length > 0 ? v : fallback);
/** The first entry for each id (a repeated id would make two catalog entries with one slug). */
const uniqueById = (list) => {
  const seen = new Set();
  return list.filter((m) => !(m && typeof m === 'object') || typeof m.id !== 'string' || (seen.has(m.id) ? false : (seen.add(m.id), true)));
};
/** An http(s) URL that parses (the router and backends build on it), else the fallback. */
const httpUrl = (v, fallback) => {
  if (typeof v !== 'string') return fallback;
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname ? v : fallback;
  } catch {
    return fallback;
  }
};
const posInt = (v, fallback) => (Number.isInteger(v) && v > 0 ? v : fallback);

/**
 * Every field gets the shape the rest of the code relies on; a wrong type in a
 * hand-edited file falls back to the default for that field only.
 */
export function normalizeSettings(s) {
  const d = DEFAULTS;
  const out = { ...s };
  out.port = Number.isInteger(s.port) && s.port >= 1024 && s.port <= 65535 ? s.port : d.port;
  out.upstream = httpUrl(s.upstream, d.upstream);
  const c = s.claude && typeof s.claude === 'object' && !Array.isArray(s.claude) ? s.claude : d.claude;
  const models = uniqueById(Array.isArray(c.models) ? c.models : [])
    .filter((m) => m && typeof m === 'object' && typeof m.id === 'string' && /^claude-[a-z0-9.-]+$/.test(m.id))
    .map((m) => ({ id: m.id, name: str(m.name, m.id) }));
  out.claude = {
    ...c,
    bin: typeof c.bin === 'string' && c.bin ? c.bin : null,
    models: models.length || Array.isArray(c.models) ? models : structuredClone(d.claude.models),
    accounts: normalizeAccounts(c.accounts),
    labelFormat: str(c.labelFormat, d.claude.labelFormat),
  };
  const o = s.ollama && typeof s.ollama === 'object' && !Array.isArray(s.ollama) ? s.ollama : d.ollama;
  out.ollama = {
    ...o,
    enabled: typeof o.enabled === 'boolean' ? o.enabled : d.ollama.enabled,
    baseUrl: httpUrl(o.baseUrl, d.ollama.baseUrl),
    models: uniqueById(Array.isArray(o.models) ? o.models : [])
      .filter((m) => m && typeof m === 'object' && typeof m.id === 'string' && m.id)
      .map((m) => ({ id: m.id, name: str(m.name, m.id), contextWindow: posInt(m.contextWindow, 32768), ...(m.numCtx === null || posInt(m.numCtx, 0) ? { numCtx: m.numCtx === null ? null : m.numCtx } : {}) })),
  };
  return out;
}

function normalizeAccounts(list) {
  const seen = new Set();
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    const id = String(a?.id ?? '').trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: typeof a.label === 'string' ? a.label : '', configDir: typeof a.configDir === 'string' && a.configDir ? a.configDir : null, disabled: a.disabled === true });
  }
  if (!out.length) out.push({ id: '1', label: '', configDir: null, disabled: false });
  return out;
}

export function saveSettings(settings, env = process.env) {
  const p = paths(env);
  mkdirSync(dirname(p.settingsFile), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(p.settingsFile), `.settings.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, p.settingsFile);
}
