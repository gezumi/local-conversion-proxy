// How Claude Code is invoked: argv, environment, and the login check.
//
// Claude runs with no built-in tool except ToolSearch (deferred MCP tool
// loading), exactly one MCP server (the relay, `--strict-mcp-config`), no
// user/project/local settings (so no hooks or plugins), no CLAUDE.md
// discovery, no session persistence, and the requested model and effort.
// Permission mode `dontAsk` plus an allow rule for the relay server means
// every relay tool is callable and nothing else is. Each account is a
// separate CLAUDE_CONFIG_DIR (account 1: the default ~/.claude).

import { MCP_SERVER_LABEL, TOOL_SEARCH, TOOL_SEARCH_MODE } from './config.mjs';
import { bridgeError } from './errors.mjs';
import { runProbe } from './proc.mjs';

export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

export const FORBIDDEN_FLAGS = Object.freeze([
  '--fallback-model',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--resume',
  '--continue',
  '--settings',
  '--add-dir',
  '--max-budget-usd',
  '--max-turns',
  '--system-prompt',
  '--append-system-prompt',
  '--agents',
  '--plugin-dir',
  '--plugin-url',
  '--bare',
]);

/** Codex reasoning effort -> Claude Code --effort (null: CLI default). */
export function claudeEffort(effort) {
  if (typeof effort !== 'string') return null;
  const e = effort.toLowerCase();
  if (EFFORTS.includes(e)) return e;
  if (e === 'minimal' || e === 'none') return 'low';
  if (e === 'ultra') return 'max';
  return null;
}

export function buildClaudeArgs({ mcpConfigPath, systemPromptPath, model, effort = null }) {
  if (typeof model !== 'string' || !/^claude-[a-z0-9.-]+$/.test(model)) throw bridgeError('claude_model_mismatch');
  const args = [
    '-p',
    '--model',
    model,
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfigPath,
    '--system-prompt-file',
    systemPromptPath,
    // Only deferred-tool search; no file, shell or web tool of Claude Code itself.
    '--tools',
    TOOL_SEARCH,
    '--allowedTools',
    `mcp__${MCP_SERVER_LABEL}`,
    '--permission-mode',
    'dontAsk',
    // Empty on purpose: no user/project/local settings, hence no hooks or plugins.
    '--setting-sources',
    '',
    '--disable-slash-commands',
  ];
  if (effort) args.push('--effort', effort);
  assertNoForbiddenFlags(args);
  return args;
}

export function assertNoForbiddenFlags(args) {
  for (const a of args) {
    if (FORBIDDEN_FLAGS.some((f) => a === f || a.startsWith(`${f}=`))) throw new Error('forbidden_claude_flag');
  }
  return true;
}

export const ENV_PASSTHROUGH = Object.freeze(['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE']);

/** Names that could move the child off the signed-in Claude.ai route or change the model. */
const FORBIDDEN_ENV = [
  /^ANTHROPIC_/,
  /^CLAUDE_CODE_USE_/,
  /^CLAUDE_CODE_OAUTH/,
  /^CLAUDE_CODE_SIMPLE$/,
  /^CLAUDE_CODE_CLIENT_DATA_URL$/,
  /^AWS_/,
  /^GOOGLE_/,
  /^GCLOUD_/,
  /^VERTEX_/,
  /^BEDROCK_/,
  /^AZURE_/,
  /^FOUNDRY_/,
  /^CLOUD_ML_/,
  /^OPENAI_/,
];

export function isForbiddenEnvName(name) {
  return FORBIDDEN_ENV.some((re) => re.test(name));
}

/**
 * The child environment: a short allowlist from `source`, plus fixed values.
 * `configDir` selects the account (null: the default ~/.claude login).
 */
export function buildClaudeEnv(source, { tmpDir, mcpToolTimeoutMs, maxMcpOutputTokens = 400_000, configDir = null }) {
  const env = {};
  for (const key of ENV_PASSTHROUGH) {
    if (typeof source?.[key] === 'string' && source[key].length > 0) env[key] = source[key];
  }
  Object.assign(env, {
    TMPDIR: tmpDir,
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
    DISABLE_AUTOUPDATER: '1',
    // Brief congestion (429/529) is retried by the CLI itself; the proxy's keepalives cover the wait.
    CLAUDE_CODE_MAX_RETRIES: '4',
    // A relay call waits on Codex (and maybe a human approval). It must neither
    // be backgrounded nor idle-aborted; the proxy owns that bound.
    CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0',
    CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: '0',
    MCP_TOOL_TIMEOUT: String(mcpToolTimeoutMs),
    // Codex apps add hundreds of tools: load them on demand past a small share of the context.
    ENABLE_TOOL_SEARCH: TOOL_SEARCH_MODE,
    // No file-spill of large outputs: Claude has no Read tool to open them.
    ENABLE_MCP_LARGE_OUTPUT_FILES: 'false',
    // The CLI's default MCP output cap would cut Codex outputs; the proxy bounds each output itself.
    MAX_MCP_OUTPUT_TOKENS: String(maxMcpOutputTokens),
    CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: '32768',
  });
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  const bad = Object.keys(env).filter(isForbiddenEnvName);
  if (bad.length) throw new Error('forbidden_claude_env');
  return env;
}

/** The MCP config Claude receives: one stdio server, the relay. */
export function buildMcpConfig({ nodeBin, mcpServerPath, socketPath, token, toolTimeoutMs }) {
  return {
    mcpServers: {
      [MCP_SERVER_LABEL]: {
        type: 'stdio',
        command: nodeBin,
        args: [mcpServerPath],
        env: { CLAUDE_BRIDGE_RELAY_SOCKET: socketPath, CLAUDE_BRIDGE_RELAY_TOKEN: token },
        timeout: toolTimeoutMs,
      },
    },
  };
}

/**
 * A probe runs in its own process group, which is reaped and whose close is
 * observed before it counts. An unconfirmed cleanup is its own failure.
 */
async function run(bin, args, env, cwd, hooks = {}) {
  const r = await runProbe(bin, args, { env, cwd, timeoutMs: hooks.timeoutMs ?? 30_000, graceMs: 1000, signal: hooks.signal ?? null, ownership: hooks.ownership, onSpawn: hooks.onSpawn, onSettled: hooks.onSettled });
  if (!r.confirmed) throw bridgeError(r.registrationFailed ? 'probe_registration_unconfirmed' : 'process_cleanup_unconfirmed');
  if (r.registrationFailed) throw bridgeError('probe_registration_failed');
  return r;
}

/** `claude --version` -> "2.1.285" (or throws claude_version). */
export async function claudeVersion({ bin, env, cwd, ...hooks }) {
  const r = await run(bin, ['--version'], env, cwd, hooks);
  const v = r.ok ? r.stdout.trim().split(/\s+/)[0] : '';
  if (!/^\d+\.\d+\.\d+/.test(v)) throw bridgeError('claude_version');
  return v;
}

/** Parse `claude auth status --json` output into { loggedIn, subscription, email, plan } (kept in memory only). */
export function parseAuthStatus(stdout) {
  let parsed = null;
  for (const line of [String(stdout).trim(), ...String(stdout).split('\n').reverse()]) {
    try {
      parsed = JSON.parse(line.trim());
      if (parsed && typeof parsed === 'object') break;
    } catch {
      parsed = null;
    }
  }
  const email = parsed?.email ?? parsed?.emailAddress ?? parsed?.account?.email ?? parsed?.account?.emailAddress ?? null;
  const known = Boolean(parsed && typeof parsed === 'object' && typeof parsed.loggedIn === 'boolean');
  return {
    /** false: the output was not a status at all (timeout, crash): nothing is known about the login. */
    known,
    loggedIn: parsed?.loggedIn === true,
    subscription: parsed?.authMethod === 'claude.ai' && parsed?.apiProvider === 'firstParty',
    email: typeof email === 'string' ? email : null,
    plan: typeof parsed?.subscriptionType === 'string' ? parsed.subscriptionType : null,
  };
}

/** Full status of one account's login (for `lcp account list`). */
export async function claudeAuthStatus({ bin, env, cwd, ...hooks }) {
  const r = await run(bin, ['auth', 'status', '--json'], env, cwd, hooks);
  return r.ok || r.stdout ? parseAuthStatus(r.stdout) : { known: false, loggedIn: false, subscription: false, email: null, plan: null };
}

/**
 * The account must be signed in through the Claude.ai subscription route
 * (not an API key). Account data never leaves this process.
 */
export async function checkClaudeAuth({ bin, env, cwd, ...hooks }) {
  const s = await claudeAuthStatus({ bin, env, cwd, ...hooks });
  // A probe that timed out or crashed says nothing about the login: not "signed out" (a retry can work).
  if (!s.known) throw bridgeError(hooks.signal?.aborted ? 'client_disconnected' : 'claude_auth_check_failed');
  if (!s.loggedIn || !s.subscription) throw bridgeError('claude_auth');
  return true;
}
