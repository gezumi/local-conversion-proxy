import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { configState, disableText, enableText, failOpenText, managedLine, topLevelModel, unswapText, updateConfig } from '../src/codex-config.mjs';

const SAMPLE = `model = "gpt-6.1-sol" # keep me
model_reasoning_effort = "xhigh"

[mcp_servers.x]
command = "y"
openai_base_url = "http://not-top-level"

[projects."/a"]
trust_level = "trusted"
`;

test('enable puts one line first; every other byte stays; disable restores the original exactly', () => {
  const out = enableText(SAMPLE, 41600);
  assert.equal(out, `${managedLine(41600)}\n${SAMPLE}`);
  assert.deepEqual(configState(out), { enabled: true, port: 41600, foreign: false });
  assert.equal(enableText(out, 41600), out, 'idempotent');
  const moved = enableText(out, 41700);
  assert.equal(moved.split('openai_base_url = "http://127.0.0.1').length, 2);
  assert.equal(configState(moved).port, 41700);
  assert.equal(disableText(out), SAMPLE);
  assert.equal(disableText(SAMPLE), SAMPLE);
});

test('our line is found and removed wherever it is (e.g. an older install put it before the first table)', () => {
  const old = SAMPLE.replace('\n[mcp_servers.x]', `\n${managedLine(41600)}\n[mcp_servers.x]`);
  assert.equal(configState(old).enabled, true);
  assert.equal(disableText(old), SAMPLE);
  const upgraded = enableText(old, 41600);
  assert.equal(upgraded, `${managedLine(41600)}\n${SAMPLE}`, 'moved to the top on re-enable');
});

test('multi-line strings and arrays: "[" lines inside them are not tables; a foreign top-level key after them is still seen', () => {
  const tricky = `developer_instructions = """
[重要] this line starts with a bracket
"""
args = [
  [1, 2],
  [3, 4],
]
openai_base_url = "https://example.invalid"

[t]
k = 1
`;
  assert.equal(configState(tricky).foreign, true);
  assert.throws(() => enableText(tricky, 41600), /already sets openai_base_url/);
  const benign = tricky.replace('openai_base_url = "https://example.invalid"\n', '');
  assert.equal(configState(benign).foreign, false);
  const on = enableText(benign, 41600);
  assert.ok(on.startsWith(`${managedLine(41600)}\n`), 'inserted at the very top, never inside a string or array');
  assert.equal(disableText(on), benign);
  assert.equal(configState(on).enabled, true);
});

test('a table-scoped openai_base_url is not top level', () => {
  assert.equal(configState(SAMPLE).foreign, false);
  assert.equal(configState(`openai_base_url = "https://x"\n${SAMPLE}`).foreign, true);
});

test('BOM stays first; CRLF is kept; empty and table-less files work', () => {
  const bom = `﻿model = "a"\n[t]\nk = 1\n`;
  const on = enableText(bom, 1);
  assert.ok(on.startsWith(`﻿${managedLine(1)}\n`));
  assert.equal(disableText(on), bom);
  const crlf = 'model = "a"\r\n[t]\r\nk = 1\r\n';
  assert.equal(enableText(crlf, 1), `${managedLine(1)}\r\n${crlf}`);
  assert.equal(disableText(enableText(crlf, 1)), crlf);
  assert.equal(enableText('', 3), `${managedLine(3)}\n`);
  assert.equal(enableText('model = "a"', 2), `${managedLine(2)}\nmodel = "a"`);
});

test('updateConfig: atomic, keeps mode, backs up, edits a symlinked config at its target, creates a missing one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcp-cfgtest-'));
  const cfg = join(dir, 'config.toml');
  writeFileSync(cfg, SAMPLE, { mode: 0o600 });
  const r = updateConfig(cfg, join(dir, 'backups'), (t) => enableText(t, 41600));
  assert.equal(r.changed, true);
  assert.equal(statSync(cfg).mode & 0o777, 0o600);
  assert.equal(configState(readFileSync(cfg, 'utf8')).enabled, true);
  const backups = readdirSync(join(dir, 'backups'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dir, 'backups', backups[0]), 'utf8'), SAMPLE);
  assert.equal(updateConfig(cfg, join(dir, 'backups'), (t) => enableText(t, 41600)).changed, false);

  const real = join(dir, 'real.toml');
  writeFileSync(real, SAMPLE, { mode: 0o600 });
  const link = join(dir, 'linked.toml');
  symlinkSync(real, link);
  updateConfig(link, join(dir, 'backups'), (t) => enableText(t, 41600));
  assert.ok(lstatSync(link).isSymbolicLink(), 'the symlink is kept');
  assert.equal(configState(readFileSync(real, 'utf8')).enabled, true);

  const missing = join(dir, 'sub', 'config.toml');
  updateConfig(missing, join(dir, 'backups'), (t) => enableText(t, 41600));
  assert.equal(readFileSync(missing, 'utf8'), `${managedLine(41600)}\n`);
});

test('a foreign openai_base_url is seen however the key is written, and after a comment that mentions """', () => {
  for (const line of ['"openai_base_url" = "https://x"', "'openai_base_url' = 'https://x'", 'openai_base_url="https://x"']) {
    const text = `model = "a"\n${line}\n[t]\nk = 1\n`;
    assert.equal(configState(text).foreign, true, line);
    assert.throws(() => enableText(text, 41600), /already sets openai_base_url/, line);
  }
  const commented = `# put prompts in """ blocks\nmodel = "a"\nopenai_base_url = "https://x"\n`;
  assert.equal(configState(commented).foreign, true, 'a comment never opens a string');
  const escaped = `a = "quote \\" and [bracket"\ns = """x\\""" still inside"""""\nopenai_base_url = "https://x"\n`;
  assert.equal(configState(escaped).foreign, true, 'escaped quotes and a closing run of five quotes are read right');
});

test('our line inside a multi-line string is content: never counted, moved or removed', () => {
  for (const q of ['"""', "'''"]) {
    const text = `developer_instructions = ${q}\nexample:\n${managedLine(41600)}\n${q}\nmodel = "a"\n`;
    assert.equal(configState(text).enabled, false);
    assert.equal(disableText(text), text);
    const on = enableText(text, 41600);
    assert.equal(on, `${managedLine(41600)}\n${text}`);
    assert.equal(disableText(on), text);
    assert.equal(failOpenText(on, 'gpt-6.1-sol').text, text);
  }
});

test('the default model is the root `model` only (not a table, a dotted key, or text in a string)', () => {
  assert.equal(topLevelModel('[profiles.x]\nmodel = "claude-opus-5-5"\n'), null);
  assert.equal(topLevelModel('profiles.x.model = "claude-opus-5-5"\n'), null);
  assert.equal(topLevelModel('notes = """\nmodel = "claude-opus-5-5"\n"""\n'), null);
  assert.equal(topLevelModel('a = [\n  "x]",\n  "y",\n]\nmodel = "claude-opus-5-5"\n[t]\n'), 'claude-opus-5-5');
  assert.equal(topLevelModel("﻿model='local-q'\r\n"), 'local-q');
});

test('fail-open and back: the model swap round-trips for every spelling, BOM and CRLF', () => {
  for (const line of ['model = "claude-opus-5-5"', 'model="claude-opus-5-5"', "model = 'claude-opus-5-5' # mine", '"model" = "claude-opus-5-5"']) {
    for (const wrap of [(t) => t, (t) => `﻿${t}`, (t) => t.replaceAll('\n', '\r\n')]) {
      const original = wrap(`${line}\n[t]\nk = 1\n`);
      const on = enableText(original, 41600);
      const off = failOpenText(on, 'gpt-6.1-sol');
      assert.equal(off.swapped, 'claude-opus-5-5');
      assert.equal(topLevelModel(off.text), 'gpt-6.1-sol');
      assert.equal(configState(off.text).enabled, false);
      assert.equal(unswapText(off.text, off.swapped, 'gpt-6.1-sol'), original, `${line}: byte-identical after the round trip`);
      const commented = failOpenText(on, '');
      assert.equal(topLevelModel(commented.text), null);
      assert.equal(unswapText(commented.text, 'claude-opus-5-5', ''), original);
    }
  }
  assert.deepEqual(failOpenText('model = "gpt-6.1-sol"\n', 'gpt-x'), { text: 'model = "gpt-6.1-sol"\n', swapped: '' }, 'a GPT default is left alone');
});

test('fail-open never adds a key: a model chosen meanwhile stays, and an already broken file still loses our line', () => {
  const off = failOpenText(`${managedLine(1)}\nmodel = "claude-opus-5-5"\n`, '').text;
  const chosen = `${off}model = "gpt-6.2"\n`;
  assert.equal(unswapText(chosen, 'claude-opus-5-5', ''), 'model = "gpt-6.2"\n', 'the chosen model stays; our obsolete comment goes');
  const broken = `${managedLine(1)}\nmodel = "a"\nmodel = "b"\n`;
  assert.equal(failOpenText(broken, 'gpt').text, 'model = "a"\nmodel = "b"\n');
});

test('lcp off swaps a Claude default for the recorded GPT model and remembers it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcp-off-'));
  const cfgDir = join(dir, 'cfg');
  writeFileSync(join(dir, 'config.toml'), `${managedLine(41600)}\nmodel = "claude-opus-5-5"\n[t]\nk = 1\n`);
  mkdirSync(cfgDir);
  writeFileSync(join(cfgDir, 'watchdog.state'), 'fallback=gpt-6.1-sol\n');
  const bin = fileURLToPath(new URL('../bin/lcp.mjs', import.meta.url));
  await promisify(execFile)(process.execPath, [bin, 'off'], { env: { ...process.env, LCP_CONFIG_DIR: cfgDir, CODEX_HOME: dir } });
  assert.equal(readFileSync(join(dir, 'config.toml'), 'utf8'), '# lcp-swapped: model = "claude-opus-5-5"\nmodel = "gpt-6.1-sol" # lcp-fallback\n[t]\nk = 1\n');
  const st = readFileSync(join(cfgDir, 'watchdog.state'), 'utf8');
  assert.match(st, /^swapped=claude-opus-5-5$/m);
  assert.match(st, /^manual=1$/m);
});

test('setting a model aside comments out its statement as written and adds one marked GPT line', () => {
  const on = `${managedLine(1)}\nmodel   = 'claude-opus-5-5'   # mine\n[t]\nk = 1\n`;
  const off = failOpenText(on, 'gpt-6.1-sol');
  assert.equal(off.text, `# lcp-swapped: model   = 'claude-opus-5-5'   # mine\nmodel = "gpt-6.1-sol" # lcp-fallback\n[t]\nk = 1\n`);
  assert.equal(unswapText(off.text, 'claude-opus-5-5', 'gpt-6.1-sol'), on.replace(`${managedLine(1)}\n`, ''));
});

test('unusual TOML spellings of a local default model are recognised and restored byte for byte', () => {
  const spellings = ['model = "\\u0063laude-opus-5-5"', 'model = """claude-opus-5-5"""', "model = '''\nclaude-opus-5-5'''", 'model = """\\\n   claude-opus-5-5""" # x'];
  for (const line of spellings) {
    for (const tail of ['\n[t]\nk = 1\n', '']) {
      for (const fallback of ['gpt-6.1-sol', '']) {
        const original = `${line}${tail}`;
        assert.equal(topLevelModel(original), 'claude-opus-5-5', line);
        const off = failOpenText(enableText(original, 41600), fallback);
        assert.equal(off.swapped, 'claude-opus-5-5', line);
        assert.equal(topLevelModel(off.text), fallback || null, line);
        assert.equal(unswapText(off.text, off.swapped, fallback), original, `${line} (${fallback || 'no fallback'})`);
      }
    }
  }
});

test('the set-aside model comes back even if the GPT line was removed meanwhile; a model chosen in its place stays', () => {
  const off = failOpenText(`model = "claude-opus-5-5"\n[t]\n`, 'gpt-6.1-sol').text;
  const removed = off.replace('model = "gpt-6.1-sol" # lcp-fallback\n', '');
  assert.equal(unswapText(removed, 'claude-opus-5-5', 'gpt-6.1-sol'), 'model = "claude-opus-5-5"\n[t]\n');
  const changed = off.replace('model = "gpt-6.1-sol" # lcp-fallback', 'model = "gpt-6.2" # lcp-fallback');
  assert.equal(unswapText(changed, 'claude-opus-5-5', 'gpt-6.1-sol'), 'model = "gpt-6.2" # lcp-fallback\n[t]\n', 'another model in our line: the user chose it');
  const rewritten = off.replace('model = "gpt-6.1-sol" # lcp-fallback', 'model = "gpt-6.1-sol"');
  assert.equal(unswapText(rewritten, 'claude-opus-5-5', 'gpt-6.1-sol'), 'model = "gpt-6.1-sol"\n[t]\n', 'a model line without our mark is not ours');
});

test('the recorded model is restored even when older set-aside comments are around (and those go)', () => {
  let t = enableText('model = "claude-opus-5-5"\n[t]\n', 41600);
  let off = failOpenText(t, 'gpt-6.1-sol');
  t = off.text.replace('model = "gpt-6.1-sol" # lcp-fallback', 'model = "gpt-6.2"'); // chosen while off
  t = unswapText(enableText(t, 41600), off.swapped, 'gpt-6.1-sol');
  assert.equal(t, `${managedLine(41600)}\nmodel = "gpt-6.2"\n[t]\n`);
  t = t.replace('model = "gpt-6.2"', 'model = "claude-sonnet-5-5"');
  off = failOpenText(t, 'gpt-6.1-sol');
  assert.equal(topLevelModel(unswapText(enableText(off.text, 41600), off.swapped, 'gpt-6.1-sol')), 'claude-sonnet-5-5');
  // several set-aside statements next to each other: the one for the recorded model comes back, the rest go
  const crowded = '# lcp-swapped: model = "claude-opus-5-5"\n# lcp-swapped: model = "claude-sonnet-5-5"\nmodel = "gpt-6.1-sol" # lcp-fallback\n';
  assert.equal(unswapText(crowded, 'claude-sonnet-5-5', 'gpt-6.1-sol'), 'model = "claude-sonnet-5-5"\n');
});
