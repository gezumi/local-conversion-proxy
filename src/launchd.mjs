// LaunchAgents for the proxy (always running, restarted within seconds) and
// its watchdog (every minute: falls back to direct OpenAI if the proxy is down).

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LAUNCHD_LABEL } from './paths.mjs';

export const PROXY_LABEL = LAUNCHD_LABEL;
export const WATCHDOG_LABEL = `${LAUNCHD_LABEL}.watchdog`;

function esc(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function plistXml({ label, programArguments, env = {}, stdout, stderr, keepAlive = false, startInterval = null, runAtLoad = true }) {
  const envXml = Object.entries(env)
    .map(([k, v]) => `      <key>${esc(k)}</key><string>${esc(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${esc(label)}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments.map((a) => `      <string>${esc(a)}</string>`).join('\n')}
    </array>
    <key>RunAtLoad</key>${runAtLoad ? '<true/>' : '<false/>'}
${keepAlive ? '    <key>KeepAlive</key><true/>\n    <key>ThrottleInterval</key><integer>2</integer>\n' : ''}${startInterval ? `    <key>StartInterval</key><integer>${startInterval}</integer>\n` : ''}    <key>ProcessType</key><string>Interactive</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>StandardOutPath</key><string>${esc(stdout)}</string>
    <key>StandardErrorPath</key><string>${esc(stderr)}</string>
  </dict>
</plist>
`;
}

function domain() {
  return `gui/${process.getuid()}`;
}

export function isLoaded(label) {
  return spawnSync('launchctl', ['print', `${domain()}/${label}`], { stdio: 'ignore' }).status === 0;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** bootout returns before the job is gone; wait (bounded) until launchd no longer knows it. */
function unload(label) {
  if (!isLoaded(label)) return;
  spawnSync('launchctl', ['bootout', `${domain()}/${label}`], { stdio: 'ignore' });
  for (let i = 0; i < 50 && isLoaded(label); i += 1) sleepMs(200);
}

/** Write the plist and (re)load it. */
export function installAgent(launchAgentsDir, label, xml) {
  mkdirSync(launchAgentsDir, { recursive: true });
  const plist = join(launchAgentsDir, `${label}.plist`);
  unload(label);
  writeFileSync(plist, xml, { mode: 0o644 });
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      execFileSync('launchctl', ['bootstrap', domain(), plist], { stdio: 'pipe' });
      return plist;
    } catch (err) {
      lastErr = err;
      if (isLoaded(label)) return plist; // loaded by a concurrent attempt
      sleepMs(500);
    }
  }
  throw lastErr;
}

export function removeAgent(launchAgentsDir, label) {
  unload(label);
  const plist = join(launchAgentsDir, `${label}.plist`);
  if (existsSync(plist)) rmSync(plist, { force: true });
}

export function restartAgent(label) {
  return spawnSync('launchctl', ['kickstart', '-k', `${domain()}/${label}`], { stdio: 'ignore' }).status === 0;
}

export function notify(message, title = 'ローカル変換プロキシ') {
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  spawnSync('osascript', ['-e', script], { stdio: 'ignore', timeout: 5000 });
}
