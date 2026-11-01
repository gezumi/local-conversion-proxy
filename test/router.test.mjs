import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import { WebSocket } from 'ws';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODEX_HEADERS, TEST_ACCOUNT, TOOLS, parseSse, userMsg, wsClient, withProxy } from './helpers.mjs';

const base = (port) => `http://127.0.0.1:${port}`;

test('GET /models: upstream list first, local models appended, upstream wins a slug clash, auth forwarded', async () => {
  await withProxy({ upstreamOptions: { models: [{ slug: 'gpt-test', display_name: 'GPT Test' }, { slug: 'claude-sonnet-5-5', display_name: 'upstream owns this slug' }] } }, async ({ port, up }) => {
    const res = await fetch(`${base(port)}/models?client_version=9`, { headers: { authorization: 'Bearer tok', 'chatgpt-account-id': 'acct' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    const slugs = body.models.map((m) => m.slug);
    assert.equal(slugs[0], 'gpt-test');
    assert.ok(slugs.includes('claude-opus-5-5'));
    assert.ok(slugs.includes('claude-opus-5-5-a2'), 'second account gets its own slug');
    assert.ok(slugs.includes('local-qwen-test-1b'));
    assert.equal(body.models.filter((m) => m.slug === 'claude-sonnet-5-5').length, 1);
    assert.equal(body.models.find((m) => m.slug === 'claude-sonnet-5-5').display_name, 'upstream owns this slug');
    assert.equal(body.models.find((m) => m.slug === 'claude-opus-5-5-a2').display_name, 'Claude Opus 5.5 · サブ');
    const seen = up.seen.http.find((r) => r.url.startsWith('/backend-api/codex/models'));
    assert.equal(seen.url, '/backend-api/codex/models?client_version=9');
    assert.equal(seen.headers.authorization, 'Bearer tok');
    assert.equal(seen.headers['chatgpt-account-id'], 'acct');
    assert.equal(res.headers.get('x-upstream'), 'yes');
  });
});

test('other paths pass through byte for byte with method, status and headers', async () => {
  await withProxy({}, async ({ port, up }) => {
    const payload = Buffer.from([0, 1, 2, 250, 251, 252]);
    const res = await fetch(`${base(port)}/memories/trace_summarize?x=1`, { method: 'PUT', body: payload, headers: { authorization: 'Bearer t', 'x-custom': 'v' } });
    assert.equal(res.status, 207);
    assert.equal(res.headers.get('x-echo-method'), 'PUT');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), payload);
    const seen = up.seen.http.at(-1);
    assert.equal(seen.url, '/backend-api/codex/memories/trace_summarize?x=1');
    assert.equal(seen.headers['x-custom'], 'v');
  });
});

test('POST /responses for a GPT model forwards the original (compressed) bytes untouched', async () => {
  await withProxy({}, async ({ port, up }) => {
    const raw = Buffer.from(JSON.stringify({ model: 'gpt-test', input: [userMsg('hi')], stream: true }));
    const z = zlib.zstdCompressSync(raw);
    const res = await fetch(`${base(port)}/responses`, { method: 'POST', body: z, headers: { 'content-encoding': 'zstd', 'content-type': 'application/json', authorization: 'Bearer t' } });
    const events = parseSse(await res.text());
    assert.equal(events[0].response.echoBytes, z.length);
    const seen = up.seen.http.find((r) => r.url === '/backend-api/codex/responses');
    assert.deepEqual(seen.body, z);
    assert.equal(seen.headers['content-encoding'], 'zstd');
  });
});

test('POST /responses for a Claude model is served locally over SSE and never reaches upstream', async () => {
  await withProxy({ scenario: { turns: [[{ text: 'hello from fake claude' }]] } }, async ({ port, up, fake }) => {
    const body = { model: 'claude-sonnet-5-5', instructions: 'base', input: [userMsg('hi')], tools: TOOLS, stream: true, reasoning: { effort: 'xhigh' }, prompt_cache_key: 'conv-http' };
    const res = await fetch(`${base(port)}/responses`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...CODEX_HEADERS } });
    const events = parseSse(await res.text());
    const done = events.find((e) => e.type === 'response.completed');
    assert.ok(done, JSON.stringify(events.at(-1)));
    assert.equal(done.response.output[0].content[0].text, 'hello from fake claude');
    assert.ok(!up.seen.http.some((r) => r.url.includes('/responses')));
    const argv = fake.record().find((r) => r.kind === 'argv').argv;
    assert.equal(argv[argv.indexOf('--model') + 1], 'claude-sonnet-5-5');
    assert.equal(argv[argv.indexOf('--effort') + 1], 'xhigh');
    assert.equal(argv[argv.indexOf('--tools') + 1], 'ToolSearch');
  });
});

test('WebSocket: GPT messages relay both ways unchanged; Claude messages stay local; one connection can mix them', async () => {
  await withProxy({ scenario: { turns: [[{ text: 'claude says hi' }], [{ text: 'second claude turn' }]] } }, async ({ port, up }) => {
    const c = await wsClient(port);
    try {
      const g1 = await c.create({ model: 'gpt-test', input: [userMsg('one')] });
      assert.equal(g1.done.response.output[0].content[0].text, 'upstream:gpt-test');
      // upstream-only event types arrive byte-identical
      assert.ok(g1.raw.includes(JSON.stringify({ type: 'codex.rate_limits', plan: 'pro', weird: { nested: [1, 2, 3] } })));
      const sentToUp = up.seen.ws.length;
      const cl = await c.create({ model: 'claude-sonnet-5-5', instructions: 'base', input: [userMsg('two')], tools: TOOLS, prompt_cache_key: 'thread-1' });
      assert.equal(cl.done.type, 'response.completed', JSON.stringify(cl.done));
      assert.equal(cl.done.response.output[0].content[0].text, 'claude says hi');
      assert.equal(up.seen.ws.length, sentToUp, 'the Claude request did not go upstream');
      const g2 = await c.create({ model: 'gpt-test', input: [userMsg('three')] });
      assert.equal(g2.done.response.output[0].content[0].text, 'upstream:gpt-test');
      // the exact client text reached upstream
      assert.equal(JSON.parse(up.seen.ws.at(-1)).input[0].content[0].text, 'three');
      // handshake headers (auth, thread) were forwarded upstream
      assert.equal(up.seen.wsHeaders[0].authorization, CODEX_HEADERS.authorization);
      assert.equal(up.seen.wsHeaders[0]['thread-id'], 'thread-1');
    } finally {
      c.close();
    }
  });
});

test('WebSocket: non-JSON and binary frames go upstream untouched', async () => {
  await withProxy({}, async ({ port }) => {
    const c = await wsClient(port);
    try {
      c.ws.send('not json');
      c.ws.send(Buffer.from([9, 8, 7]), { binary: true });
      const deadline = Date.now() + 3000;
      while (c.frames.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.equal(c.frames[0].data.toString(), 'echo:not json');
      assert.equal(c.frames[1].isBinary, true);
      assert.deepEqual([...c.frames[1].data], [9, 8, 7]);
    } finally {
      c.close();
    }
  });
});

test('WebSocket: an upstream handshake rejection (e.g. 401) is mirrored to Codex', async () => {
  await withProxy({ upstreamOptions: { wsReject: 401 } }, async ({ port }) => {
    await assert.rejects(wsClient(port), (err) => err.status === 401 && err.headers['x-reason'] === 'test');
  });
});

test('upstream unreachable: the WebSocket is refused (Codex falls back to HTTP) and local models still work over HTTP', async () => {
  await withProxy({ upstreamUrl: 'http://127.0.0.1:9/backend-api/codex', scenario: { turns: [[{ text: 'offline ok' }]] } }, async ({ port }) => {
    await assert.rejects(wsClient(port), (err) => err.status === 502);
    const body = { model: 'claude-opus-5-5', instructions: 'b', input: [userMsg('hi')], tools: TOOLS, stream: true };
    const res = await fetch(`${base(port)}/responses`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...CODEX_HEADERS } });
    const done = parseSse(await res.text()).find((e) => e.type === 'response.completed');
    assert.equal(done.response.output[0].content[0].text, 'offline ok');
  });
});

test('requests with an Origin header or a foreign Host are refused (no browser access)', async () => {
  await withProxy({}, async ({ port }) => {
    const r1 = await fetch(`${base(port)}/models`, { headers: { origin: 'https://evil.example' } });
    assert.equal(r1.status, 403);
    await assert.rejects(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/responses`, { headers: { origin: 'https://evil.example' } });
        ws.once('open', resolve);
        ws.once('error', reject);
      }),
    );
  });
});

test('Claude over WebSocket: prewarm, chained first turn, tool call round trip, no restart between turns', async () => {
  const scenario = { turns: [[{ call: { title: 'exec_command', args: { cmd: 'echo hi' } } }, { echoLast: true }], [{ text: 'turn two' }]] };
  await withProxy({ scenario }, async ({ port, logLines }) => {
    const c = await wsClient(port);
    try {
      const dev = { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'per-turn reminder' }] };
      const pre = await c.create({ model: 'claude-opus-5-5', generate: false, instructions: 'b', input: [], tools: TOOLS, prompt_cache_key: 'th' });
      assert.equal(pre.done.type, 'response.completed');
      const r1 = await c.create({ model: 'claude-opus-5-5', previous_response_id: pre.done.response.id, instructions: 'b', input: [userMsg('run it'), dev], tools: TOOLS, prompt_cache_key: 'th' });
      assert.equal(r1.done.type, 'response.completed', JSON.stringify(r1.done));
      const call = r1.done.response.output.find((o) => o.type === 'function_call');
      assert.equal(call.name, 'exec_command');
      assert.deepEqual(JSON.parse(call.arguments), { cmd: 'echo hi' });
      const r2 = await c.create({ model: 'claude-opus-5-5', previous_response_id: r1.done.response.id, instructions: 'b', input: [{ type: 'function_call_output', call_id: call.call_id, output: 'hi\n' }], tools: TOOLS, prompt_cache_key: 'th' });
      assert.match(r2.done.response.output[0].content[0].text, /result: hi/);
      // next user turn repeats the same developer reminder: same process, no restart
      const r3 = await c.create({ model: 'claude-opus-5-5', previous_response_id: r2.done.response.id, instructions: 'b', input: [userMsg('again'), dev], tools: TOOLS, prompt_cache_key: 'th' });
      assert.equal(r3.done.response.output[0].content[0].text, 'turn two');
      assert.equal(logLines.filter((l) => l.ev === 'session_start').length, 1);
      assert.equal(logLines.filter((l) => l.ev === 'session_respawn').length, 0);
      assert.equal(logLines.filter((l) => l.ev === 'claude_response_failed').length, 0);
    } finally {
      c.close();
    }
  });
});

test('Claude: text streams as deltas once (no duplicate from the final message)', async () => {
  await withProxy({ scenario: { turns: [[{ text: 'abcdef' }, { text: 'ghij' }]] } }, async ({ port }) => {
    const c = await wsClient(port);
    try {
      const r = await c.create({ model: 'claude-sonnet-5-5', instructions: 'b', input: [userMsg('x')], tools: TOOLS });
      const deltas = r.events.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta);
      assert.ok(deltas.length >= 3, 'streamed in pieces');
      assert.equal(r.done.response.output[0].content[0].text, 'abcdef\n\nghij');
    } finally {
      c.close();
    }
  });
});

test('Claude: a second account runs with its own CLAUDE_CONFIG_DIR', async () => {
  await withProxy({ scenario: { turns: [[{ text: 'acct2' }]] } }, async ({ port, fake, cfgDir }) => {
    const c = await wsClient(port);
    try {
      const r = await c.create({ model: 'claude-opus-5-5-a2', instructions: 'b', input: [userMsg('x')], tools: TOOLS });
      assert.equal(r.done.response.output[0].content[0].text, 'acct2');
      const argvRec = fake.record().find((x) => x.kind === 'argv');
      assert.ok(argvRec.envKeys.includes('CLAUDE_CONFIG_DIR'));
      assert.equal(argvRec.argv[argvRec.argv.indexOf('--model') + 1], 'claude-opus-5-5');
      assert.ok(cfgDir);
    } finally {
      c.close();
    }
  });
});

test('Claude: a logged-out account fails with a readable message, not a crash', async () => {
  await withProxy({ fakeEnv: { FAKE_AUTH: JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }) } }, async ({ port }) => {
    const c = await wsClient(port);
    try {
      const r = await c.create({ model: 'claude-opus-5-5', instructions: 'b', input: [userMsg('x')], tools: TOOLS });
      assert.equal(r.done.type, 'response.failed');
      assert.equal(r.done.response.error.lcp_code, 'claude_auth');
      assert.match(r.done.response.error.message, /lcp account login/);
    } finally {
      c.close();
    }
  });
});

test('Claude: usage-limit text from the CLI becomes a clear limit error', async () => {
  await withProxy({ scenario: { turns: [[{ synthetic: true }]] } }, async ({ port }) => {
    const c = await wsClient(port);
    try {
      const r = await c.create({ model: 'claude-opus-5-5', instructions: 'b', input: [userMsg('x')], tools: TOOLS });
      assert.equal(r.done.type, 'response.failed');
      assert.ok(['claude_error', 'claude_usage_limit'].includes(r.done.response.error.lcp_code));
      assert.ok(!JSON.stringify(r.done).includes('secret-detail'), 'CLI error text is not leaked');
    } finally {
      c.close();
    }
  });
});

test('Claude: GPT history items (reasoning, additional_tools, unknown kinds) do not break a switch to Claude', async () => {
  await withProxy({ scenario: { turns: [[{ echoPrompt: true }]] } }, async ({ port }) => {
    const c = await wsClient(port);
    try {
      const input = [
        { type: 'additional_tools', tools: [{ type: 'function', name: 'x' }] },
        userMsg('first question'),
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'gpt answer' }] },
        { type: 'local_shell_call', id: 'x', call_id: 'c', action: {} },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'now claude' }, { type: 'input_file', file_id: 'f' }] },
      ];
      const r = await c.create({ model: 'claude-sonnet-5-5', instructions: 'b', input, tools: TOOLS });
      assert.equal(r.done.type, 'response.completed', JSON.stringify(r.done));
      const text = r.done.response.output[0].content[0].text;
      assert.match(text, /first question/);
      assert.match(text, /gpt answer/);
      assert.match(text, /now claude/);
    } finally {
      c.close();
    }
  });
});

test('compaction: Claude returns one compaction item; it feeds Claude later and reaches OpenAI only as plain text', async () => {
  const scenario = { processes: [{ turns: [[{ text: 'NOTED' }], [{ text: 'SUMMARY: codename BLUE-HERON-42' }]] }, { turns: [[{ echoPrompt: true }]] }] };
  await withProxy({ scenario }, async ({ port, up }) => {
    const c = await wsClient(port);
    try {
      const r1 = await c.create({ model: 'claude-sonnet-5-5', instructions: 'b', input: [userMsg('remember BLUE-HERON-42')], tools: TOOLS, prompt_cache_key: 'tc' });
      const comp = await c.create({ model: 'claude-sonnet-5-5', previous_response_id: r1.done.response.id, instructions: 'b', input: [{ type: 'compaction_trigger' }], tools: TOOLS, prompt_cache_key: 'tc' });
      assert.equal(comp.done.type, 'response.completed', JSON.stringify(comp.done));
      const items = comp.done.response.output;
      assert.equal(items.length, 1);
      assert.equal(items[0].type, 'compaction');
      assert.ok(items[0].encrypted_content.startsWith('lcp-compaction:v1:'));
      // Codex then sends the compacted history: Claude sees the summary text
      const after = await c.create({ model: 'claude-sonnet-5-5', instructions: 'b', input: [items[0], userMsg('what was it?')], tools: TOOLS, prompt_cache_key: 'tc' });
      assert.match(after.done.response.output[0].content[0].text, /SUMMARY: codename BLUE-HERON-42/);
      // and OpenAI gets the same summary as a plain message, never our item
      await c.create({ model: 'gpt-test', input: [items[0], userMsg('and now gpt')] });
      const sent = JSON.parse(up.seen.ws.at(-1));
      assert.equal(sent.input[0].type, 'message');
      assert.match(sent.input[0].content[0].text, /SUMMARY: codename BLUE-HERON-42/);
      assert.ok(!up.seen.ws.at(-1).includes('lcp-compaction'));
    } finally {
      c.close();
    }
  });
});

test('compaction without a live session fails cleanly (Codex keeps the full history)', async () => {
  await withProxy({}, async ({ port }) => {
    const c = await wsClient(port);
    try {
      const r = await c.create({ model: 'claude-opus-5-5', previous_response_id: 'resp_gone', input: [{ type: 'compaction_trigger' }], tools: TOOLS });
      assert.equal(r.done.type, 'response.failed');
    } finally {
      c.close();
    }
  });
});

test('an unrecognised /models shape passes through untouched', async () => {
  const { injectModels } = await import('../src/catalog.mjs');
  const odd = { data: [{ id: 'gpt-x' }] };
  assert.equal(injectModels(odd, [{ slug: 'claude-opus-5-5', info: {} }]), odd);
  assert.equal(injectModels(null, []), null);
});

for (const enc of ['gzip', 'zstd', 'br']) {
  test(`GET /models: a ${enc}-compressed upstream list still gets the local models`, async () => {
    await withProxy({ upstreamOptions: { modelsEncoding: enc } }, async ({ port }) => {
      const res = await fetch(`${base(port)}/models`, { headers: { 'accept-encoding': 'gzip, br, zstd' } });
      const body = await res.json();
      assert.ok(body.models.some((m) => m.slug === 'gpt-test'));
      assert.ok(body.models.some((m) => m.slug === 'claude-opus-5-5'));
    });
  });
}

test('GET /models: an unparseable compressed body is passed through with its own encoding', async () => {
  await withProxy({ upstreamOptions: { modelsEncoding: 'gzip', modelsRaw: 'not json at all' } }, async ({ port }) => {
    const res = await fetch(`${base(port)}/models`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(res.headers.get('content-encoding'), 'gzip');
    assert.equal(await res.text(), 'not json at all'); // fetch decoded it: headers and bytes were consistent
  });
});

test('health reports responses still streaming, and zero once they finish (used to delay updates)', async () => {
  await withProxy({ upstreamOptions: { wsCompleteDelayMs: 700 } }, async ({ port }) => {
    const c = await wsClient(port);
    try {
      const pending = c.create({ model: 'gpt-test', input: [userMsg('slow')] });
      await new Promise((r) => setTimeout(r, 250));
      const mid = await (await fetch(`${base(port)}/healthz`)).json();
      assert.equal(mid.inflight, 1);
      await pending;
      const after = await (await fetch(`${base(port)}/healthz`)).json();
      assert.equal(after.inflight, 0);
    } finally {
      c.close();
    }
  });
});

test('odd WebSocket URLs (fragment, query) never take the proxy down', async () => {
  await withProxy({}, async ({ port }) => {
    for (const path of ['/responses?#x', '/responses#frag', '/responses?a=%ZZ']) {
      try {
        const c = await wsClient(port, {}, path);
        c.close();
      } catch {
        // refusing is fine; crashing is not
      }
    }
    const h = await (await fetch(`${base(port)}/healthz`)).json();
    assert.equal(h.ok, true);
    const c = await wsClient(port);
    try {
      const g = await c.create({ model: 'gpt-test', input: [userMsg('still alive')] });
      assert.equal(g.done.type, 'response.completed');
    } finally {
      c.close();
    }
  });
});

test('a wrong type in settings.json cannot break GPT', async () => {
  await withProxy({ rawSettings: JSON.stringify({ ollama: { models: { id: 'x' } }, claude: { models: 'nope', accounts: 5 }, port: 'x' }) }, async ({ port }) => {
    const h = await fetch(`${base(port)}/healthz`);
    assert.equal(h.status, 200);
    const c = await wsClient(port);
    try {
      const g = await c.create({ model: 'gpt-test', input: [userMsg('gpt fine')] });
      assert.equal(g.done.response.output[0].content[0].text, 'upstream:gpt-test');
    } finally {
      c.close();
    }
    const m = await (await fetch(`${base(port)}/models`)).json();
    assert.ok(m.models.some((x) => x.slug === 'gpt-test'));
  });
});

test('a configured Claude model that is temporarily unavailable is answered locally, never sent to OpenAI', async () => {
  const hideAll = { claudeAccount: () => false, ollamaModel: () => false, start() {}, stop() {}, refresh() {}, snapshot: () => ({}) };
  await withProxy({ availability: hideAll, fakeEnv: { FAKE_AUTH: JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }) } }, async ({ port, up }) => {
    const listed = await (await fetch(`${base(port)}/models`)).json();
    assert.ok(!listed.models.some((x) => x.slug === 'claude-opus-5-5'), 'not listed while unavailable');
    const c = await wsClient(port);
    try {
      const before = up.seen.ws.length;
      const r = await c.create({ model: 'claude-opus-5-5', instructions: 'b', input: [userMsg('private conversation')], tools: TOOLS });
      assert.equal(r.done.type, 'response.failed');
      assert.equal(up.seen.ws.length, before, 'nothing reached OpenAI');
      assert.ok(!up.seen.ws.some((m) => m.includes('private conversation')));
    } finally {
      c.close();
    }
  });
});

test('other WebSocket paths are relayed to OpenAI untouched (e.g. realtime)', async () => {
  await withProxy({}, async ({ port, up }) => {
    const c = await wsClient(port, {}, '/realtime?model=x');
    try {
      c.ws.send(JSON.stringify({ type: 'response.create', model: 'claude-opus-5-5' }));
      const deadline = Date.now() + 3000;
      while (!c.frames.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.ok(up.seen.ws.length >= 1, 'reached upstream even with a local model name: not a Responses socket');
    } finally {
      c.close();
    }
  });
});

test('Esc on a Claude turn (response.interrupt) stops it locally and ends the response normally', async () => {
  await withProxy({ scenario: { turns: [[{ text: 'partial answer' }, { hang: true }]] } }, async ({ port, up }) => {
    const c = await wsClient(port);
    try {
      c.ws.send(JSON.stringify({ type: 'response.create', model: 'claude-opus-5-5', instructions: 'b', input: [userMsg('long task')], tools: TOOLS }));
      let created = null;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const evs = c.frames.map((f) => JSON.parse(f.data.toString()));
        created = evs.find((e) => e.type === 'response.created');
        if (created && evs.some((e) => e.type === 'response.output_text.delta')) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const before = up.seen.ws.length;
      c.ws.send(JSON.stringify({ type: 'response.interrupt', response_id: created.response.id, discard_partial_items: false }));
      let done = null;
      while (!done && Date.now() < deadline + 5000) {
        done = c.frames.map((f) => JSON.parse(f.data.toString())).find((e) => e.type === 'response.completed' || e.type === 'response.failed');
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(done?.type, 'response.completed');
      assert.match(done.response.output[0]?.content?.[0]?.text ?? '', /partial answer/);
      assert.equal(up.seen.ws.length, before, 'the interrupt was not sent to OpenAI');
    } finally {
      c.close();
    }
  });
});

const postJson = (port, body, headers = CODEX_HEADERS) => fetch(`${base(port)}/responses`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
const upstreamResponses = (up) => up.seen.http.filter((r) => r.url.startsWith('/backend-api/codex/responses')).length + up.seen.ws.filter((m) => m.includes('response.create')).length;

test('local models serve only this Mac\'s own Codex sign-in: forged tokens and other accounts are refused', async () => {
  await withProxy({ scenario: { turns: [[{ text: 'owner ok' }]] } }, async ({ port, up }) => {
    const ask = async (headers, key) => parseSse(await (await postJson(port, { model: 'claude-opus-5-5', input: [userMsg('x')], prompt_cache_key: key }, headers)).text()).at(-1);
    for (const [i, headers] of [
      { authorization: 'Bearer some-forged-token-0123456789', 'chatgpt-account-id': TEST_ACCOUNT }, // a made-up token with the right account
      { authorization: CODEX_HEADERS.authorization, 'chatgpt-account-id': 'someone-else' }, // the right token for another account
      { authorization: 'Bearer some-forged-token-0123456789' },
      {},
    ].entries()) {
      const last = await ask(headers, `k${i}`);
      assert.equal(last.type, 'response.failed');
      assert.equal(last.response.error.lcp_code, 'forbidden');
    }
    const ok = await ask(CODEX_HEADERS, 'k-owner');
    assert.equal(ok.type, 'response.completed', JSON.stringify(ok));
    const c = await wsClient(port, { authorization: 'Bearer some-forged-token-0123456789' });
    try {
      const r = await c.create({ model: 'claude-opus-5-5', input: [userMsg('x')] });
      assert.equal(r.done.type, 'response.failed');
      assert.equal(r.done.response.error.lcp_code, 'forbidden');
      const g = await c.create({ model: 'gpt-test', input: [userMsg('gpt is just relayed')] });
      assert.equal(g.done.type, 'response.completed');
    } finally {
      c.close();
    }
    assert.equal(up.seen.http.filter((r) => r.url.startsWith('/backend-api/codex/responses')).length, 0, 'no refused request went to OpenAI');
  });
});

test('without Codex credentials in auth.json, nobody may use the local models (GPT unaffected)', async () => {
  await withProxy({ auth: null }, async ({ port }) => {
    const last = parseSse(await (await postJson(port, { model: 'claude-opus-5-5', input: [userMsg('x')] })).text()).at(-1);
    assert.equal(last.response.error.lcp_code, 'forbidden');
    const g = parseSse(await (await postJson(port, { model: 'gpt-test', input: [userMsg('x')] })).text()).at(-1);
    assert.equal(g.type, 'response.completed');
  });
});

test('after Codex refreshes its token, an open socket keeps working and the new token is accepted', async () => {
  await withProxy({ scenario: { turns: [[{ text: 'still mine' }]] } }, async ({ port, codexHome }) => {
    const c = await wsClient(port);
    try {
      writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'chatgpt-token-refreshed-0123456789', account_id: TEST_ACCOUNT } }));
      const r = await c.create({ model: 'claude-opus-5-5', input: [userMsg('x')] });
      assert.equal(r.done.type, 'response.completed', JSON.stringify(r.done));
    } finally {
      c.close();
    }
    const fresh = parseSse(await (await postJson(port, { model: 'claude-opus-5-5', input: [userMsg('y')], prompt_cache_key: 'k2' }, { authorization: 'Bearer chatgpt-token-refreshed-0123456789', 'chatgpt-account-id': TEST_ACCOUNT })).text()).at(-1);
    assert.equal(fresh.type, 'response.completed', JSON.stringify(fresh));
    const stale = parseSse(await (await postJson(port, { model: 'claude-opus-5-5', input: [userMsg('z')], prompt_cache_key: 'k3' })).text()).at(-1);
    assert.equal(stale.response.error.lcp_code, 'forbidden', 'the replaced token no longer opens new requests');
  });
});

test('turned-off and removed local models are refused here: their conversation never goes to OpenAI', async () => {
  const settings = { claude: { accounts: [{ id: '1' }, { id: '2', label: 'サブ', disabled: true }] }, ollama: { enabled: false, models: [{ id: 'qwen-test:1b', name: 'Qwen Test', contextWindow: 8192 }] } };
  await withProxy({ settings }, async ({ port, up }) => {
    const listed = (await (await fetch(`${base(port)}/models`, { headers: CODEX_HEADERS })).json()).models.map((m) => m.slug);
    assert.ok(!listed.includes('claude-opus-5-5-a2') && !listed.includes('local-qwen-test-1b'), 'not listed');
    for (const [model, code] of [
      ['claude-opus-5-5-a2', 'model_disabled'],
      ['local-qwen-test-1b', 'model_disabled'],
      ['claude-opus-5-5-a7', 'model_not_configured'],
      ['local-removed-model', 'model_not_configured'],
    ]) {
      const last = parseSse(await (await postJson(port, { model, input: [userMsg('private conversation')] })).text()).at(-1);
      assert.equal(last.type, 'response.failed', model);
      assert.equal(last.response.error.lcp_code, code, model);
    }
    const c = await wsClient(port);
    try {
      const r = await c.create({ model: 'claude-opus-5-5-a2', input: [userMsg('private conversation')] });
      assert.equal(r.done.response.error.lcp_code, 'model_disabled');
    } finally {
      c.close();
    }
    const compact = await fetch(`${base(port)}/responses/compact`, { method: 'POST', body: JSON.stringify({ model: 'claude-opus-5-5-a2', input: [] }), headers: { 'content-type': 'application/json', ...CODEX_HEADERS } });
    assert.equal(compact.status, 400);
    assert.equal(upstreamResponses(up), 0, 'nothing went upstream');
  });
});

test('a slug that OpenAI\'s own model list has is routed to OpenAI, as it is listed', async () => {
  await withProxy({ upstreamOptions: { models: [{ slug: 'gpt-test' }, { slug: 'claude-sonnet-5-5', display_name: 'upstream owns this slug' }] } }, async ({ port, up }) => {
    await (await fetch(`${base(port)}/models`, { headers: CODEX_HEADERS })).json();
    const last = parseSse(await (await postJson(port, { model: 'claude-sonnet-5-5', input: [userMsg('x')] })).text()).at(-1);
    assert.equal(last.response.id, 'resp_up', 'answered by the upstream');
    const c = await wsClient(port);
    try {
      const r = await c.create({ model: 'claude-sonnet-5-5', input: [userMsg('x')] });
      assert.match(r.done.response.output[0].content[0].text, /^upstream:/);
    } finally {
      c.close();
    }
    assert.equal(upstreamResponses(up), 2);
  });
});

test('a request turned away as busy does not kill the conversation another request is using', async () => {
  await withProxy({ scenario: { turns: [[{ text: 'first part' }, { sleepMs: 1500 }, { text: ' and the rest' }]] } }, async ({ port }) => {
    const body = { model: 'claude-opus-5-5', instructions: 'b', input: [userMsg('long task')], prompt_cache_key: 'busy-conv' };
    const first = postJson(port, body).then(async (r) => parseSse(await r.text()));
    await new Promise((r) => setTimeout(r, 700));
    const second = parseSse(await (await postJson(port, body)).text()).at(-1);
    assert.equal(second.type, 'response.failed');
    assert.equal(second.response.error.lcp_code, 'session_busy');
    const done = (await first).at(-1);
    assert.equal(done.type, 'response.completed', JSON.stringify(done));
    assert.match(done.response.output[0].content[0].text, /^first part\s+and the rest$/);
  });
});

test('a local HTTP response counts as in flight until it ends (updates wait for it)', async () => {
  await withProxy({ scenario: { turns: [[{ text: 'slow' }, { sleepMs: 1200 }]] } }, async ({ port }) => {
    const pending = postJson(port, { model: 'claude-opus-5-5', input: [userMsg('x')], prompt_cache_key: 'slow' }).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 600));
    assert.ok((await (await fetch(`${base(port)}/healthz`)).json()).inflight >= 1);
    await pending;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await (await fetch(`${base(port)}/healthz`)).json()).inflight, 0);
  });
});

test('a compressed rejection of the WebSocket upgrade reaches Codex with its encoding', async () => {
  await withProxy({ upstreamOptions: { wsReject: 403, wsRejectEncoding: 'gzip' } }, async ({ port }) => {
    const res = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/responses`, { headers: CODEX_HEADERS });
      ws.once('unexpected-response', (_r, r) => resolve(r));
      ws.once('open', () => reject(new Error('should not open')));
      ws.once('error', () => {});
    });
    const chunks = [];
    for await (const c of res) chunks.push(c);
    assert.equal(res.statusCode, 403);
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.equal(zlib.gunzipSync(Buffer.concat(chunks)).toString('utf8'), '{"error":"no"}\n');
  });
});

test('a summary is reused only for the same earlier part: changed tool results are summarized again', async () => {
  await withProxy({ scenario: { turns: [[{ echoPrompt: true }]] } }, async ({ port, fake }) => {
    const summaries = () => fake.record().filter((x) => x.kind === 'summary_request').length;
    const run = async (input, key) => {
      const c = await wsClient(port, { 'thread-id': key });
      try {
        const r = await c.create({ model: 'claude-opus-5-5', instructions: 'b', input, tools: TOOLS, prompt_cache_key: key });
        assert.equal(r.done.type, 'response.completed', JSON.stringify(r.done));
      } finally {
        c.close();
      }
    };
    const history = longHistory();
    await run(history, 's1');
    assert.equal(summaries(), 1);
    await run(longHistory(), 's2');
    assert.equal(summaries(), 1, 'the same earlier part: cached');
    const corrected = longHistory();
    corrected[2] = { ...corrected[2], output: `corrected output `.repeat(2000) };
    await run(corrected, 's3');
    assert.equal(summaries(), 2, 'a changed tool result in the earlier part: summarized again');
  });
});

test('a dead reused keep-alive socket is retried once (no 502 for GPT)', async () => {
  const http = await import('node:http');
  let n = 0;
  const server = http.createServer((req, res) => {
    n += 1;
    if (n === 2) return req.socket.destroy(); // the reused socket dies
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ n }));
  });
  server.keepAliveTimeout = 60_000;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await withProxy({ upstreamUrl: `http://127.0.0.1:${server.address().port}/backend-api/codex` }, async ({ port }) => {
      const a = await fetch(`${base(port)}/some/path`);
      assert.equal(a.status, 200);
      const b = await fetch(`${base(port)}/some/path`);
      assert.equal(b.status, 200, 'retried on a fresh socket');
      assert.equal((await b.json()).n, 3);
    });
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('at capacity, a conversation abandoned mid tool call is evicted instead of refusing new ones', async () => {
  const scenario = { processes: [{ turns: [[{ call: { title: 'exec_command', args: { cmd: 'ls' } } }]] }, { turns: [[{ text: 'second conversation' }]] }] };
  await withProxy({ scenario, settings: { limits: { maxSessions: 1, staleAwaitingMs: 0 } } }, async ({ port }) => {
    const a = await wsClient(port, { 'thread-id': 'abandoned' });
    const b = await wsClient(port, { 'thread-id': 'fresh' });
    try {
      const r1 = await a.create({ model: 'claude-opus-5-5', instructions: 'b', input: [userMsg('run ls')], tools: TOOLS, prompt_cache_key: 'abandoned' });
      assert.ok(r1.done.response.output.some((o) => o.type === 'function_call'), 'first conversation now waits on a tool output');
      await new Promise((r) => setTimeout(r, 20));
      const r2 = await b.create({ model: 'claude-opus-5-5', instructions: 'b', input: [userMsg('hello')], tools: TOOLS, prompt_cache_key: 'fresh' });
      assert.equal(r2.done.type, 'response.completed', JSON.stringify(r2.done));
      assert.equal(r2.done.response.output[0].content[0].text, 'second conversation');
    } finally {
      a.close();
      b.close();
    }
  });
});

test('after Esc, the next turn chained to the interrupted response continues the conversation', async () => {
  const scenario = { processes: [{ turns: [[{ text: 'partial' }, { hang: true }]] }, { turns: [[{ echoPrompt: true }]] }] };
  await withProxy({ scenario }, async ({ port }) => {
    const c = await wsClient(port);
    try {
      c.ws.send(JSON.stringify({ type: 'response.create', model: 'claude-opus-5-5', instructions: 'b', input: [userMsg('first ask')], tools: TOOLS, prompt_cache_key: 'chain' }));
      const deadline = Date.now() + 5000;
      let created = null;
      while (Date.now() < deadline) {
        const evs = c.frames.map((f) => JSON.parse(f.data.toString()));
        created = evs.find((e) => e.type === 'response.created');
        if (created && evs.some((e) => e.type === 'response.output_text.delta')) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      c.ws.send(JSON.stringify({ type: 'response.interrupt', response_id: created.response.id }));
      while (!c.frames.map((f) => JSON.parse(f.data.toString())).some((e) => e.type === 'response.completed') && Date.now() < deadline + 5000) await new Promise((r) => setTimeout(r, 20));
      const next = await c.create({ model: 'claude-opus-5-5', previous_response_id: created.response.id, instructions: 'b', input: [userMsg('second ask')], tools: TOOLS, prompt_cache_key: 'chain' });
      assert.equal(next.done.type, 'response.completed', JSON.stringify(next.done));
      const text = next.done.response.output[0].content[0].text;
      assert.match(text, /first ask/);
      assert.match(text, /partial/);
      assert.match(text, /second ask/);
    } finally {
      c.close();
    }
  });
});

test('an expired Claude login mid-use is reported as a login problem, without leaking the CLI text', async () => {
  await withProxy({ scenario: { turns: [[{ errorResult: 'Failed to authenticate: OAuth session expired and could not be refreshed' }]] } }, async ({ port }) => {
    const c = await wsClient(port);
    try {
      const r = await c.create({ model: 'claude-opus-5-5', instructions: 'b', input: [userMsg('x')], tools: TOOLS });
      assert.equal(r.done.type, 'response.failed');
      assert.equal(r.done.response.error.lcp_code, 'claude_auth');
      assert.match(r.done.response.error.message, /lcp account login/);
      assert.ok(!JSON.stringify(r.done).includes('OAuth session'));
    } finally {
      c.close();
    }
  });
});

test('a thread whose history has results without call_id (seen in real Codex threads) works with Claude', async () => {
  await withProxy({ scenario: { turns: [[{ echoPrompt: true }]] } }, async ({ port }) => {
    const c = await wsClient(port);
    try {
      const input = [
        userMsg('book work'),
        { type: 'function_call_output', id: 'x1', name: 'send', namespace: 'agents', output: 'chapter 3 done' },
        { type: 'agent_message', id: 'a1', author: 'worker', recipient: 'main', content: [{ type: 'input_text', text: 'page 28 ready' }] },
        userMsg('continue'),
      ];
      const r = await c.create({ model: 'claude-opus-5-5', instructions: 'b', input, tools: TOOLS });
      assert.equal(r.done.type, 'response.completed', JSON.stringify(r.done));
      assert.match(r.done.response.output[0].content[0].text, /chapter 3 done/);
      assert.match(r.done.response.output[0].content[0].text, /page 28 ready/);
    } finally {
      c.close();
    }
  });
});

function longHistory() {
  const input = [userMsg('the very first request')];
  for (let i = 0; i < 300; i += 1) {
    input.push({ type: 'function_call', call_id: `c${i}`, name: 'exec_command', arguments: `{"cmd":"step ${i}"}` });
    input.push({ type: 'function_call_output', call_id: `c${i}`, output: `output ${i} `.repeat(2000) });
  }
  input.push(userMsg('the latest question'));
  return input;
}

test('a long conversation switched to Claude: the earlier part is summarized first, then the recent part goes verbatim', async () => {
  await withProxy({ scenario: { turns: [[{ echoPrompt: true }]] } }, async ({ port, fake, logLines }) => {
    const c = await wsClient(port);
    try {
      const r = await c.create({ model: 'claude-opus-5-5', instructions: 'b', input: longHistory(), tools: TOOLS });
      assert.equal(r.done.type, 'response.completed', JSON.stringify(r.done));
      const text = r.done.response.output[0].content[0].text;
      assert.match(text, /FAKE SUMMARY/);
      assert.match(text, /the latest question/);
      const req = fake.record().find((x) => x.kind === 'summary_request');
      assert.ok(req, 'the summarizer ran');
      assert.equal(req.mentionsFirst, true, 'it saw the earliest part');
      assert.equal(req.model, 'claude-sonnet-5-5');
      assert.ok(logLines.some((l) => l.ev === 'replay_summarized'));
    } finally {
      c.close();
    }
  });
});

test('if the summary cannot be made, the replay still works and says what was left out', async () => {
  await withProxy({ scenario: { turns: [[{ echoPrompt: true }]] }, fakeEnv: { FAKE_SUMMARY_FAIL: '1' } }, async ({ port, logLines }) => {
    const c = await wsClient(port);
    try {
      const r = await c.create({ model: 'claude-opus-5-5', instructions: 'b', input: longHistory(), tools: TOOLS });
      assert.equal(r.done.type, 'response.completed', JSON.stringify(r.done));
      const text = r.done.response.output[0].content[0].text;
      assert.match(text, /were left out/);
      assert.ok(logLines.some((l) => l.ev === 'replay_summary_failed'));
    } finally {
      c.close();
    }
  });
});

/** Wait until `pred` holds for one of the socket's events (or for the record). */
async function until(pred, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}
const eventsOf = (c) => c.frames.filter((f) => !f.isBinary).map((f) => JSON.parse(f.data.toString()));

test('GPT compaction (/responses/compact) gets our compaction summaries as plain text, like every request to OpenAI', async () => {
  const { makeCompactionItem } = await import('../src/compaction.mjs');
  await withProxy({}, async ({ port, up }) => {
    const body = { model: 'gpt-test', input: [makeCompactionItem('SUMMARY OF THE CLAUDE PART', 'claude-opus-5-5'), userMsg('next')] };
    await (await fetch(`${base(port)}/responses/compact`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...CODEX_HEADERS } })).text();
    const seen = up.seen.http.find((r) => r.url === '/backend-api/codex/responses/compact');
    const sent = seen.body.toString('utf8');
    assert.ok(!sent.includes('lcp-compaction:v1:'), 'nothing OpenAI cannot read');
    assert.ok(sent.includes('SUMMARY OF THE CLAUDE PART'));
    assert.equal(JSON.parse(sent).input[0].type, 'message');
  });
});

test('OpenAI unreachable from the proxy is reported (for the watchdog), and its return is noticed', async () => {
  const http = await import('node:http');
  const tmp = http.createServer();
  await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
  const upPort = tmp.address().port;
  await new Promise((r) => tmp.close(r));
  await withProxy({ upstreamUrl: `http://127.0.0.1:${upPort}/backend-api/codex`, routerOptions: { upstreamProbeMs: 100 } }, async ({ port }) => {
    const health = async () => (await fetch(`${base(port)}/healthz`)).json();
    assert.equal((await health()).upstream_ok, true);
    for (let i = 0; i < 3; i += 1) assert.equal((await fetch(`${base(port)}/some/path`)).status, 502);
    assert.equal((await health()).upstream_ok, false);
    const back = http.createServer((_req, res) => {
      res.writeHead(401);
      res.end();
    });
    await new Promise((r) => back.listen(upPort, '127.0.0.1', r));
    try {
      assert.ok(await until(async () => (await health()).upstream_ok), 'any answer from OpenAI counts as reachable again');
    } finally {
      back.close();
    }
  });
});

test('requests Codex itself abandons (Esc before OpenAI answered) never count as OpenAI being unreachable', async () => {
  const http = await import('node:http');
  // an upstream that accepts the request but answers only much later
  const slow = http.createServer((_req, res) => setTimeout(() => res.end('late'), 5000).unref());
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  try {
    await withProxy({ upstreamUrl: `http://127.0.0.1:${slow.address().port}/backend-api/codex` }, async ({ port, logLines }) => {
      for (let i = 0; i < 4; i += 1) {
        const ac = new AbortController();
        const pending = fetch(`${base(port)}/some/path`, { signal: ac.signal }).catch(() => null);
        await new Promise((r) => setTimeout(r, 80));
        ac.abort();
        await pending;
      }
      assert.ok(await until(() => logLines.filter((l) => l.ev === 'upstream_http_cancelled').length === 4));
      const h = await (await fetch(`${base(port)}/healthz`)).json();
      assert.equal(h.upstream.network_failures, 0);
      assert.equal(h.upstream_ok, true, 'the watchdog must not send Codex away from the proxy for this');
    });
  } finally {
    slow.closeAllConnections?.();
    slow.close();
  }
});

test('a 404 for the model list means a wrong upstream; elsewhere (e.g. an unknown model) it is just an answer', async () => {
  const http = await import('node:http');
  const s404 = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => s404.listen(0, '127.0.0.1', r));
  try {
    await withProxy({ upstreamUrl: `http://127.0.0.1:${s404.address().port}/wrong` }, async ({ port }) => {
      const health = async () => (await fetch(`${base(port)}/healthz`)).json();
      for (let i = 0; i < 3; i += 1) await (await fetch(`${base(port)}/memories/x`)).text();
      for (let i = 0; i < 3; i += 1) await (await postJson(port, { model: 'gpt-no-such-model', input: [userMsg('x')] })).text();
      assert.equal((await health()).upstream_ok, true);
      for (let i = 0; i < 3; i += 1) await (await fetch(`${base(port)}/models`, { headers: CODEX_HEADERS })).text();
      assert.equal((await health()).upstream_ok, false);
    });
  } finally {
    s404.close();
  }
});

test('install check: GPT must come through the proxy with this Mac\'s sign-in (not from Codex\'s cache)', async () => {
  const { upstreamThrough } = await import('../src/verify.mjs');
  await withProxy({}, async ({ port, codexHome, up }) => {
    assert.deepEqual(await upstreamThrough(port, { codexHome, clientVersion: '0.1.0' }), { ok: true, status: 200, error: null });
    const seen = up.seen.http.find((x) => x.url.startsWith('/backend-api/codex/models'));
    assert.equal(seen.headers.authorization, CODEX_HEADERS.authorization);
    assert.equal(seen.headers['chatgpt-account-id'], TEST_ACCOUNT);
    assert.match(seen.url, /client_version=0\.1\.0/);
  });
  await withProxy({ auth: null }, async ({ port, codexHome }) => {
    assert.equal((await upstreamThrough(port, { codexHome, clientVersion: '1' })).error, 'no_codex_credentials');
  });
  const http = await import('node:http');
  const s404 = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => s404.listen(0, '127.0.0.1', r));
  try {
    await withProxy({ upstreamUrl: `http://127.0.0.1:${s404.address().port}/wrong` }, async ({ port, codexHome }) => {
      const r = await upstreamThrough(port, { codexHome, clientVersion: '1' });
      assert.equal(r.ok, false);
      assert.equal(r.status, 404);
    });
  } finally {
    s404.close();
  }
});

test('an account not on the subscription route never gets conversation content, not even for a summary', async () => {
  await withProxy({ scenario: { turns: [[{ echoPrompt: true }]] }, fakeEnv: { FAKE_AUTH: JSON.stringify({ loggedIn: true, authMethod: 'console', apiProvider: 'firstParty' }) } }, async ({ port, fake }) => {
    const c = await wsClient(port);
    try {
      const r = await c.create({ model: 'claude-opus-5-5', instructions: 'b', input: longHistory(), tools: TOOLS });
      assert.equal(r.done.type, 'response.failed');
      assert.equal(r.done.response.error.lcp_code, 'claude_auth');
      assert.equal(fake.record().filter((x) => x.kind === 'summary_request').length, 0);
      assert.equal(fake.record().filter((x) => x.kind === 'argv').length, 0);
    } finally {
      c.close();
    }
  });
});

test('Esc while the earlier part is being summarized keeps the whole conversation for the next turn', async () => {
  await withProxy({ scenario: { turns: [[{ echoPrompt: true }]] }, fakeEnv: { FAKE_SUMMARY_DELAY_MS: '1500' } }, async ({ port, fake }) => {
    const c = await wsClient(port);
    try {
      c.ws.send(JSON.stringify({ type: 'response.create', model: 'claude-opus-5-5', instructions: 'b', input: longHistory(), tools: TOOLS }));
      const created = await until(() => eventsOf(c).find((e) => e.type === 'response.created'));
      await until(() => fake.record().some((x) => x.kind === 'summary_request'));
      c.ws.send(JSON.stringify({ type: 'response.interrupt', response_id: created.response.id }));
      assert.ok(await until(() => eventsOf(c).find((e) => e.type === 'response.completed')));
      const next = await c.create({ model: 'claude-opus-5-5', instructions: 'b', previous_response_id: created.response.id, input: [userMsg('please continue')], tools: TOOLS });
      assert.equal(next.done.type, 'response.completed', JSON.stringify(next.done));
      const text = next.done.response.output[0].content[0].text;
      assert.match(text, /the latest question/);
      assert.match(text, /please continue/);
    } finally {
      c.close();
    }
  });
});

test('Esc while a Claude session is still starting stops it before any model process runs', async () => {
  await withProxy({ scenario: { turns: [[{ text: 'must not run' }]] }, fakeEnv: { FAKE_AUTH_DELAY_MS: '1200' } }, async ({ port, fake }) => {
    const c = await wsClient(port);
    try {
      c.ws.send(JSON.stringify({ type: 'response.create', model: 'claude-opus-5-5', input: [userMsg('x')] }));
      const created = await until(() => eventsOf(c).find((e) => e.type === 'response.created'));
      await until(() => fake.record().some((x) => x.kind === 'auth_probe'));
      c.ws.send(JSON.stringify({ type: 'response.interrupt', response_id: created.response.id }));
      assert.ok(await until(() => eventsOf(c).find((e) => e.type === 'response.completed')));
      await new Promise((r) => setTimeout(r, 1800));
      assert.equal(fake.record().filter((x) => x.kind === 'argv').length, 0, 'no model process was started');
    } finally {
      c.close();
    }
  });
});

test('updates wait for responses on every port a proxy may be serving (config.toml\'s and the configured one)', async () => {
  const { waitIdle } = await import('../src/service.mjs');
  await withProxy({ scenario: { turns: [[{ text: 'slow' }, { sleepMs: 1500 }]] } }, async ({ port, codexHome }) => {
    const pending = postJson(port, { model: 'claude-opus-5-5', input: [userMsg('x')], prompt_cache_key: 'idle' }).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await waitIdle({ codexHome }, [9, port], () => {}, 200, 50), false, 'a response is still streaming on the running port');
    await pending;
    assert.equal(await waitIdle({ codexHome }, [9, port], () => {}, 200, 50), true);
  });
});

test('an upstream that accepts but never answers is cut off and counted (no Codex request waits forever)', async () => {
  const net = await import('node:net');
  const sockets = [];
  const stall = net.createServer((s) => {
    sockets.push(s);
    s.on('error', () => {});
  });
  await new Promise((r) => stall.listen(0, '127.0.0.1', r));
  try {
    await withProxy({ upstreamUrl: `http://127.0.0.1:${stall.address().port}/backend-api/codex`, routerOptions: { upstreamHeadersMs: 300 } }, async ({ port }) => {
      for (let i = 0; i < 3; i += 1) {
        const t0 = Date.now();
        assert.equal((await fetch(`${base(port)}/some/path`)).status, 502);
        assert.ok(Date.now() - t0 < 3000, 'bounded');
      }
      assert.equal((await (await fetch(`${base(port)}/healthz`)).json()).upstream_ok, false);
    });
  } finally {
    for (const s of sockets) s.destroy();
    stall.close();
  }
});

test('a wrong upstream path stays reported although its server answers (only a real model list clears it)', async () => {
  const http = await import('node:http');
  const s404 = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => s404.listen(0, '127.0.0.1', r));
  try {
    await withProxy({ upstreamUrl: `http://127.0.0.1:${s404.address().port}/wrong`, routerOptions: { upstreamProbeMs: 50 } }, async ({ port }) => {
      for (let i = 0; i < 3; i += 1) await (await fetch(`${base(port)}/models`, { headers: CODEX_HEADERS })).text();
      await (await fetch(`${base(port)}/memories/x`)).text(); // another answer from the same server
      await new Promise((r) => setTimeout(r, 300));
      assert.equal((await (await fetch(`${base(port)}/healthz`)).json()).upstream_ok, false);
    });
  } finally {
    s404.close();
  }
});

test('a compressed request too large to read is refused here: its conversation never goes to OpenAI by default', async () => {
  await withProxy({ routerOptions: { maxBodyBytes: 64 * 1024 } }, async ({ port, up }) => {
    const big = Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', input: [userMsg('x'.repeat(200 * 1024))] }));
    const z = zlib.zstdCompressSync(big);
    assert.ok(z.length < 64 * 1024);
    for (const path of ['/responses', '/responses/compact']) {
      const res = await fetch(`${base(port)}${path}`, { method: 'POST', body: z, headers: { 'content-type': 'application/json', 'content-encoding': 'zstd', ...CODEX_HEADERS } });
      assert.equal(res.status, 413, path);
    }
    assert.equal(up.seen.http.filter((r) => r.url.startsWith('/backend-api/codex/responses')).length, 0);
  });
});

test('changing an account\'s login directory starts a new session and checks that login again', async () => {
  const { readFileSync } = await import('node:fs');
  await withProxy({ scenario: { turns: [[{ text: 'one' }]] } }, async ({ port, fake, cfgDir }) => {
    const c = await wsClient(port);
    try {
      const r1 = await c.create({ model: 'claude-opus-5-5-a2', instructions: 'b', input: [userMsg('x')], tools: TOOLS });
      assert.equal(r1.done.type, 'response.completed', JSON.stringify(r1.done));
      const file = join(cfgDir, 'settings.json');
      const s = JSON.parse(readFileSync(file, 'utf8'));
      s.claude.accounts[1].configDir = join(cfgDir, 'acct2-moved');
      writeFileSync(file, JSON.stringify(s));
      await new Promise((r) => setTimeout(r, 2200)); // settings are re-read at most every 2 s
      const r2 = await c.create({ model: 'claude-opus-5-5-a2', instructions: 'b', previous_response_id: r1.done.response.id, input: [userMsg('y')], tools: TOOLS });
      assert.equal(r2.done.type, 'response.completed', JSON.stringify(r2.done));
      assert.deepEqual(fake.record().filter((x) => x.kind === 'argv').map((x) => x.configDir), [join(cfgDir, 'acct2'), join(cfgDir, 'acct2-moved')]);
      assert.ok(fake.record().some((x) => x.kind === 'auth_probe' && x.configDir === join(cfgDir, 'acct2-moved')), 'the new login was checked, not taken from the cache');
    } finally {
      c.close();
    }
  });
});

test('Codex leaving during the owner check stops the request before any Claude work starts', async () => {
  const slowOwner = async () => {
    await new Promise((r) => setTimeout(r, 600));
    return true;
  };
  await withProxy({ isOwner: slowOwner, scenario: { turns: [[{ text: 'nobody listens' }]] } }, async ({ port, fake }) => {
    const ac = new AbortController();
    const pending = fetch(`${base(port)}/responses`, { method: 'POST', body: JSON.stringify({ model: 'claude-opus-5-5', input: [userMsg('x')], prompt_cache_key: 'gone' }), headers: { 'content-type': 'application/json', ...CODEX_HEADERS }, signal: ac.signal })
      .then((r) => r.text())
      .catch(() => null);
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await pending;
    const c = await wsClient(port);
    c.ws.send(JSON.stringify({ type: 'response.create', model: 'claude-opus-5-5', input: [userMsg('y')] }));
    await new Promise((r) => setTimeout(r, 150));
    c.close();
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(fake.record().filter((x) => x.kind === 'auth_probe' || x.kind === 'argv').length, 0, 'nothing started for clients that left');
  });
});

test('a conversation whose earlier part changed (an edit, a compaction) restarts with the corrected history', async () => {
  const scenario = { processes: [{ turns: [[{ text: 'first answer' }], [{ text: 'second answer' }]] }, { turns: [[{ echoPrompt: true }]] }] };
  await withProxy({ scenario }, async ({ port, logLines }) => {
    const ask = async (input) => parseSse(await (await postJson(port, { model: 'claude-opus-5-5', instructions: 'b', input, prompt_cache_key: 'edit-conv' })).text()).at(-1);
    const said = (text) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
    assert.equal((await ask([userMsg('original question')])).response.output[0].content[0].text, 'first answer');
    const r2 = await ask([userMsg('original question'), said('first answer'), userMsg('second')]);
    assert.equal(r2.response.output[0].content[0].text, 'second answer', 'unchanged history: the same session continues');
    assert.ok(!logLines.some((l) => l.ev === 'session_respawn'));
    const r3 = await ask([userMsg('EDITED question'), said('first answer'), userMsg('second'), said('second answer'), userMsg('third')]);
    assert.ok(logLines.some((l) => l.ev === 'session_respawn' && l.why === 'history_changed'));
    assert.match(r3.response.output[0].content[0].text, /EDITED question/);
  });
});

test('WebSocket subprotocols pass through: offered to OpenAI, its choice given back to Codex', async () => {
  await withProxy({}, async ({ port }) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime?x=1`, ['realtime', 'other'], { headers: CODEX_HEADERS });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      ws.once('unexpected-response', (_r, res) => reject(new Error(`status ${res.statusCode}`)));
    });
    try {
      assert.equal(ws.protocol, 'realtime', 'the upstream picked the first offered protocol, and Codex got that one');
    } finally {
      ws.close();
    }
  });
});

test('compaction for a session that belongs to another login of the account is made under the current login, from the transcript', async () => {
  const { readFileSync } = await import('node:fs');
  await withProxy({ scenario: { turns: [[{ text: 'one' }], [{ text: 'summary that must not be made' }]] } }, async ({ port, cfgDir, fake, logLines }) => {
    const c = await wsClient(port);
    try {
      const r1 = await c.create({ model: 'claude-opus-5-5-a2', instructions: 'b', input: [userMsg('x')], tools: TOOLS });
      assert.equal(r1.done.type, 'response.completed');
      const file = join(cfgDir, 'settings.json');
      const s = JSON.parse(readFileSync(file, 'utf8'));
      s.claude.accounts[1].configDir = join(cfgDir, 'acct2-moved');
      writeFileSync(file, JSON.stringify(s));
      await new Promise((r) => setTimeout(r, 2200));
      const k = await c.create({ model: 'claude-opus-5-5-a2', instructions: 'b', previous_response_id: r1.done.response.id, input: [{ type: 'compaction_trigger' }], tools: TOOLS });
      assert.equal(k.done.type, 'response.completed', JSON.stringify(k.done));
      assert.ok(logLines.some((l) => l.ev === 'claude_compacted' && l.from_session === false), 'not by the old login\'s session');
      assert.ok(fake.record().some((x) => x.kind === 'auth_probe' && x.configDir === join(cfgDir, 'acct2-moved')), 'the current login was checked first');
    } finally {
      c.close();
    }
  });
});

test('an earlier tool call whose tool changed (same id and arguments) is a changed history: restart', async () => {
  const scenario = { processes: [{ turns: [[{ call: { title: 'exec_command', args: { cmd: 'echo hi' } } }, { echoLast: true }], [{ text: 'turn two' }]] }, { turns: [[{ text: 'restarted' }]] }] };
  await withProxy({ scenario }, async ({ port, logLines }) => {
    const ask = async (input) => parseSse(await (await postJson(port, { model: 'claude-opus-5-5', instructions: 'b', input, tools: TOOLS, prompt_cache_key: 'tool-conv' })).text()).at(-1);
    const r1 = await ask([userMsg('run it')]);
    const call = r1.response.output.find((o) => o.type === 'function_call');
    assert.ok(call, JSON.stringify(r1));
    const output = { type: 'function_call_output', call_id: call.call_id, output: 'hi\n' };
    const r2 = await ask([userMsg('run it'), call, output]);
    const said = r2.response.output[0];
    assert.match(said.content[0].text, /result: hi/);
    const r3 = await ask([userMsg('run it'), call, output, said, userMsg('again')]);
    assert.equal(r3.response.output[0].content[0].text, 'turn two', 'unchanged: the same process');
    const renamed = { ...call, name: 'search', namespace: 'mcp__app' };
    const r4 = await ask([userMsg('run it'), renamed, output, said, userMsg('again'), r3.response.output[0], userMsg('more')]);
    assert.ok(logLines.some((l) => l.ev === 'session_respawn' && l.why === 'history_changed'));
    assert.equal(r4.response.output[0].content[0].text, 'restarted');
  });
});

test('Claude → GPT → Claude: compaction summarizes the whole current conversation, never the older Claude session', async () => {
  await withProxy({ scenario: { turns: [[{ text: 'claude answer' }], [{ text: 'stale summary of the old session only' }]] }, fakeEnv: { FAKE_SUMMARY_PROBE: 'the gpt part' } }, async ({ port, fake, logLines }) => {
    const c = await wsClient(port);
    try {
      const said = (text) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      const r1 = await c.create({ model: 'claude-opus-5-5', instructions: 'b', input: [userMsg('first, with claude')], tools: TOOLS, prompt_cache_key: 'mix' });
      assert.equal(r1.done.type, 'response.completed');
      const r2 = await c.create({ model: 'gpt-test', input: [userMsg('first, with claude'), said('claude answer'), userMsg('the gpt part')], prompt_cache_key: 'mix' });
      assert.equal(r2.done.type, 'response.completed');
      // chained to a response this proxy never saw: refused, not answered from another session of the thread
      const k1 = await c.create({ model: 'claude-opus-5-5', instructions: 'b', previous_response_id: r2.done.response.id, input: [{ type: 'compaction_trigger' }], tools: TOOLS, prompt_cache_key: 'mix' });
      assert.equal(k1.done.type, 'response.failed');
      assert.equal(k1.done.response.error.lcp_code, 'previous_response_unknown');
      // the full history: summarized from its transcript (the old session has not seen the GPT part)
      const k2 = await c.create({ model: 'claude-opus-5-5', instructions: 'b', input: [userMsg('first, with claude'), said('claude answer'), userMsg('the gpt part'), said('gpt answer'), { type: 'compaction_trigger' }], tools: TOOLS, prompt_cache_key: 'mix' });
      assert.equal(k2.done.type, 'response.completed', JSON.stringify(k2.done));
      assert.equal(k2.done.response.output[0].type, 'compaction');
      const req = fake.record().filter((x) => x.kind === 'summary_request').at(-1);
      assert.equal(req.probe, true, 'the summary saw the GPT part');
      assert.equal(req.compaction, true);
      assert.ok(logLines.some((l) => l.ev === 'claude_compacted' && l.from_session === false));
    } finally {
      c.close();
    }
  });
});

test('Codex compacting in the middle of a turn (a tool call waiting for its output) gets its summary, not "busy"', async () => {
  const scenario = { turns: [[{ call: { title: 'exec_command', args: { cmd: 'ls' } } }, { echoLast: true }]] };
  await withProxy({ scenario, fakeEnv: { FAKE_SUMMARY_PROBE: 'check the files' } }, async ({ port, fake, logLines }) => {
    const c = await wsClient(port);
    try {
      const r1 = await c.create({ model: 'claude-opus-5-5', instructions: 'b', input: [userMsg('check the files')], tools: TOOLS, prompt_cache_key: 'mid' });
      const call = r1.done.response.output.find((o) => o.type === 'function_call');
      assert.ok(call, JSON.stringify(r1.done));
      // only the trigger, chained to the response that ended with the call
      const k1 = await c.create({ model: 'claude-opus-5-5', instructions: 'b', previous_response_id: r1.done.response.id, input: [{ type: 'compaction_trigger' }], tools: TOOLS, prompt_cache_key: 'mid' });
      assert.equal(k1.done.type, 'response.completed', JSON.stringify(k1.done));
      assert.equal(k1.done.response.output[0].type, 'compaction');
      // the tool output and the trigger together
      const k2 = await c.create({ model: 'claude-opus-5-5', instructions: 'b', previous_response_id: r1.done.response.id, input: [{ type: 'function_call_output', call_id: call.call_id, output: 'a.txt' }, { type: 'compaction_trigger' }], tools: TOOLS, prompt_cache_key: 'mid' });
      assert.equal(k2.done.type, 'response.completed', JSON.stringify(k2.done));
      assert.equal(fake.record().filter((x) => x.kind === 'summary_request').at(-1).probe, true);
      assert.ok(!logLines.some((l) => l.ev === 'claude_response_failed'));
    } finally {
      c.close();
    }
  });
});

test('a request that fails (login expired) keeps what it was chained to: the retry after logging in continues', async () => {
  const { mkdtempSync, writeFileSync: write } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const authFile = join(mkdtempSync(join(tmpdir(), 'lcp-auth-')), 'auth.json');
  write(authFile, JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }));
  await withProxy({ scenario: { turns: [[{ echoPrompt: true }]] }, fakeEnv: { FAKE_AUTH_FILE: authFile } }, async ({ port }) => {
    const c = await wsClient(port);
    try {
      const pre = await c.create({ model: 'claude-opus-5-5', generate: false, instructions: 'b', input: [userMsg('context before the turn')], tools: TOOLS });
      const body = { model: 'claude-opus-5-5', previous_response_id: pre.done.response.id, instructions: 'b', input: [userMsg('the question')], tools: TOOLS };
      const failed = await c.create(body);
      assert.equal(failed.done.response.error.lcp_code, 'claude_auth');
      write(authFile, JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }));
      const retried = await c.create(body);
      assert.equal(retried.done.type, 'response.completed', JSON.stringify(retried.done));
      assert.match(retried.done.response.output[0].content[0].text, /context before the turn/);
    } finally {
      c.close();
    }
  });
});

test('a transcript longer than one summarizer run is summarized in order: the original goal is never dropped', async () => {
  await withProxy({ scenario: { turns: [[{ call: { title: 'exec_command', args: { cmd: 'ls' } } }, { echoLast: true }]] }, settings: { limits: { summaryChunkChars: 100_000 } } }, async ({ port, fake }) => {
    const c = await wsClient(port);
    try {
      // a long thread compacted while a tool call waits (the transcript path)
      const r1 = await c.create({ model: 'claude-opus-5-5', instructions: 'b', input: longHistory(), tools: TOOLS, prompt_cache_key: 'long' });
      assert.equal(r1.done.type, 'response.completed', JSON.stringify(r1.done));
      const before = fake.record().filter((x) => x.kind === 'summary_request').length;
      const k = await c.create({ model: 'claude-opus-5-5', instructions: 'b', previous_response_id: r1.done.response.id, input: [{ type: 'compaction_trigger' }], tools: TOOLS, prompt_cache_key: 'long' });
      assert.equal(k.done.type, 'response.completed', JSON.stringify(k.done));
      const runs = fake.record().filter((x) => x.kind === 'summary_request').slice(before);
      assert.ok(runs.length >= 3, `summarized in chunks (${runs.length} runs)`);
      assert.ok(runs.every((r) => r.chars < 120_000), 'each run within its budget');
      assert.equal(runs.at(-1).mentionsFirst, true, 'the last run still knows the very first request (carried by the summary so far)');
      assert.equal(runs.at(-1).compaction, true, 'the last run is the compaction summary');
    } finally {
      c.close();
    }
  });
});
