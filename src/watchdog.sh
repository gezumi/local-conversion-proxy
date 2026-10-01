#!/bin/sh
# ローカル変換プロキシの見張り役（launchd が1分ごとに実行）。
#
# プロキシが2回続けて応答しない（または OpenAI に届かないと報告する）と、Codex を
# OpenAI 直結に戻す（fail-open）:
#  - ふつうは `lcp fail-open`。config.toml を TOML として読み、管理行
#      openai_base_url = "http://127.0.0.1:<port>" # local-conversion-proxy
#    を外し、既定モデルが Claude / ローカルのものならその行をコメントにして、
#    記録済みの GPT モデルの行を足す（記録がなければ Codex 標準の既定に任せる）。
#  - node やプロキシのコードが動かないときは、この script だけで管理行を外す
#    （ファイル先頭のコメント・空行に続く管理行だけ。BOM・CRLF も扱い、検証してから置き換える）。
# プロキシが続けて正常なら `lcp restore-after-recovery`（確認つき）で元に戻す。
# 失敗が続けば間隔を空け、5回でやめて知らせる。config.toml と状態ファイルは
# lcp コマンドと同じロックの下でだけ変える。
#
# __NODE__ などは導入時に、シェルの文字列として引用した値に置き換わる。

NODE=__NODE__
APP=__APP__
DEFAULT_PORT=__PORT__
CFG_DIR=__CONFIG_DIR__
CODEX_CFG=__CODEX_CONFIG__
LABEL=__LABEL__
NOTIFY=__NOTIFY__
STATE="$CFG_DIR/watchdog.state"
LOCK="$CFG_DIR/state.lock"
# temporary copies of config.toml (and the state) are never readable by others
umask 077

# A small TOML line scanner with the rules of src/codex-config.mjs: a line is
# looked at only if it starts a statement (outside multi-line strings, arrays
# and inline tables). mode=find prints our line. mode=strip drops it (a BOM
# stays first) and sets aside a root `model = "claude-…"/"local-…"` written as
# a plain one-line string (what Codex writes): commented out, with the GPT
# fallback ($LCP_FALLBACK) as a marked line after it, exactly as the node side
# does. It writes "<lines in> <removed> <inserted> <model set aside>" to $LCP_SIDE.
AWK_PROG='
function ours(s) { return s ~ /^[ \t]*openai_base_url[ \t]*=[ \t]*"http:\/\/127\.0\.0\.1:[0-9]+"[ \t]*# local-conversion-proxy[ \t]*$/ }
function lex(s, i,    c, n, q) {
  while (i <= length(s)) {
    c = substr(s, i, 1)
    if (ml != "") {
      q = substr(ml, 1, 1)
      if (q == DQ && c == "\\") { i += 2; continue }
      if (c == q) {
        n = 0
        while (substr(s, i + n, 1) == q) n++
        i += n
        if (n >= 3) ml = ""
        continue
      }
      i++
      continue
    }
    if (c == "#") return
    if (c == DQ || c == SQ) {
      if (substr(s, i, 3) == c c c) { ml = c c c; i += 3; continue }
      i++
      while (i <= length(s) && substr(s, i, 1) != c) { if (c == DQ && substr(s, i, 1) == "\\") i++; i++ }
      i++
      continue
    }
    if (c == "[" || c == "{") depth++
    else if ((c == "]" || c == "}") && depth > 0) depth--
    i++
  }
}
function after_model_key(s,    t) {
  t = s
  sub(/^[ \t]+/, "", t)
  if (substr(t, 1, 7) == DQ "model" DQ || substr(t, 1, 7) == SQ "model" SQ) t = substr(t, 8)
  else if (substr(t, 1, 5) == "model") t = substr(t, 6)
  else return ""
  if (t !~ /^[ \t]*=/) return ""
  sub(/^[ \t]*=[ \t]*/, "", t)
  return t "\001"
}
function plain_string(t,    q, rest, n, v) {
  q = substr(t, 1, 1)
  if ((q != DQ && q != SQ) || substr(t, 1, 3) == q q q) return ""
  rest = substr(t, 2)
  n = index(rest, q)
  if (n == 0) return ""
  v = substr(rest, 1, n - 1)
  if (q == DQ && index(v, "\\") > 0) return ""
  if (substr(rest, n + 1) !~ /^[ \t]*(#.*)?$/) return ""
  return v
}
BEGIN {
  DQ = "\""
  SQ = "\047"
  BOM = "\357\273\277"
  fb = ENVIRON["LCP_FALLBACK"]
  if (fb !~ /^[A-Za-z0-9._:-]+$/ || fb ~ /^(claude-|local-)/) fb = ""
  ml = ""; depth = 0; root = 1; removed = 0; inserted = 0; carry = 0; seen_model = 0; sw = ""
}
{
  raw = $0
  clean = raw
  bom = 0
  if (NR == 1 && substr(clean, 1, 3) == BOM) { clean = substr(clean, 4); raw = clean; bom = 1 }
  cr = ""
  if (clean ~ /\r$/) { sub(/\r$/, "", clean); cr = "\r" }
  kind = "cont"
  if (ml == "" && depth == 0) {
    t = clean
    sub(/^[ \t]+/, "", t)
    if (t == "") kind = "blank"
    else if (substr(t, 1, 1) == "#") kind = "comment"
    else if (substr(t, 1, 1) == "[") { kind = "table"; root = 0 }
    else kind = "keyval"
  }
  if (kind != "blank" && kind != "comment") lex(clean, 1)
  if (kind == "keyval" && ours(clean)) {
    if (mode == "find") { print clean; exit }
    removed++
    if (bom) carry = 1
    next
  }
  if (mode == "find") next
  lead = (bom || carry) ? BOM : ""
  carry = 0
  if (kind == "keyval" && root && !seen_model) {
    rest = after_model_key(clean)
    if (rest != "") {
      seen_model = 1
      v = plain_string(substr(rest, 1, length(rest) - 1))
      if (v ~ /^(claude-|local-)[A-Za-z0-9._:-]+$/) {
        sw = v
        print lead "# lcp-swapped: " raw
        if (fb != "") { print "model = " DQ fb DQ " # lcp-fallback" cr; inserted++ }
        next
      }
    }
  }
  print lead raw
}
END { if (mode == "strip") printf "%d %d %d %s\n", NR, removed, inserted, sw > ENVIRON["LCP_SIDE"] }'

notify() {
  [ "$NOTIFY" = 1 ] || return 0
  /usr/bin/osascript -e "display notification \"$1\" with title \"ローカル変換プロキシ\"" >/dev/null 2>&1
}

# One writer at a time for config.toml and the state, shared with the lcp commands.
# A lock older than 10 minutes was left by a process that died: it is removed, or,
# if it cannot be, ignored (a stuck lock must never keep Codex on a dead proxy).
locked=0
take_lock() {
  tries=0
  while ! /bin/mkdir "$LOCK" 2>/dev/null; do
    if [ -n "$(/usr/bin/find "$LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
      /bin/rm -rf "$LOCK" 2>/dev/null
      [ -e "$LOCK" ] && return 0
      continue
    fi
    tries=$((tries + 1))
    [ "$tries" -ge 20 ] && return 1
    /bin/sleep 1
  done
  locked=1
  trap '/bin/rmdir "$LOCK" 2>/dev/null' EXIT
  return 0
}
release_lock() {
  [ "$locked" = 1 ] && /bin/rmdir "$LOCK" 2>/dev/null
  locked=0
  trap - EXIT
}

# The state file is data, never code: known keys only, values of safe characters only.
num() {
  case "$1" in
    '' | *[!0-9]* | ??????????*) echo 0 ;;
    *) echo "$1" | /usr/bin/sed -e 's/^0*\([0-9]\)/\1/' ;;
  esac
}
read_state() {
  failures=0
  healthy=0
  auto=0
  manual=0
  swapped=""
  fallback=""
  restore_fail=0
  [ -f "$STATE" ] || return 0
  while IFS='=' read -r k v || [ -n "$k" ]; do
    case "$v" in *[!A-Za-z0-9._:-]*) continue ;; esac
    case "$k" in
      failures) failures=$(num "$v") ;;
      healthy) healthy=$(num "$v") ;;
      auto) auto=$(num "$v") ;;
      manual) manual=$(num "$v") ;;
      restore_fail) restore_fail=$(num "$v") ;;
      swapped) swapped=$v ;;
      fallback) fallback=$v ;;
    esac
  done < "$STATE"
}
write_state() {
  {
    printf 'failures=%s\n' "$failures"
    printf 'healthy=%s\n' "$healthy"
    printf 'auto=%s\n' "$auto"
    printf 'manual=%s\n' "$manual"
    printf 'swapped=%s\n' "$swapped"
    printf 'fallback=%s\n' "$fallback"
    printf 'restore_fail=%s\n' "$restore_fail"
    printf 'last_check=%s\n' "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$STATE.tmp" && /bin/mv "$STATE.tmp" "$STATE"
}

# A command with a time limit (stock macOS has no `timeout`).
run_limited() {
  limit=$1
  shift
  "$@" &
  pid=$!
  (
    trap '/bin/kill "$s" 2>/dev/null; exit 0' TERM
    /bin/sleep "$limit" &
    s=$!
    wait "$s" && /bin/kill -TERM "$pid" 2>/dev/null
  ) &
  watcher=$!
  wait "$pid"
  rc=$?
  /bin/kill "$watcher" 2>/dev/null
  return "$rc"
}

# Without node: our line out (and a plain local default model set aside) by this
# script alone; the result is verified, the original backed up, then replaced.
strip_line() {
  sw=""
  [ -f "$cfg" ] || return 1
  tmp="$cfg.lcp-wd.$$"
  side="$tmp.info"
  LCP_SIDE="$side" LCP_FALLBACK="$fallback" /usr/bin/awk -v mode=strip "$AWK_PROG" "$cfg" > "$tmp"
  st=$?
  total=0
  removed=0
  inserted=0
  set_aside=""
  [ -f "$side" ] && read -r total removed inserted set_aside < "$side"
  /bin/rm -f "$side"
  kept=$(/usr/bin/wc -l < "$tmp" | /usr/bin/tr -d ' ')
  if [ "$st" = 0 ] && [ "${removed:-0}" -ge 1 ] && [ "$kept" = $((total - removed + inserted)) ]; then
    case "$set_aside" in *[!A-Za-z0-9._:-]*) set_aside="" ;; esac
    sw="$set_aside"
    /bin/mkdir -p "$CFG_DIR/backups"
    /bin/cp -p "$cfg" "$CFG_DIR/backups/config.toml.watchdog-$(/bin/date +%Y%m%dT%H%M%S)" 2>/dev/null
    /bin/chmod "$(/usr/bin/stat -f %Lp "$cfg")" "$tmp" 2>/dev/null
    /bin/mv "$tmp" "$cfg" && return 0
  fi
  /bin/rm -f "$tmp"
  return 1
}

# 0: Codex now goes to OpenAI directly ($sw: the default model set aside); 3: nothing to change; 1: failed.
fail_open() {
  sw=""
  if [ -x "$NODE" ] && [ -f "$APP/bin/lcp.mjs" ]; then
    out="$CFG_DIR/fail-open.out.$$"
    # this script holds the lock for it
    run_limited "${LCP_WD_FAIL_OPEN_LIMIT_S:-30}" /usr/bin/env LCP_LOCK_HELD=1 "$NODE" "$APP/bin/lcp.mjs" fail-open > "$out" 2>/dev/null
    rc=$?
    sw=$(/usr/bin/sed -n 's/^swapped=\([A-Za-z0-9._:-]*\)$/\1/p' "$out" 2>/dev/null | /usr/bin/head -n 1)
    /bin/rm -f "$out"
    [ "$rc" = 0 ] || [ "$rc" = 3 ] && return "$rc"
  fi
  strip_line
}

take_lock || exit 0
read_state

cfg="$CODEX_CFG"
[ -e "$cfg" ] && cfg=$(/bin/realpath "$cfg" 2>/dev/null || printf '%s' "$cfg")
line=""
[ -f "$cfg" ] && line=$(/usr/bin/awk -v mode=find "$AWK_PROG" "$cfg" 2>/dev/null)
port=$(printf '%s' "$line" | /usr/bin/sed -E 's/.*127\.0\.0\.1:([0-9]+).*/\1/')
[ -n "$port" ] || port="$DEFAULT_PORT"

# down: the proxy does not answer. unreachable: it answers but cannot reach OpenAI.
health=$(/usr/bin/curl -fsS -m 4 "http://127.0.0.1:$port/healthz" 2>/dev/null)
case "$health" in
  *'"service":"local-conversion-proxy"'*)
    case "$health" in
      *'"upstream_ok":false'*) status=unreachable ;;
      *) status=ok ;;
    esac
    ;;
  *) status=down ;;
esac

restore_due=0
if [ "$status" = ok ]; then
  failures=0
  healthy=$((healthy + 1))
  if [ -z "$line" ] && [ "$auto" = 1 ] && [ "$manual" != 1 ] && [ "$restore_fail" -lt 5 ] && [ "$healthy" -ge $((5 << restore_fail)) ] && [ -x "$NODE" ] && [ -f "$APP/bin/lcp.mjs" ]; then
    restore_due=1
  fi
else
  healthy=0
  failures=$((failures + 1))
  if [ -n "$line" ] && [ "$failures" -ge 2 ]; then
    if fail_open; then
      auto=1
      restore_fail=0
      [ -n "$sw" ] && swapped="$sw"
      notify "プロキシが応答しない（または OpenAI に届かない）ため、Codex を OpenAI 直結に戻しました（GPT はそのまま使えます）。"
    fi
  fi
  [ "$status" = down ] && [ "$failures" -ge 2 ] && /bin/launchctl kickstart -k "gui/$(/usr/bin/id -u)/$LABEL" >/dev/null 2>&1
fi
write_state
release_lock

# The restore takes the lock itself (and re-checks the state). A failure or a hang counts against later attempts.
if [ "$restore_due" = 1 ]; then
  run_limited 300 "$NODE" "$APP/bin/lcp.mjs" restore-after-recovery >/dev/null 2>&1
  rc=$?
  if [ "$rc" != 0 ] && [ "$rc" != 3 ] && take_lock; then
    read_state
    restore_fail=$((restore_fail + 1))
    healthy=0
    write_state
    release_lock
    [ "$restore_fail" -ge 5 ] && notify "自動で元に戻せませんでした。必要なら lcp on を実行してください（GPT はそのまま使えます）。"
  fi
fi
exit 0
