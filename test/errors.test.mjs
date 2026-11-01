// How failures reach Codex: Codex retries any `error.code` it does not know
// (up to 5 times), so failures no retry can fix must use codes it treats as final.
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCliError } from '../src/claude/claude-session.mjs';
import { parseAuthStatus } from '../src/claude/claude-cli.mjs';
import { ERROR_CODES } from '../src/claude/errors.mjs';
import { ResponseStream, codexError } from '../src/responses.mjs';

test('failures no retry can fix are final for Codex; our code stays in lcp_code', () => {
  for (const code of ['claude_auth', 'claude_usage_limit', 'claude_model_unavailable', 'model_disabled', 'model_not_configured', 'forbidden', 'compaction_unavailable', 'claude_tools_not_exposed']) {
    assert.deepEqual(codexError(code, 'm'), { code: 'invalid_prompt', message: 'm', lcp_code: code }, code);
  }
  assert.equal(codexError('claude_too_long', 'm').code, 'context_length_exceeded');
  const busy = codexError('claude_overloaded', 'm');
  assert.equal(busy.code, 'rate_limit_exceeded');
  assert.match(busy.message, /try again in \d+s/, 'Codex reads the wait from the message');
  for (const code of ['claude_exited', 'claude_timeout', 'claude_protocol', 'mcp_disconnected', 'claude_api_error', 'claude_auth_check_failed', 'session_busy', 'shutting_down']) {
    assert.equal(codexError(code, 'm').code, code, `${code} stays retryable`);
  }
});

test('every code the Claude backend can produce is known to the error table', () => {
  for (const code of ['claude_model_unavailable', 'claude_api_error', 'claude_auth_check_failed']) assert.ok(ERROR_CODES.includes(code), code);
});

test('response.failed carries the Codex code', () => {
  const sent = [];
  const s = new ResponseStream({ send: (e) => sent.push(e), keepalive() {}, end() {} }, { model: 'claude-x' });
  s.created();
  s.failed({ code: 'claude_auth', message: 'login' });
  const f = sent.at(-1);
  assert.equal(f.type, 'response.failed');
  assert.deepEqual(f.response.error, { code: 'invalid_prompt', message: 'login', lcp_code: 'claude_auth' });
});

test('Claude CLI errors are classified by the API status first (as the real CLI reports them)', () => {
  // claude 2.1.316 with an unknown model: result is_error with api_error_status 404
  assert.equal(classifyCliError("There's an issue with the selected model (claude-x-9). It may not exist or you may not have access to it.", 404), 'claude_model_unavailable');
  assert.equal(classifyCliError("There's an issue with the selected model (claude-x-9). It may not exist or you may not have access to it."), 'claude_model_unavailable');
  assert.equal(classifyCliError('API Error: 500 Internal server error', 500), 'claude_api_error');
  assert.equal(classifyCliError('API Error: 529 Overloaded', 529), 'claude_overloaded');
  assert.equal(classifyCliError('Rate limited', 429), 'claude_rate_limited');
  assert.equal(classifyCliError("You've hit your limit · resets 3pm", 429), 'claude_usage_limit');
  assert.equal(classifyCliError('Invalid API key · Please run /login', 401), 'claude_auth');
  assert.equal(classifyCliError('Prompt is too long'), 'claude_too_long');
  assert.equal(classifyCliError('API Error: Connection error.'), 'claude_api_error');
  assert.equal(classifyCliError('something else'), 'claude_error');
});

test('an auth probe without a status (timeout, crash) is not "signed out"', () => {
  assert.equal(parseAuthStatus('').known, false);
  assert.equal(parseAuthStatus('garbage').known, false);
  const out = parseAuthStatus(JSON.stringify({ loggedIn: false }));
  assert.equal(out.known, true);
  assert.equal(out.loggedIn, false);
});

test('lcp errors groups recent failures by event and code (old lines and other events left out)', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { summarize, errorsReport } = await import('../src/diagnose.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'lcp-diag-'));
  try {
    const now = Date.parse('2026-11-01T12:00:00Z');
    const at = (h) => new Date(now - h * 3600_000).toISOString();
    const lines = [
      { t: at(30), ev: 'claude_response_failed', code: 'claude_auth' },
      { t: at(2), ev: 'proxy_listening' },
      { t: at(2), ev: 'claude_response_failed', code: 'claude_overloaded' },
      { t: at(1), ev: 'claude_response_failed', code: 'claude_overloaded' },
      { t: at(1), ev: 'upstream_http_error', code: 'ECONNRESET' },
      { t: at(1), ev: 'models_list' },
    ];
    writeFileSync(join(dir, 'proxy.log'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\nnot json\n`);
    const p = { logDir: dir, configDir: dir };
    const s = summarize({ hours: 24, p, now });
    assert.equal(s.total, 3);
    assert.equal(s.restarts, 1);
    assert.deepEqual(s.groups.map((g) => [g.ev, g.value, g.count]), [['claude_response_failed', 'claude_overloaded', 2], ['upstream_http_error', 'ECONNRESET', 1]]);
    assert.match(errorsReport({ hours: 24, p }), /直近 24 時間/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
