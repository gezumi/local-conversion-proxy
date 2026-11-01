// Closed error vocabulary and redacted logging.
//
// An error that leaves this process (HTTP body, SSE `response.failed`, MCP
// error text, log line) carries a fixed code and a fixed message chosen here.
// Upstream text — Claude stderr, a tool result, a prompt, a schema value — is
// never interpolated, so nothing private can ride out on an error path.
// Log lines are equally closed: a fixed event list, each with fixed detail keys
// whose values are numbers, booleans or members of fixed label sets.

const MESSAGES = Object.freeze({
  unauthorized: [401, 'missing or invalid bearer token'],
  forbidden_host: [403, 'host or origin not allowed'],
  not_found: [404, 'no such route'],
  method_not_allowed: [405, 'method not allowed'],
  body_timeout: [408, 'request body was not received in time'],
  body_too_large: [413, 'リクエストが大きすぎます（ローカル変換プロキシの上限を超えました）。'],
  bad_json: [400, 'request body is not valid JSON'],
  bad_request: [400, 'ローカル変換プロキシが対応していない形式のリクエストです。'],
  model_not_supported: [400, 'このモデルはローカル変換プロキシでは扱えません。'],
  stream_required: [400, 'this proxy only serves streaming Responses requests'],
  unsupported_input: [400, '会話の中にローカル変換プロキシが扱えない項目があります。'],
  output_unknown_call: [409, 'ツール結果が待機中の呼び出しと一致しません。もう一度送信してください。'],
  output_duplicate: [409, 'tool output was already delivered'],
  output_conflict: [409, 'replayed tool output differs from the delivered one'],
  output_mixed_sessions: [409, 'tool outputs belong to different conversations'],
  response_mismatch: [409, '会話の状態が一致しません。もう一度送信してください。'],
  previous_response_unknown: [409, '前回の応答が見つかりません（プロキシ再起動など）。もう一度送信してください。'],
  session_busy: [409, 'この会話はまだ前の応答を処理中です。少し待ってから送信してください。'],
  compaction_unavailable: [409, '要約する会話が見つからないため圧縮できませんでした（会話はそのまま続けられます）。'],
  too_many_sessions: [503, 'Claude の同時会話数の上限に達しています。ほかの会話が終わってから送信してください。'],
  shutting_down: [503, 'ローカル変換プロキシが再起動中です。もう一度送信してください。'],
  claude_start_failed: [502, 'Claude Code を起動できませんでした。'],
  claude_input_failed: [502, 'Claude Code が入力を受け付けませんでした。'],
  claude_auth: [502, 'このアカウントの Claude Code がログインしていません。ターミナルで `lcp account login <番号>` を実行してください。'],
  claude_auth_check_failed: [503, 'Claude Code のログイン状態を確認できませんでした（応答が遅いか一時的なエラー）。もう一度送信してください。'],
  claude_account_mismatch: [502, 'Claude Code が想定と違うアカウントでログインしています。'],
  claude_version: [502, 'Claude Code のバージョンに互換性がありません。'],
  claude_model_mismatch: [502, 'Claude Code が指定と違うモデルで応答しました。'],
  claude_model_unavailable: [404, 'このアカウントではこの Claude モデルを使えません（モデル名が古いか、プランに含まれていません）。別のモデルを選ぶか、lcp の設定のモデル名を確認してください。'],
  claude_api_error: [502, 'Anthropic の API が一時的なエラーを返しました。もう一度送信してください。'],
  claude_tools_not_exposed: [502, 'Claude Code に Codex のツールを渡せませんでした。'],
  claude_exited: [502, 'Claude Code が応答の途中で終了しました。もう一度送信してください。'],
  process_cleanup_unconfirmed: [502, 'a helper process could not be confirmed stopped'],
  probe_registration_failed: [502, 'a probe process could not be registered with its owner'],
  scratch_cleanup_failed: [502, 'a private scratch directory could not be removed'],
  probe_registration_unconfirmed: [502, 'an unregistered probe process could not be confirmed stopped'],
  claude_error: [502, 'Claude Code がこのターンでエラーを返しました。もう一度送信してください（続く場合は lcp errors で原因を確認できます）。'],
  claude_usage_limit: [429, 'Claude のサブスク利用上限に達しました。リセットを待つか、別のアカウントのモデルを選んでください。'],
  claude_rate_limited: [429, 'Claude 側で一時的に回数制限がかかりました（サブスクの利用上限とは別です）。少し待ってから再送してください。'],
  claude_overloaded: [503, 'Claude が混み合っています。少し待ってから再送してください。'],
  claude_too_long: [400, '会話が長すぎて Claude に渡せませんでした。/compact で会話を圧縮するか、新しいスレッドで続けてください。'],
  claude_protocol: [502, 'Claude Code から想定外の出力がありました。もう一度送信してください。'],
  claude_timeout: [504, 'Claude Code が一定時間応答しませんでした。もう一度送信してください。'],
  mcp_disconnected: [502, 'Claude Code とのツール中継が切れました。もう一度送信してください。'],
  client_disconnected: [499, 'client disconnected'],
  internal: [500, 'ローカル変換プロキシ内部のエラーです。'],
});

export const ERROR_CODES = Object.freeze(Object.keys(MESSAGES));

export class BridgeError extends Error {
  constructor(code, detail = {}) {
    const known = MESSAGES[code] ? code : 'internal';
    super(MESSAGES[known][1]);
    this.code = known;
    this.status = MESSAGES[known][0];
    /** Closed-vocabulary detail only (see DETAIL_VALUES). */
    this.detail = safeDetail(detail);
  }
}

export function bridgeError(code, detail) {
  return new BridgeError(code, detail);
}

export function toBridgeError(err) {
  if (err instanceof BridgeError) return err;
  return new BridgeError('internal');
}

export function errorBody(err) {
  const e = toBridgeError(err);
  return { error: { type: 'proxy_error', code: e.code, message: e.message } };
}

/** Every string a log/detail value may take, per key. */
const WHY = new Set([
  'where', 'builtin_tool', 'extra_mcp', 'tools_not_exposed', 'mcp_not_connected', 'assistant_before_init', 'subagent', 'foreign_tool',
  'result_with_pending', 'result_before_relay', 'emitted_call_cancelled', 'no_anchor', 'outputs_missing', 'history_changed',
  'nothing_new', 'not_idle', 'authority_changed', 'input_during_tool_call', 'kind', 'line_too_large', 'line_not_json',
  'line_not_utf8', 'line_handler_failed', 'stdout_closed',
]);
const WHERE = new Set([
  'tools', 'tool', 'namespace', 'namespace_tool', 'tool_kind', 'tool_duplicate', 'function_name', 'custom_name', 'input', 'part',
  'part_kind', 'content', 'role', 'item', 'item_kind', 'call_id', 'instructions', 'encoding', 'previous_response_id',
]);
const REASONS = new Set([...ERROR_CODES, 'idle', 'respawn', 'evicted', 'shutdown', 'closed', 'client_disconnected', 'start_rollback']);
// No identifier of any kind (session, call, response, conversation) is a
// loggable value: correlation ids stay in memory only.
const DETAIL_VALUES = {
  code: (v) => ERROR_CODES.includes(v),
  reason: (v) => REASONS.has(v),
  why: (v) => WHY.has(v),
  where: (v) => WHERE.has(v),
};
const NUMBER_KEYS = new Set(['port', 'tools', 'skipped_tools', 'calls', 'leftover_dirs', 'unreaped', 'bounded_outputs', 'images', 'sessions']);
const BOOLEAN_KEYS = new Set(['text', 'reaped']);

/** Keep only known keys with values from their closed domain. */
export function safeDetail(detail) {
  const out = {};
  for (const [key, value] of Object.entries(detail ?? {})) {
    if (NUMBER_KEYS.has(key)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    } else if (BOOLEAN_KEYS.has(key)) {
      if (typeof value === 'boolean') out[key] = value;
    } else if (DETAIL_VALUES[key]?.(value)) {
      out[key] = value;
    }
  }
  return out;
}

const EVENTS = new Set([
  'bridge_listening', 'bridge_closed', 'session_start', 'session_fail', 'session_end', 'session_respawn', 'session_evict',
  'tool_args_invalid', 'tool_output_bounded', 'tool_output_delivered', 'user_turn_sent', 'response_done', 'response_failed',
  'client_disconnected', 'daemon_started', 'daemon_stopping', 'daemon_preflight_failed',
]);

/**
 * A logger that accepts only events from EVENTS with safe detail. `sink` is a
 * function taking one line; the default drops everything.
 */
export function createLogger(sink = null) {
  return {
    event(name, detail = {}) {
      if (!sink || !EVENTS.has(name)) return;
      const line = JSON.stringify({ t: new Date().toISOString(), event: name, ...safeDetail(detail) });
      try {
        sink(line);
      } catch {
        // A broken log sink must never break the bridge.
      }
    },
  };
}
