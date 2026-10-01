// Contract test against the REAL Codex engine on this Mac: the model list this
// proxy serves must be accepted by Codex's own parser (a rejected entry makes
// Codex silently drop the whole list). Codex only uses a fetched model list
// when signed in with ChatGPT, so this uses the real ~/.codex sign-in (it can
// rewrite Codex's model cache, which Codex refreshes by itself). Opt-in:
//   LCP_CONTRACT=1 npm test
// `lcp install` runs the same check against the live proxy every time.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { buildCatalog, injectModels } from '../src/catalog.mjs';
import { DEFAULTS } from '../src/settings.mjs';
import { APP_CODEX_BIN } from '../src/verify.mjs';

const GPT_ENTRY = {
  slug: 'gpt-contract', display_name: 'GPT Contract', description: 'x', default_reasoning_level: 'low',
  supported_reasoning_levels: [{ effort: 'low', description: 'l' }], shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 1,
  upgrade: null, base_instructions: 'base', default_reasoning_summary: 'none', support_verbosity: false, default_verbosity: null, apply_patch_tool_type: 'freeform',
  truncation_policy: { mode: 'tokens', limit: 10000 }, supports_parallel_tool_calls: true, context_window: 272000, experimental_supported_tools: [], input_modalities: ['text', 'image'],
};

function listModels(bin, baseUrl) {
  return new Promise((resolve) => {
    const env = { ...process.env, RUST_LOG: 'codex_models_manager=debug' };
    const child = spawn(bin, ['-c', `openai_base_url="${baseUrl}"`, 'app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    const rl = createInterface({ input: child.stdout });
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const done = (r) => {
      clearTimeout(timer);
      child.kill();
      resolve({ ...r, decodeError: /failed to decode models response/.test(stderr) });
    };
    const timer = setTimeout(() => done({ slugs: null }), 45_000);
    let attempts = 0;
    rl.on('line', (line) => {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.id === 1) {
        send({ method: 'initialized' });
        setTimeout(() => send({ id: 2, method: 'model/list', params: { includeHidden: true, limit: 200, cursor: null } }), 1500);
      } else if (m.id === 2) {
        const slugs = (m.result?.data ?? []).map((x) => x.model ?? x.id);
        attempts += 1;
        if (!slugs.includes('gpt-contract') && attempts < 6) {
          setTimeout(() => send({ id: 2, method: 'model/list', params: { includeHidden: true, limit: 200, cursor: null } }), 1000);
          return;
        }
        done({ slugs });
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'lcp-contract', title: 'lcp', version: '1' } } });
  });
}

const skip = process.env.LCP_CONTRACT !== '1' ? 'set LCP_CONTRACT=1 to run against the real Codex sign-in' : !existsSync(APP_CODEX_BIN) && 'no Codex app installed';

test('the real Codex parser accepts every model entry this proxy injects', { skip }, async () => {
  const settings = structuredClone(DEFAULTS);
  settings.claude.accounts = [{ id: '1', label: '', configDir: null }, { id: '2', label: 'サブ', configDir: '/tmp/x' }];
  const catalog = buildCatalog(settings);
  const body = JSON.stringify(injectModels({ models: [GPT_ENTRY] }, catalog));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await listModels(APP_CODEX_BIN, `http://127.0.0.1:${server.address().port}`);
    assert.equal(r.decodeError, false, 'Codex could not decode the injected model list');
    assert.ok(r.slugs, 'model/list answered');
    assert.ok(r.slugs.includes('gpt-contract'), `the fetched list was used (got ${r.slugs})`);
    for (const e of catalog) assert.ok(r.slugs.includes(e.slug), `${e.slug} is listed`);
  } finally {
    server.close();
  }
});

test('the installed Claude Code CLI offers every flag the proxy uses', { skip }, async () => {
  const { execFileSync } = await import('node:child_process');
  const { missingClaudeFlags } = await import('../src/availability.mjs');
  const { defaultClaudeBin } = await import('../src/claude/config.mjs');
  const help = execFileSync(defaultClaudeBin(), ['--help'], { encoding: 'utf8' });
  assert.deepEqual(missingClaudeFlags(help), []);
});
