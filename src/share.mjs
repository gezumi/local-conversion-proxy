// `lcp share <user@host>`: copy this tool to another Mac over SSH and run the
// same safe install there (verify first, then the one config line). Only the
// runtime files travel: no archive, no git history, no local settings or logs.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PARTS = ['src', 'bin', 'test', 'node_modules', 'package.json', 'package-lock.json', 'README.md', '.gitignore'];
export const REMOTE_DIR = '~/Workspace/ローカル変換プロキシ';

function sh(cmd, args, { input = null, log } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    // decoded as streams: a Japanese character split across chunks stays whole
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      log?.(String(d).replace(/\n$/, ''));
    });
    child.stderr.on('data', (d) => {
      out += d;
      log?.(String(d).replace(/\n$/, ''));
    });
    if (input) input.pipe(child.stdin);
    child.on('close', (code) => resolve({ code, out }));
  });
}

const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];

export async function share(target, { log = console.log, install = true } = {}) {
  if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(target)) throw new Error('宛先は user@host の形で指定してください');
  const probe = await sh('ssh', [...SSH_OPTS, target, 'launchctl print gui/$(id -u) >/dev/null 2>&1 && echo gui-ok || echo no-gui']);
  if (probe.code !== 0) throw new Error(`${target} に SSH で接続できません（鍵が登録されているか確認してください）`);
  if (!probe.out.includes('gui-ok')) throw new Error(`${target} は画面にログインしていないため、常駐サービスを登録できません（その Mac にログインしてから再実行してください）`);
  log(`1/2 ${target} にコピーしています…`);
  const tar = spawn('tar', ['-C', ROOT, '-czf', '-', ...PARTS], { stdio: ['ignore', 'pipe', 'inherit'] });
  const copy = await sh('ssh', [...SSH_OPTS, target, `mkdir -p ${REMOTE_DIR} && tar -xzf - -C ${REMOTE_DIR}`], { input: tar.stdout });
  if (copy.code !== 0) throw new Error(`コピーに失敗しました: ${copy.out.slice(-300)}`);
  if (!install) return { installed: false };
  log(`2/2 ${target} で導入しています…`);
  const remote = `cd ${REMOTE_DIR} && for n in /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node)"; do if [ -x "$n" ]; then exec "$n" bin/lcp.mjs install; fi; done; echo "node が見つかりません"; exit 127`;
  const r = await sh('ssh', [...SSH_OPTS, target, remote], { log: (l) => log(`   ${l}`) });
  if (r.code !== 0) throw new Error(`${target} での導入に失敗しました（上の表示を確認してください）`);
  return { installed: true };
}
