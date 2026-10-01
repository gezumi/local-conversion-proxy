// Claude Code accounts. Account 1 is the normal ~/.claude login; each further
// account has its own CLAUDE_CONFIG_DIR, so its login (and usage limit) is
// separate. Signing in is always done by the user in a browser.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseAuthStatus } from './claude/claude-cli.mjs';
import { defaultClaudeBin } from './claude/config.mjs';
import { paths } from './paths.mjs';
import { loadSettings, saveSettings } from './settings.mjs';

function claudeEnv(account) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^ANTHROPIC_|^CLAUDE_CODE_USE_|^CLAUDE_CODE_OAUTH/.test(k)) delete env[k];
  if (account.configDir) env.CLAUDE_CONFIG_DIR = account.configDir;
  else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

export function accountStatus(account, bin = loadSettings().claude.bin || defaultClaudeBin()) {
  const r = spawnSync(bin, ['auth', 'status', '--json'], { env: claudeEnv(account), encoding: 'utf8', timeout: 20_000 });
  return parseAuthStatus(r.stdout ?? '');
}

export function listAccounts() {
  const s = loadSettings();
  return s.claude.accounts.map((a) => ({ ...a, status: accountStatus(a, s.claude.bin || defaultClaudeBin()) }));
}

export function addAccount({ label = '' } = {}) {
  const s = loadSettings();
  const p = paths();
  const used = new Set(s.claude.accounts.map((a) => a.id));
  let n = 2;
  while (used.has(String(n))) n += 1;
  const id = String(n);
  const configDir = join(p.accountsDir, id);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  s.claude.accounts.push({ id, label, configDir, disabled: false });
  saveSettings(s);
  return { id, configDir };
}

export function setLabel(id, label) {
  const s = loadSettings();
  const a = s.claude.accounts.find((x) => x.id === id);
  if (!a) throw new Error(`アカウント ${id} はありません`);
  a.label = label;
  saveSettings(s);
}

export function removeAccount(id) {
  if (id === '1') throw new Error('アカウント1（通常の Claude Code ログイン）は外せません。使わない場合は disable してください。');
  const s = loadSettings();
  const before = s.claude.accounts.length;
  s.claude.accounts = s.claude.accounts.filter((x) => x.id !== id);
  if (s.claude.accounts.length === before) throw new Error(`アカウント ${id} はありません`);
  saveSettings(s);
}

export function setDisabled(id, disabled) {
  const s = loadSettings();
  const a = s.claude.accounts.find((x) => x.id === id);
  if (!a) throw new Error(`アカウント ${id} はありません`);
  a.disabled = disabled;
  saveSettings(s);
}

/** Interactive browser login for one account (the user signs in; nothing is typed for them). */
export function login(id) {
  const s = loadSettings();
  const a = s.claude.accounts.find((x) => x.id === id);
  if (!a) throw new Error(`アカウント ${id} はありません`);
  const bin = s.claude.bin || defaultClaudeBin();
  return new Promise((resolve) => {
    const child = spawn(bin, ['auth', 'login', '--claudeai'], { env: claudeEnv(a), stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}
