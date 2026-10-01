// Event log: one JSON line per event, owner-only, size-rotated.
//
// Only event names and safe scalar fields are written: numbers, booleans and
// short labels chosen by the caller. Never prompts, tool payloads, header
// values, tokens or account identifiers.

import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;
const LABEL = /^[A-Za-z0-9_.:@/-]{0,80}$/;

function safe(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean' || v === null) out[k] = v;
    else if (typeof v === 'string' && LABEL.test(v)) out[k] = v;
  }
  return out;
}

export function createLogger({ dir = null, file = 'proxy.log', echo = false } = {}) {
  let path = null;
  if (dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    path = join(dir, file);
  }
  return {
    path,
    event(name, fields) {
      const line = JSON.stringify({ t: new Date().toISOString(), ev: String(name).slice(0, 60), ...safe(fields) });
      if (echo) process.stderr.write(`${line}\n`);
      if (!path) return;
      try {
        if (existsSync(path) && statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
        appendFileSync(path, `${line}\n`, { mode: 0o600 });
        chmodSync(path, 0o600);
      } catch {
        // logging must never break the proxy
      }
    },
  };
}

export const nullLogger = { path: null, event() {} };
