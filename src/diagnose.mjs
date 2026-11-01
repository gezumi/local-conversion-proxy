// `lcp errors`: what went wrong recently, from the proxy's own event log
// (proxy.log and its rotated copy). The log holds only event names and short
// codes (see log.mjs), so this report never contains conversation content.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths.mjs';
import { readWatchdog } from './watchdog-state.mjs';

/** Events that mean something failed, and the field that says which way. */
const FAILURES = {
  claude_response_failed: 'code',
  session_fail: 'code',
  session_respawn: 'why',
  session_evict: null,
  local_refused: 'code',
  local_unhandled: 'backend',
  replay_summary_failed: null,
  ollama_failed: 'code',
  ollama_http_error: 'status',
  ollama_derive_failed: null,
  upstream_unreachable: 'code',
  upstream_http_error: 'code',
  ws_upstream_error: 'code',
  ws_upstream_rejected: 'status',
  http_error: 'status',
  catalog_error: 'which',
  settings_reload_failed: null,
  models_rewrite_skipped: 'encoding',
  availability_probe_failed: 'which',
  uncaught_exception: 'code',
  unhandled_rejection: null,
  proxy_start_failed: 'code',
};

/** What each frequent code usually means, and what to do about it. */
const HINTS = {
  claude_auth: 'Claude Code のログインが切れています → lcp account login <番号>',
  claude_auth_check_failed: 'ログイン確認（claude auth status）が時間内に終わっていません。Mac が重い・Claude Code の更新中など',
  claude_usage_limit: 'Claude のサブスク上限。リセット待ちか別アカウントのモデルへ',
  claude_rate_limited: 'Anthropic 側の一時的な回数制限',
  claude_overloaded: 'Anthropic 側の混雑（529）',
  claude_api_error: 'Anthropic API の一時エラー（5xx・接続エラー）',
  claude_model_unavailable: 'モデル名が古いかプラン外 → settings.json の claude.models を確認',
  claude_model_mismatch: 'Claude Code が別モデルで応答（CLI の自動フォールバックなど）',
  claude_tools_not_exposed: 'Codex のツールを Claude Code に渡せていません（Claude Code の更新で挙動が変わった可能性）',
  claude_timeout: 'Claude Code が長時間無反応、または起動時の初期化が終わらない',
  claude_exited: 'Claude Code が途中で終了（クラッシュ・強制終了・更新）',
  claude_protocol: 'Claude Code の出力形式が想定外（CLI の更新で形式が変わった可能性）',
  mcp_disconnected: 'Claude Code と中継 MCP の接続が切れた',
  claude_too_long: '会話が長すぎ → /compact か新しいスレッド',
  session_busy: '同じスレッドの前の応答がまだ処理中',
  too_many_sessions: 'Claude の同時会話数の上限（12）',
  previous_response_unknown: 'プロキシ再起動などで前回の応答を失った（次の送信で自動的に再構成）',
  forbidden: 'この Mac の Codex ログイン以外からの利用（トークン更新直後の場合あり）',
  model_disabled: '無効化/未ログインのアカウントのモデルが選ばれている',
  ECONNRESET: 'OpenAI との接続が切れた',
  ETIMEDOUT: 'OpenAI への接続がタイムアウト',
  ENOTFOUND: 'DNS が引けない（ネットワーク切断）',
};

function readLines(file) {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  } catch {
    return [];
  }
}

/** { since, total, groups: [{ ev, key, value, count, last }], restarts } for the last `hours`. */
export function summarize({ hours = 24, p = paths(), now = Date.now() } = {}) {
  const since = now - hours * 3600 * 1000;
  const file = join(p.logDir, 'proxy.log');
  const groups = new Map();
  let total = 0;
  let restarts = 0;
  for (const line of [...readLines(`${file}.1`), ...readLines(file)]) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const t = Date.parse(e?.t);
    if (!Number.isFinite(t) || t < since) continue;
    if (e.ev === 'proxy_listening') restarts += 1;
    if (!(e.ev in FAILURES)) continue;
    const key = FAILURES[e.ev];
    const value = key ? String(e[key] ?? '-') : '-';
    const id = `${e.ev}\u0000${value}`;
    const g = groups.get(id) ?? { ev: e.ev, key, value, count: 0, last: e.t };
    g.count += 1;
    g.last = e.t;
    groups.set(id, g);
    total += 1;
  }
  return { since: new Date(since).toISOString(), total, restarts, groups: [...groups.values()].sort((a, b) => b.count - a.count), logFile: file };
}

export function errorsReport({ hours = 24, p = paths() } = {}) {
  const s = summarize({ hours, p });
  const out = [`直近 ${hours} 時間のエラー（${s.logFile}）`];
  out.push(`プロキシの起動回数: ${s.restarts}${s.restarts > 1 ? '（再起動あり: クラッシュ・更新・watchdog による kickstart）' : ''}`);
  if (!s.groups.length) out.push('記録されたエラーはありません。');
  for (const g of s.groups) {
    const hint = HINTS[g.value] ? `  … ${HINTS[g.value]}` : '';
    out.push(`${String(g.count).padStart(5)}  ${g.ev}${g.key ? ` ${g.key}=${g.value}` : ''}  (最後 ${g.last})${hint}`);
  }
  const wd = readWatchdog(p);
  if (wd.auto) out.push('', '⚠️ 見張り役がプロキシを外して OpenAI 直結に戻しています（Claude/ローカルのスレッドは復旧まで使えません）。');
  if (wd.restore_fail) out.push(`⚠️ 自動復旧の失敗: ${wd.restore_fail} 回`);
  if (wd.last_check) out.push(`見張り役の最終チェック: ${wd.last_check}（連続失敗 ${wd.failures} 回）`);
  return out.join('\n');
}
