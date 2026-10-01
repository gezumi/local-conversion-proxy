// Where settings, state and logs live. One place, so tests can redirect everything.

import { homedir } from 'node:os';
import { join } from 'node:path';

export const APP_ID = 'local-conversion-proxy';
export const LAUNCHD_LABEL = 'com.local-conversion-proxy';
export const DEFAULT_PORT = 41600;

export function paths(env = process.env) {
  const home = env.LCP_HOME_OVERRIDE || homedir();
  const configDir = env.LCP_CONFIG_DIR || join(home, '.config', APP_ID);
  return {
    home,
    configDir,
    settingsFile: join(configDir, 'settings.json'),
    backupsDir: join(configDir, 'backups'),
    accountsDir: join(configDir, 'claude-accounts'),
    logDir: env.LCP_LOG_DIR || join(home, 'Library', 'Logs', 'LocalConversionProxy'),
    runtimeDir: env.LCP_RUNTIME_DIR || join(home, '.local', 'share', APP_ID),
    codexHome: env.CODEX_HOME || join(home, '.codex'),
    launchAgentsDir: join(home, 'Library', 'LaunchAgents'),
  };
}
