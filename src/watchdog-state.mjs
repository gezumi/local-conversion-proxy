// The watchdog's state: key=value lines in <configDir>/watchdog.state, shared
// by watchdog.sh and the node commands. Values are restricted to a safe
// character set on both sides (the shell reads them as data, never as code).

import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SAFE_VALUE = /^[A-Za-z0-9._:-]*$/;
const NUMERIC = /^(failures|healthy|auto|manual|restore_fail)$/;

function stateFile(p) {
  return join(p.configDir, 'watchdog.state');
}

export function readWatchdog(p) {
  const st = { failures: 0, healthy: 0, auto: 0, manual: 0, swapped: '', fallback: '', restore_fail: 0, last_check: '' };
  try {
    for (const line of readFileSync(stateFile(p), 'utf8').split('\n')) {
      const m = /^([a-z_]+)=(.*)$/.exec(line);
      if (m && m[1] in st && SAFE_VALUE.test(m[2])) st[m[1]] = NUMERIC.test(m[1]) ? Number(m[2]) || 0 : m[2];
    }
  } catch {
    // no state yet
  }
  return st;
}

export function writeWatchdog(p, st) {
  mkdirSync(p.configDir, { recursive: true, mode: 0o700 });
  const lines = Object.entries(st)
    .filter(([k, v]) => /^[a-z_]+$/.test(k) && SAFE_VALUE.test(String(v)))
    .map(([k, v]) => `${k}=${v}`);
  const tmp = `${stateFile(p)}.tmp-${process.pid}`;
  writeFileSync(tmp, `${lines.join('\n')}\n`, { mode: 0o600 });
  renameSync(tmp, stateFile(p));
}

const STALE_LOCK_MS = 10 * 60 * 1000;

/**
 * Run `fn` holding the lock that config.toml and the state share with
 * watchdog.sh (a directory: atomic to create, for shell and node alike). A
 * lock older than 10 minutes was left by a process that died: it is removed,
 * or, if it cannot be, ignored (a stuck lock must never block a change).
 * Under the watchdog (LCP_LOCK_HELD=1) the lock is already held for us.
 */
export async function withStateLock(p, fn, { waitMs = 30_000 } = {}) {
  if (process.env.LCP_LOCK_HELD === '1') return fn();
  mkdirSync(p.configDir, { recursive: true, mode: 0o700 });
  const lock = join(p.configDir, 'state.lock');
  const until = Date.now() + waitMs;
  let held = false;
  for (;;) {
    try {
      mkdirSync(lock);
      held = true;
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    let age = 0;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      continue; // released meanwhile: try again at once
    }
    if (age > STALE_LOCK_MS) {
      try {
        rmSync(lock, { recursive: true, force: true });
      } catch {
        // cannot remove it
      }
      if (existsSync(lock)) break; // stuck: go on without it
      continue;
    }
    if (Date.now() > until) throw new Error('見張り役など別の操作が設定を変更中です。少し待ってからもう一度実行してください。');
    await new Promise((r) => setTimeout(r, 200));
  }
  try {
    return await fn();
  } finally {
    if (held) {
      try {
        rmdirSync(lock);
      } catch {
        // already gone
      }
    }
  }
}
