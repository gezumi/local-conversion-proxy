// Who may use the local models. They spend the owner's subscriptions, so a
// request is served only if it carries the credentials of this Mac's own
// Codex sign-in: the access token (or API key) and account that Codex itself
// sends, as kept in its auth.json. Only digests are held in memory. Without
// such a file (credentials kept elsewhere) nobody is served.

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const digest = (s) => createHash('sha256').update(String(s)).digest();

/** isOwner(headers) -> Promise<boolean>. */
export function createOwnerCheck({ codexHome = join(homedir(), '.codex'), retryDelaysMs = [300, 1000] } = {}) {
  const file = join(codexHome, 'auth.json');
  let cache = { stamp: null, secrets: [], account: null };

  function load() {
    let stamp;
    try {
      const st = statSync(file);
      stamp = `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      cache = { stamp: null, secrets: [], account: null };
      return cache;
    }
    if (stamp === cache.stamp) return cache;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      const secrets = [j?.tokens?.access_token, j?.OPENAI_API_KEY].filter((v) => typeof v === 'string' && v.length >= 20).map(digest);
      const account = typeof j?.tokens?.account_id === 'string' && j.tokens.account_id ? j.tokens.account_id : null;
      cache = { stamp, secrets, account };
    } catch {
      cache = { stamp, secrets: [], account: null };
    }
    return cache;
  }

  function matches(headers) {
    const c = load();
    const auth = String(headers?.authorization ?? '');
    if (!auth.startsWith('Bearer ') || !c.secrets.length) return false;
    const d = digest(auth.slice(7));
    if (!c.secrets.some((s) => timingSafeEqual(s, d))) return false;
    return c.account === null || headers['chatgpt-account-id'] === c.account;
  }

  return async function isOwner(headers) {
    if (matches(headers)) return true;
    // Codex may be saving a token it has just refreshed.
    for (const ms of retryDelaysMs) {
      await new Promise((r) => setTimeout(r, ms));
      if (matches(headers)) return true;
    }
    return false;
  };
}

/** This Mac's Codex sign-in as Codex sends it ({ token, account }), or null. For the installer's own checks only. */
export function readCodexCredentials(codexHome = join(homedir(), '.codex')) {
  try {
    const j = JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf8'));
    const access = j?.tokens?.access_token;
    const token = typeof access === 'string' && access ? access : typeof j?.OPENAI_API_KEY === 'string' && j.OPENAI_API_KEY ? j.OPENAI_API_KEY : null;
    if (!token) return null;
    const account = typeof j?.tokens?.account_id === 'string' && j.tokens.account_id ? j.tokens.account_id : null;
    return { token, account };
  } catch {
    return null;
  }
}
