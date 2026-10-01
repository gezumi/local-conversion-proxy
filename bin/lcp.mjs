#!/usr/bin/env node
// lcp — ローカル変換プロキシの操作コマンド
//
// `lcp fail-open` (run by the watchdog when the proxy stops answering) loads
// only the config editing code, so it works even when the proxy's own code
// cannot load. Every other command is in src/cli.mjs.

if (process.argv[2] === 'fail-open') {
  const { failOpenCommand } = await import('../src/fail-open.mjs');
  process.exitCode = await failOpenCommand();
} else {
  await import('../src/cli.mjs');
}
