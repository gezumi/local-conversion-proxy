import assert from 'node:assert/strict';
import test from 'node:test';
import { REQUIRED_CLAUDE_FLAGS, createAvailability } from '../src/availability.mjs';
import { buildCatalog } from '../src/catalog.mjs';
import { DEFAULTS } from '../src/settings.mjs';

function settingsWith(accounts) {
  const s = structuredClone(DEFAULTS);
  s.claude.accounts = accounts;
  return s;
}

/** A fake execFile for `claude --version | --help | auth status --json`. */
// The real CLI lists --system-prompt-file only as "--system-prompt[-file]".
const REAL_STYLE_HELP = REQUIRED_CLAUDE_FLAGS.map((alts) => alts.at(-1)).join('\n');

function fakeExec({ version = '2.1.285 (Claude Code)', help = REAL_STYLE_HELP, loggedIn = { 1: true, 2: false } } = {}) {
  return (bin, args, opts, cb) => {
    if (args[0] === '--version') return cb(null, version);
    if (args[0] === '--help') return cb(null, help);
    const id = opts.env.CLAUDE_CONFIG_DIR ? '2' : '1';
    cb(null, JSON.stringify({ loggedIn: loggedIn[id], authMethod: loggedIn[id] ? 'claude.ai' : 'none', apiProvider: 'firstParty', subscriptionType: 'max' }));
  };
}

const ollamaUp = async () => new Response(JSON.stringify({ models: [{ name: 'qwen3.8:27b', model: 'qwen3.8:27b' }] }), { status: 200 });
const ollamaDown = async () => {
  throw Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } });
};

test('only logged-in accounts and present local models are offered; unknown means offered', async () => {
  const s = settingsWith([{ id: '1', label: '', configDir: null }, { id: '2', label: 'サブ', configDir: '/tmp/a2' }]);
  const avail = createAvailability({ getSettings: () => s, execFileImpl: fakeExec(), fetchImpl: ollamaUp });
  // before the first check: optimistic
  assert.equal(buildCatalog(s, avail).length, 3 * 2 + 1);
  await avail.refresh();
  const slugs = buildCatalog(s, avail).map((e) => e.slug);
  assert.deepEqual(slugs, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'local-qwen3.8-27b']);
  assert.equal(avail.snapshot().claude_accounts['2'].logged_in, false);
});

test('an outdated Claude Code hides every Claude model; no Ollama hides the local model', async () => {
  const s = settingsWith([{ id: '1', label: '', configDir: null }]);
  const avail = createAvailability({ getSettings: () => s, execFileImpl: fakeExec({ version: '2.1.121 (Claude Code)', help: '--tools --mcp-config' }), fetchImpl: ollamaDown });
  await avail.refresh();
  assert.deepEqual(buildCatalog(s, avail), []);
  const snap = avail.snapshot();
  assert.equal(snap.claude_cli.ok, false);
  assert.ok(snap.claude_cli.missing_flags.includes('--effort'));
  assert.equal(snap.ollama.ok, false);
});
