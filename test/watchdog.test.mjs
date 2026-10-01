// The fail-open watchdog is a shell script; run the real script against a
// throwaway config and a fake health endpoint. Fail-open runs the real
// `lcp fail-open` (or, with node "broken", the script's own fallback). It
// never touches launchd jobs that exist (dummy label) and never notifies.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { disableText, enableText, failOpenText, managedLine, topLevelModel, unswapText } from '../src/codex-config.mjs';
import { renderWatchdogScript } from '../src/service.mjs';

const SOURCE = readFileSync(new URL('../src/watchdog.sh', import.meta.url), 'utf8');
const APP = fileURLToPath(new URL('..', import.meta.url));

async function healthServer(ok) {
  const server = http.createServer((req, res) => {
    if (!ok.value) return req.socket.destroy();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'local-conversion-proxy', upstream_ok: ok.value !== 'unreachable' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

/**
 * node: 'real' (fail-open runs the real command), 'broken' (every node call fails), 'hang' (fail-open never returns).
 * Restore calls are only recorded (exit `restoreExit`).
 */
function setup(port, { model = 'gpt-6.1-sol', fallback = 'gpt-6.1-sol', defaultPort = port, configText = null, restoreExit = 0, node = 'real', state = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lcp-wd-'));
  const cfgDir = join(dir, 'cfg');
  mkdirSync(cfgDir, { recursive: true });
  const fakeNode = join(dir, 'fake-node');
  const calls = join(dir, 'node-calls');
  const failOpen = { real: `exec ${JSON.stringify(process.execPath)} "$@"`, broken: 'exit 1', hang: 'exec /bin/sleep 30' }[node];
  writeFileSync(fakeNode, `#!/bin/sh\necho "$2" >> ${JSON.stringify(calls)}\nif [ "$2" = fail-open ]; then ${failOpen}; fi\nexit ${restoreExit}\n`);
  chmodSync(fakeNode, 0o755);
  const codexConfig = join(dir, 'config.toml');
  writeFileSync(codexConfig, configText ?? `${managedLine(port)}\nmodel = "${model}"\n\n[projects."/x"]\ntrust_level = "trusted"\n`, { mode: 0o600 });
  writeFileSync(join(cfgDir, 'watchdog.state'), state ?? `fallback=${fallback}\n`);
  const script = join(dir, 'watchdog.sh');
  writeFileSync(script, renderWatchdogScript(SOURCE, { node: fakeNode, app: APP, port: defaultPort, configDir: cfgDir, codexConfig, label: 'com.local-conversion-proxy.test-dummy', notify: false }));
  // the node side finds the same files through the same variables launchd would leave at their defaults
  const env = { ...process.env, LCP_CONFIG_DIR: cfgDir, CODEX_HOME: dir, LCP_WD_FAIL_OPEN_LIMIT_S: '2' };
  // async: the fake health server lives in this process and must keep answering
  const run = () => promisify(execFile)('/bin/sh', [script], { encoding: 'utf8', env });
  const stateNow = () => Object.fromEntries(readFileSync(join(cfgDir, 'watchdog.state'), 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const nodeCalls = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { dir, cfgDir, codexConfig, run, state: stateNow, nodeCalls, restoreCalls: () => nodeCalls().filter((c) => c === 'restore-after-recovery') };
}

async function withDeadProxy(opts, fn) {
  const ok = { value: false };
  const server = await healthServer(ok);
  try {
    const w = setup(server.address().port, typeof opts === 'function' ? opts(server.address().port) : opts);
    await fn(w, server.address().port, ok);
  } finally {
    server.close();
  }
}

test('watchdog: healthy keeps the line; two failures remove it (and only it); recovery calls the verified restore', async () => {
  await withDeadProxy({}, async (w, port, ok) => {
    ok.value = true;
    const original = readFileSync(w.codexConfig, 'utf8');
    await w.run();
    assert.equal(readFileSync(w.codexConfig, 'utf8'), original);
    ok.value = false;
    await w.run();
    assert.equal(readFileSync(w.codexConfig, 'utf8'), original, 'one failure is not enough');
    await w.run();
    assert.equal(readFileSync(w.codexConfig, 'utf8'), original.replace(`${managedLine(port)}\n`, ''), 'exactly our line was removed');
    assert.deepEqual(w.nodeCalls(), ['fail-open'], 'by the node command');
    assert.equal(w.state().auto, '1');
    ok.value = true;
    for (let i = 0; i < 4; i += 1) await w.run();
    assert.deepEqual(w.restoreCalls(), [], 'not before five healthy checks');
    await w.run();
    assert.deepEqual(w.restoreCalls(), ['restore-after-recovery']);
  });
});

test('watchdog: a Claude default model falls back to the recorded GPT model, and the swap is remembered', async () => {
  await withDeadProxy({ model: 'claude-opus-5-5', fallback: 'gpt-6.1-sol' }, async (w) => {
    await w.run();
    await w.run();
    const after = readFileSync(w.codexConfig, 'utf8');
    assert.equal(topLevelModel(after), 'gpt-6.1-sol');
    assert.ok(!after.includes('local-conversion-proxy'));
    assert.equal(w.state().swapped, 'claude-opus-5-5');
    assert.equal(topLevelModel(unswapText(after, 'claude-opus-5-5', 'gpt-6.1-sol')), 'claude-opus-5-5', 'and the node side can put it back');
  });
});

for (const line of ['model="claude-opus-5-5"', "model = 'claude-opus-5-5'", '"model" = "claude-opus-5-5"', "  model\t=  'local-qwen3.8-27b'   # mine"]) {
  test(`watchdog: the default model is swapped whatever its TOML spelling (${line.trim()})`, async () => {
    await withDeadProxy((port) => ({ configText: `${managedLine(port)}\n${line}\n\n[t]\nk = 1\n` }), async (w) => {
      await w.run();
      await w.run();
      const after = readFileSync(w.codexConfig, 'utf8');
      assert.equal(topLevelModel(after), 'gpt-6.1-sol', after);
      assert.ok(!after.includes('local-conversion-proxy'));
      assert.match(w.state().swapped, /^(claude-opus-5-5|local-qwen3\.8-27b)$/);
    });
  });
}

test('watchdog: probes the port written in config.toml, not a default', async () => {
  const ok = { value: true };
  const server = await healthServer(ok);
  const w = setup(server.address().port, { defaultPort: 9 });
  try {
    await w.run();
    await w.run();
    assert.ok(readFileSync(w.codexConfig, 'utf8').includes('local-conversion-proxy'), 'healthy on the configured port: line kept');
  } finally {
    server.close();
  }
});

for (const node of ['real', 'broken']) {
  for (const [name, make] of [
    ['CRLF', (base) => base.replaceAll('\n', '\r\n')],
    ['BOM', (base) => `﻿${base}`],
    ['BOM+CRLF', (base) => `﻿${base.replaceAll('\n', '\r\n')}`],
  ]) {
    test(`watchdog: fail-open works on a ${name} config written by the installer (node ${node})`, async () => {
      await withDeadProxy((port) => ({ node, configText: enableText(make('# my settings\nmodel = "gpt-6.1-sol"\n\n[t]\nk = 1\n'), port) }), async (w) => {
        const before = readFileSync(w.codexConfig, 'utf8');
        await w.run();
        await w.run();
        assert.equal(readFileSync(w.codexConfig, 'utf8'), disableText(before), 'exactly our line removed, BOM and line endings kept');
        assert.equal(w.state().auto, '1');
      });
    });
  }
}

test('watchdog: with no recorded GPT model, a Claude default is commented out and can be restored', async () => {
  await withDeadProxy({ model: 'claude-opus-5-5', fallback: '' }, async (w) => {
    await w.run();
    await w.run();
    const after = readFileSync(w.codexConfig, 'utf8');
    assert.match(after, /^# lcp-swapped: model = "claude-opus-5-5"$/m);
    assert.equal(topLevelModel(after), null, 'Codex falls back to its own default');
    assert.equal(w.state().swapped, 'claude-opus-5-5');
    assert.equal(topLevelModel(unswapText(after, 'claude-opus-5-5', '')), 'claude-opus-5-5');
    // a model chosen in the meantime is kept: no second `model` key
    const chosen = after.replace('# lcp-swapped: model = "claude-opus-5-5"\n', '# lcp-swapped: model = "claude-opus-5-5"\nmodel = "gpt-6.2"\n');
    assert.equal(unswapText(chosen, 'claude-opus-5-5', ''), chosen.replace('# lcp-swapped: model = "claude-opus-5-5"\n', ''));
  });
});

test('watchdog: when node cannot run, the script alone removes our line and sets a Claude default aside, as node would', async () => {
  await withDeadProxy({ node: 'broken', model: 'claude-opus-5-5' }, async (w) => {
    const before = readFileSync(w.codexConfig, 'utf8');
    await w.run();
    await w.run();
    assert.equal(readFileSync(w.codexConfig, 'utf8'), failOpenText(before, 'gpt-6.1-sol').text);
    assert.equal(w.state().auto, '1');
    assert.equal(w.state().swapped, 'claude-opus-5-5');
  });
});

/** Configs on which the shell-only fail-open must give exactly node's result. */
const PARITY = [
  (port) => `${managedLine(port)}\nmodel = "claude-opus-5-5"\n[t]\nk = 1\n`,
  (port) => `\uFEFF${managedLine(port)}\r\nmodel = 'local-qwen3.8-27b' # mine\r\n[t]\r\n`,
  (port) => `# top comment\n${managedLine(port)}\n"model" = "claude-sonnet-5-5"\n`,
  (port) => `${managedLine(port)}\nnotes = """\nmodel = "claude-x"\n${managedLine(41699)}\n"""\nargs = [\n  "]",\n  "[",\n]\nmodel="claude-opus-5-5"\n[profiles.p]\nmodel = "claude-y"\n`,
  (port) => `${managedLine(port)}\nmodel = "gpt-6.1-sol"\n[t]\n${managedLine(port)}\n`,
  (port) => `${managedLine(port)}\nmodel_reasoning_effort = "high"\nmodels = "claude-not-the-key"\nmodel = "claude-opus-5-5-a2"\n`,
];

for (const [i, make] of PARITY.entries()) {
  test(`watchdog: the shell-only fail-open gives node's exact result (config ${i + 1})`, async () => {
    const results = [];
    for (const node of ['broken', 'real']) {
      await withDeadProxy((port) => ({ node, configText: make(port) }), async (w) => {
        await w.run();
        await w.run();
        results.push({ text: readFileSync(w.codexConfig, 'utf8'), swapped: w.state().swapped, auto: w.state().auto });
      });
    }
    assert.equal(results[0].text, results[1].text);
    assert.equal(results[0].swapped, results[1].swapped);
    assert.deepEqual([results[0].auto, results[1].auto], ['1', '1']);
  });
}

test('watchdog: a model the shell cannot read safely (escapes, multi-line) is left for node; the line still goes', async () => {
  await withDeadProxy((port) => ({ node: 'broken', configText: `${managedLine(port)}\nmodel = "\\u0063laude-opus-5-5"\n` }), async (w) => {
    await w.run();
    await w.run();
    assert.equal(readFileSync(w.codexConfig, 'utf8'), 'model = "\\u0063laude-opus-5-5"\n');
    assert.equal(w.state().auto, '1');
  });
});

test('watchdog: when the node command hangs, it is stopped and the script alone removes our line', async () => {
  await withDeadProxy({ node: 'hang' }, async (w, port) => {
    const before = readFileSync(w.codexConfig, 'utf8');
    await w.run();
    const t0 = Date.now();
    await w.run();
    assert.ok(Date.now() - t0 < 10_000, 'bounded');
    assert.equal(readFileSync(w.codexConfig, 'utf8'), before.replace(`${managedLine(port)}\n`, ''));
  });
});

for (const node of ['real', 'broken']) {
  test(`watchdog: text that only looks like our line inside a multi-line string is never touched (node ${node})`, async () => {
    const inner = (port) => `developer_instructions = """\nkeep this:\n${managedLine(port)}\n"""\n`;
    await withDeadProxy((port) => ({ node, configText: `${managedLine(port)}\nmodel = "gpt-6.1-sol"\n${inner(port)}` }), async (w, port) => {
      await w.run();
      await w.run();
      assert.equal(readFileSync(w.codexConfig, 'utf8'), `model = "gpt-6.1-sol"\n${inner(port)}`);
    });
  });
}

test('watchdog: paths are shell literals (no expansion, no command substitution)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcp-wd-q-'));
  const odd = { node: `${dir}/no$de \`touch ${dir}/pwned1\``, app: `${dir}/a'pp $(touch ${dir}/pwned2)`, configDir: `${dir}/c"fg $HOME`, codexConfig: `${dir}/codex $cash/config.toml` };
  const rendered = renderWatchdogScript(SOURCE, { ...odd, port: 41600, label: 'com.local-conversion-proxy.test-dummy', notify: false });
  const header = rendered.split('\n').filter((l) => /^(NODE|APP|CFG_DIR|CODEX_CFG)=/.test(l)).join('\n');
  const { stdout } = await promisify(execFile)('/bin/sh', ['-c', `${header}\nprintf '%s\\n' "$NODE" "$APP" "$CFG_DIR" "$CODEX_CFG"`], { encoding: 'utf8' });
  assert.deepEqual(stdout.split('\n').slice(0, 4), [odd.node, odd.app, odd.configDir, odd.codexConfig]);
  assert.ok(!existsSync(join(dir, 'pwned1')) && !existsSync(join(dir, 'pwned2')));
});

test('watchdog: the state file is read as data, never run as shell code', async () => {
  const ok = { value: true };
  const server = await healthServer(ok);
  const port = server.address().port;
  try {
    const marker = join(tmpdir(), `lcp-wd-pwned-${process.pid}`);
    const w = setup(port, { state: `fallback=gpt-6.1-sol\nswapped=$(touch ${marker})\nfailures=08\nhealthy=abc\nNODE=/bin/false\nauto=1;touch ${marker}\n` });
    await w.run();
    assert.ok(!existsSync(marker), 'nothing in the state file ran');
    const st = w.state();
    assert.equal(st.fallback, 'gpt-6.1-sol');
    assert.equal(st.swapped, '');
    assert.equal(st.failures, '0');
    assert.equal(st.healthy, '1');
    assert.equal(st.auto, '0');
  } finally {
    server.close();
  }
});

test('watchdog: a failing restore backs off instead of retrying every minute', async () => {
  await withDeadProxy({ restoreExit: 1 }, async (w, _port, ok) => {
    await w.run();
    await w.run(); // fail-open
    ok.value = true;
    for (let i = 0; i < 14; i += 1) await w.run();
    assert.equal(w.restoreCalls().length, 1, 'one attempt after 5 healthy checks, the next only after 10 more');
    assert.equal(w.state().restore_fail, '1');
  });
});

test('watchdog: a proxy that cannot reach OpenAI is stepped around too, and the route comes back once it can', async () => {
  await withDeadProxy({}, async (w, _port, ok) => {
    ok.value = 'unreachable';
    await w.run();
    await w.run();
    assert.ok(!readFileSync(w.codexConfig, 'utf8').includes('local-conversion-proxy'));
    assert.equal(w.state().auto, '1');
    ok.value = true;
    for (let i = 0; i < 5; i += 1) await w.run();
    assert.deepEqual(w.restoreCalls(), ['restore-after-recovery']);
  });
});

test('watchdog: an example of our line inside a string is never taken for the real one (port, restore)', async () => {
  await withDeadProxy((port) => ({ configText: `${managedLine(port)}\nmodel = "gpt-6.1-sol"\ndeveloper_instructions = """\n${managedLine(port + 1)}\n"""\n` }), async (w, _port, ok) => {
    await w.run();
    await w.run();
    assert.ok(!readFileSync(w.codexConfig, 'utf8').startsWith('openai_base_url'), 'the real line went');
    ok.value = true;
    for (let i = 0; i < 5; i += 1) await w.run();
    assert.deepEqual(w.restoreCalls(), ['restore-after-recovery'], 'the example is not our line: the proxy is checked on its real port and the restore runs');
  });
});

test('watchdog: it waits while lcp holds the lock, and a lock left by a dead process does not block it', async () => {
  await withDeadProxy({}, async (w, _port, ok) => {
    ok.value = true;
    const lock = join(w.cfgDir, 'state.lock');
    mkdirSync(lock);
    setTimeout(() => rmdirSync(lock), 1500);
    const t0 = Date.now();
    await w.run();
    assert.ok(Date.now() - t0 >= 1000, 'waited for the lock');
    assert.ok(w.state().last_check, 'then ran');
    assert.ok(!existsSync(lock), 'and released it');
    mkdirSync(lock);
    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(lock, old, old);
    await w.run();
    assert.ok(!existsSync(lock), 'a stale lock is cleared');
  });
});

test('lcp commands wait for the lock the watchdog holds', async () => {
  const { withStateLock } = await import('../src/watchdog-state.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'lcp-lock-'));
  const p = { configDir: dir };
  mkdirSync(join(dir, 'state.lock'));
  await assert.rejects(withStateLock(p, () => 1, { waitMs: 300 }), /変更中/);
  setTimeout(() => rmdirSync(join(dir, 'state.lock')), 200);
  assert.equal(await withStateLock(p, () => 42, { waitMs: 3000 }), 42);
  assert.ok(!existsSync(join(dir, 'state.lock')), 'released after use');
});

test('watchdog: a stale lock with something inside is cleared, not retried forever (fail-open still happens)', async () => {
  await withDeadProxy({}, async (w) => {
    const lock = join(w.cfgDir, 'state.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'junk'), 'x');
    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(lock, old, old);
    await w.run();
    await w.run();
    assert.ok(!readFileSync(w.codexConfig, 'utf8').includes('local-conversion-proxy'), 'failed open');
    assert.ok(!existsSync(lock));
  });
});
