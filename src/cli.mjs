// lcp — ローカル変換プロキシの操作コマンド（bin/lcp.mjs から読み込まれる本体）

import { accountStatus, addAccount, listAccounts, login, removeAccount, setDisabled, setLabel } from './accounts.mjs';
import { buildCatalog } from './catalog.mjs';
import { paths } from './paths.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { install, off, on, restoreAfterRecovery, status, uninstall } from './service.mjs';
import { share } from './share.mjs';
import { loadSettings, saveSettings } from './settings.mjs';

const HELP = `lcp — ローカル変換プロキシ

  lcp status                 いまの状態（経路・サービス・モデル一覧）
  lcp install                導入/更新（Codex の作業中は終わるまで待つ。--when-idle で最長12時間待つ / --now で待たない）
  lcp on | off               Claude/ローカルモデルの経路を有効化 / OpenAI 直結に戻す（既定モデルが Claude/ローカルなら GPT に替え、on で戻す）
  lcp uninstall              サービスを止めて設定の1行を外す（設定・ログは残す）
  lcp models                 追加されるモデル名の一覧
  lcp account list           Claude Code アカウントとログイン状態
  lcp account add [名前]     アカウントを追加（その後 lcp account login <番号>）
  lcp account login <番号>   そのアカウントでブラウザログイン（本人が操作）
  lcp account label <番号> <名前>   モデル一覧での見え方を変更（例: 「Claude Opus 5.5 · 名前」）
  lcp account disable|enable <番号>
  lcp account remove <番号>
  lcp format "<書式>"        2つ目以降のアカウントの表示書式（{model} と {label} が使えます）
  lcp share <user@host>      ほかの Mac に SSH でコピーして導入（例: lcp share me@bigmac.local）
  lcp run                    前面で起動（開発用）
`;

function line(ok, text) {
  console.log(`${ok ? '✅' : '⚠️ '} ${text}`);
}

async function cmdStatus() {
  const s = await status();
  console.log(`ローカル変換プロキシ  (127.0.0.1:${s.port})`);
  line(s.config.enabled, s.config.enabled ? 'Codex はプロキシ経由（GPT はそのまま中継、Claude/ローカルはここで処理）' : 'Codex は OpenAI 直結（プロキシ無効）');
  if (s.watchdog.auto) line(false, '見張り役が自動で直結に戻しています（プロキシ復旧後に自動で戻ります）');
  if (s.watchdog.manual && !s.config.enabled) console.log('   （lcp off で止めています。戻すときは lcp on）');
  line(s.proxyLoaded && s.health.ok, s.health.ok ? `サービス稼働中（v${s.health.version}, 起動から ${s.health.uptime_s}s, Claude 会話 ${s.health.claude_sessions ?? 0}）` : 'サービスが応答していません');
  line(s.watchdogLoaded, s.watchdogLoaded ? '見張り役（1分ごと）稼働中' : '見張り役が登録されていません');
  const a = s.health.availability;
  if (a) {
    const cli = a.claude_cli;
    line(Boolean(cli?.ok), cli?.ok ? `Claude Code ${cli.version}` : `Claude Code が使えません（${cli?.version ? `バージョン ${cli.version} は古く、必要な機能 ${cli.missing_flags.join(' ')} がありません。更新してください` : '見つかりません'}）`);
    for (const [id, acc] of Object.entries(a.claude_accounts ?? {})) {
      line(acc.logged_in && acc.subscription, `アカウント${id}: ${acc.logged_in ? (acc.subscription ? `ログイン済み（${acc.plan ?? 'サブスク'}）` : 'サブスク経路ではないログイン') : `未ログイン → lcp account login ${id}`}`);
    }
    line(Boolean(a.ollama?.ok), a.ollama?.ok ? `Ollama 稼働中（モデル ${a.ollama.models} 個）` : 'Ollama なし（ローカル Qwen は一覧に出しません）');
  }
  console.log('\nいまモデル一覧に追加しているもの:');
  for (const m of s.offered ?? []) console.log(`  - ${m.name}  [${m.slug}]`);
  if (!s.offered?.length) console.log('  （なし）');
}

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      console.log(HELP);
      return;
    case 'status':
      return cmdStatus();
    case 'install': {
      // --now: do not wait; --when-idle: wait up to 12 hours for a quiet moment (for unattended updates)
      const r = await install({ log: (m) => console.log(m), force: sub === '--now', waitMs: sub === '--when-idle' ? 12 * 60 * 60 * 1000 : 10 * 60 * 1000 });
      console.log('\n導入完了。');
      for (const n of r.notes ?? []) console.log(`・${n}`);
      console.log('・新しく開くスレッドから有効です。モデル一覧に Claude/Qwen が出ない場合は Codex アプリを一度終了して開き直してください。');
      console.log('・スマホの Codex でも、この Mac の環境を選べば同じモデルが使えます。');
      if (r.models) for (const m of r.models.filter((x) => !/^gpt-/.test(x.slug))) console.log(`  - ${m.name}`);
      return;
    }
    case 'on':
      console.log((await on()) ? '有効にしました（新しいスレッドから適用）。' : 'すでに有効です。');
      return;
    case 'restore-after-recovery':
      // run by the watchdog script once the proxy is healthy again (exit 3: nothing to restore)
      process.exitCode = (await restoreAfterRecovery()) === 'restored' ? 0 : 3;
      return;
    case 'off':
      console.log((await off()) ? 'OpenAI 直結に戻しました（新しいスレッドから適用。既定モデルが Claude/ローカルだった場合は GPT に替えています。lcp on で戻ります）。' : 'すでに直結です。');
      return;
    case 'uninstall':
      await uninstall();
      console.log('サービスを停止し、Codex の設定から1行を外しました。設定とログは残っています。');
      return;
    case 'watchdog': {
      // compatibility: an older launchd entry ran `lcp watchdog`; the watchdog is now a shell script
      const script = join(paths().configDir, 'watchdog.sh');
      if (existsSync(script)) spawnSync('/bin/sh', [script], { stdio: 'inherit' });
      return;
    }
    case 'models': {
      for (const e of buildCatalog(loadSettings())) console.log(`${e.info.display_name}\t${e.slug}`);
      return;
    }
    case 'format': {
      if (!sub) throw new Error('例: lcp format "{model} · {label}"');
      const s = loadSettings();
      s.claude.labelFormat = sub;
      saveSettings(s);
      console.log('表示書式を変更しました。');
      return;
    }
    case 'account':
      return cmdAccount(sub, rest);
    case 'share': {
      if (!sub) throw new Error('例: lcp share me@other-mac.local');
      await share(sub, { log: (m) => console.log(m) });
      console.log(`\n${sub} に導入しました。その Mac で Claude Code にログインしていない場合は、その Mac で lcp account login 1 を実行してください。`);
      return;
    }
    case 'run': {
      process.env.LCP_LOG_ECHO = process.env.LCP_LOG_ECHO ?? '1';
      const { startProxy } = await import('./main.mjs');
      const { createLogger } = await import('./log.mjs');
      const proxy = await startProxy({ logger: createLogger({ dir: paths().logDir, echo: true }), port: process.env.LCP_PORT ? Number(process.env.LCP_PORT) : null });
      console.log(`listening on http://127.0.0.1:${proxy.port}`);
      const stop = async () => {
        await proxy.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    default:
      console.log(HELP);
      process.exitCode = 2;
  }
}

async function cmdAccount(sub, rest) {
  switch (sub) {
    case 'list':
    case undefined: {
      for (const a of listAccounts()) {
        const st = a.status;
        const login = st.loggedIn ? (st.subscription ? `ログイン済み（${st.plan ?? 'サブスク'}）${st.email ? ` ${st.email}` : ''}` : 'ログイン済みだがサブスク経路ではない') : '未ログイン';
        console.log(`${a.id}${a.label ? `「${a.label}」` : ''}${a.disabled ? ' [無効]' : ''}: ${login}`);
      }
      return;
    }
    case 'add': {
      const { id } = addAccount({ label: rest.join(' ') || '' });
      console.log(`アカウント ${id} を追加しました。次にログインしてください:\n  lcp account login ${id}`);
      return;
    }
    case 'login': {
      const id = rest[0];
      if (!id) throw new Error('例: lcp account login 2');
      const code = await login(id);
      const s = loadSettings();
      const a = s.claude.accounts.find((x) => x.id === id);
      const st = accountStatus(a);
      console.log(st.loggedIn ? `アカウント ${id} はログイン済みです。` : `アカウント ${id} はまだログインしていません（終了コード ${code}）。`);
      return;
    }
    case 'label': {
      const [id, ...label] = rest;
      if (!id) throw new Error('例: lcp account label 2 サブ');
      setLabel(id, label.join(' '));
      console.log('表示名を変更しました（Codex アプリを開き直すと一覧に反映されます）。');
      return;
    }
    case 'disable':
    case 'enable':
      setDisabled(rest[0], sub === 'disable');
      console.log(sub === 'disable' ? '無効にしました。' : '有効にしました。');
      return;
    case 'remove':
      removeAccount(rest[0]);
      console.log('外しました（ログイン情報のフォルダは残しています）。');
      return;
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  console.error(`エラー: ${err?.message ?? err}`);
  process.exitCode = 1;
});
