import assert from 'node:assert/strict';
import test from 'node:test';
import { toCodexCall, toOllamaInput, toOllamaTools } from '../src/ollama.mjs';
import { TOOLS, userMsg, wsClient, withProxy } from './helpers.mjs';

test('Codex input is reduced to what a local model can use', () => {
  const out = toOllamaInput([
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev' }] },
    userMsg('hi'),
    { type: 'reasoning', id: 'rs', encrypted_content: 'x' },
    { type: 'additional_tools', tools: [] },
    { type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: '*** Begin Patch' },
    { type: 'custom_tool_call_output', call_id: 'c1', output: 'ok' },
    { type: 'function_call', call_id: 'c2', name: 'search', namespace: 'mcp__app', arguments: '{"q":1}' },
    { type: 'function_call_output', call_id: 'c2', output: { content: [{ type: 'input_text', text: 'found' }] } },
  ]);
  assert.deepEqual(out, [
    { type: 'message', role: 'system', content: 'dev' },
    { type: 'message', role: 'user', content: 'hi' },
    { type: 'function_call', call_id: 'c1', name: 'apply_patch', arguments: JSON.stringify({ input: '*** Begin Patch' }) },
    { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    { type: 'function_call', call_id: 'c2', name: 'mcp__app__search', arguments: '{"q":1}' },
    { type: 'function_call_output', call_id: 'c2', output: 'found' },
  ]);
  const tools = toOllamaTools(TOOLS);
  assert.deepEqual(tools.map((t) => t.name), ['exec_command', 'apply_patch']);
  assert.deepEqual(tools[1].parameters.required, ['input']);
});

/** A fake Ollama /v1/responses that streams a text answer, or a tool call when asked. */
function fakeOllamaFetch(calls) {
  return async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const sse = (events) =>
      new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const last = body.input.at(-1);
    if (last?.type === 'message' && /tool/.test(last.content)) {
      return sse([
        { type: 'response.created' },
        { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_x', encrypted_content: 'thoughts' } },
        { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_q', name: 'exec_command', arguments: '{"cmd":"ls"}' } },
        { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 2 } } },
      ]);
    }
    return sse([{ type: 'response.output_text.delta', delta: `seen ${body.input.length} items` }, { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 2 } } }]);
  };
}

test('Ollama over WebSocket: text, tool call (no reasoning leaked), and history kept across previous_response_id', async () => {
  const calls = [];
  await withProxy({ ollamaFetch: fakeOllamaFetch(calls) }, async ({ port }) => {
    const c = await wsClient(port);
    try {
      const pre = await c.create({ model: 'local-qwen-test-1b', generate: false, instructions: 'b', input: [], tools: TOOLS });
      const r1 = await c.create({ model: 'local-qwen-test-1b', previous_response_id: pre.done.response.id, instructions: 'b', input: [userMsg('hello')], tools: TOOLS });
      assert.equal(r1.done.response.output[0].content[0].text, 'seen 1 items');
      const r2 = await c.create({ model: 'local-qwen-test-1b', previous_response_id: r1.done.response.id, instructions: 'b', input: [userMsg('use a tool')], tools: TOOLS });
      assert.equal(r2.done.type, 'response.completed');
      assert.deepEqual(r2.done.response.output.map((o) => o.type), ['function_call']);
      assert.equal(r2.done.response.output[0].call_id, 'call_q');
      // the second Ollama call carried the whole conversation
      const sent = calls.filter((x) => x.url.endsWith('/v1/responses')).at(-1).body.input;
      assert.deepEqual(sent.map((i) => i.content ?? i.type), ['hello', 'seen 1 items', 'use a tool']);
      const unknown = await c.create({ model: 'local-qwen-test-1b', previous_response_id: 'resp_nope', input: [userMsg('x')] });
      assert.equal(unknown.done.type, 'response.failed');
      assert.equal(unknown.done.response.error.code, 'previous_response_not_found');
    } finally {
      c.close();
    }
  });
});

test('Ollama not running: a readable failure, the connection stays usable', async () => {
  await withProxy({}, async ({ port }) => {
    const c = await wsClient(port);
    try {
      const r = await c.create({ model: 'local-qwen-test-1b', input: [userMsg('x')] });
      assert.equal(r.done.type, 'response.failed');
      assert.match(r.done.response.error.message, /Ollama/);
      const g = await c.create({ model: 'gpt-test', input: [userMsg('still fine')] });
      assert.equal(g.done.type, 'response.completed');
    } finally {
      c.close();
    }
  });
});

test('a freeform tool called through Ollama comes back to Codex as a custom_tool_call with its raw input', () => {
  const custom = new Set(['apply_patch']);
  const c = toCodexCall({ call_id: 'c1', name: 'apply_patch', arguments: JSON.stringify({ input: '*** Begin Patch\n*** End Patch' }) }, custom);
  assert.equal(c.type, 'custom_tool_call');
  assert.equal(c.input, '*** Begin Patch\n*** End Patch');
  const f = toCodexCall({ call_id: 'c2', name: 'exec_command', arguments: '{"cmd":"ls"}' }, custom);
  assert.equal(f.type, 'function_call');
  assert.equal(f.arguments, '{"cmd":"ls"}');
});

test('Esc during an Ollama turn ends the response normally and stops the request', async () => {
  let aborted = false;
  const slowFetch = async (url, init) => {
    if (!url.endsWith('/v1/responses')) return new Response('{}', { status: 404 });
    init.signal.addEventListener('abort', () => {
      aborted = true;
    });
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'thinking slowly' })}\n\n`));
          init.signal.addEventListener('abort', () => c.error(new Error('aborted')));
        },
      }),
      { status: 200 },
    );
  };
  await withProxy({ ollamaFetch: slowFetch }, async ({ port }) => {
    const c = await wsClient(port);
    try {
      c.ws.send(JSON.stringify({ type: 'response.create', model: 'local-qwen-test-1b', input: [userMsg('long')] }));
      const deadline = Date.now() + 5000;
      let created = null;
      while (Date.now() < deadline) {
        const evs = c.frames.map((f) => JSON.parse(f.data.toString()));
        created = evs.find((e) => e.type === 'response.created');
        if (created && evs.some((e) => e.type === 'response.output_text.delta')) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      c.ws.send(JSON.stringify({ type: 'response.interrupt', response_id: created.response.id }));
      let done = null;
      while (!done && Date.now() < deadline + 3000) {
        done = c.frames.map((f) => JSON.parse(f.data.toString())).find((e) => e.type === 'response.completed' || e.type === 'response.failed');
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(done?.type, 'response.completed');
      assert.equal(aborted, true);
    } finally {
      c.close();
    }
  });
});

/** Ollama's /v1/responses: the first call streams until aborted, later calls answer at once. */
function interruptibleFetch(calls) {
  return async (url, init) => {
    if (!url.endsWith('/v1/responses')) return new Response('{}', { status: 404 });
    const body = JSON.parse(init.body);
    calls.push(body);
    if (calls.length > 1) {
      const text = `seen ${body.input.length} items`;
      return new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: {} })}\n\n`, { status: 200 });
    }
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'partial answer' })}\n\n`));
          init.signal.addEventListener('abort', () => c.error(new Error('aborted')));
        },
      }),
      { status: 200 },
    );
  };
}

async function waitFor(c, pred, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = c.frames.map((f) => JSON.parse(f.data.toString())).find(pred);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

test('after Esc on an Ollama turn, the next turn chained to it continues the conversation', async () => {
  const calls = [];
  await withProxy({ ollamaFetch: interruptibleFetch(calls) }, async ({ port }) => {
    const c = await wsClient(port);
    try {
      c.ws.send(JSON.stringify({ type: 'response.create', model: 'local-qwen-test-1b', input: [userMsg('first question')] }));
      await waitFor(c, (e) => e.type === 'response.output_text.delta');
      const created = await waitFor(c, (e) => e.type === 'response.created');
      c.ws.send(JSON.stringify({ type: 'response.interrupt', response_id: created.response.id }));
      const done = await waitFor(c, (e) => e.type === 'response.completed');
      assert.ok(done, 'interrupted turn ends normally');
      const next = await c.create({ model: 'local-qwen-test-1b', previous_response_id: created.response.id, input: [userMsg('go on')] });
      assert.equal(next.done.type, 'response.completed', JSON.stringify(next.done));
      assert.deepEqual(calls[1].input.map((i) => i.content), ['first question', 'partial answer', 'go on']);
    } finally {
      c.close();
    }
  });
});

test('an Ollama stream that ends without completing is a failure, not a successful answer', async () => {
  const cut = async (url) => {
    if (!url.endsWith('/v1/responses')) return new Response('{}', { status: 404 });
    return new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'half an ans' })}\n\n`, { status: 200 });
  };
  await withProxy({ ollamaFetch: cut }, async ({ port }) => {
    const c = await wsClient(port);
    try {
      const r = await c.create({ model: 'local-qwen-test-1b', input: [userMsg('x')] });
      assert.equal(r.done.type, 'response.failed');
      assert.match(r.done.response.error.message, /途中で切れました/);
      const chained = await c.create({ model: 'local-qwen-test-1b', previous_response_id: r.done.response.id, input: [userMsg('y')] });
      assert.equal(chained.done.response.error.code, 'previous_response_not_found', 'a failed answer is not kept as history');
    } finally {
      c.close();
    }
  });
});

test('preparing a larger-context model is bounded and cancellable; a failed attempt falls back and is retried later', async () => {
  const { createOllamaBackend } = await import('../src/ollama.mjs');
  const seen = [];
  let showHangs = true;
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'q:1b', model: 'q:1b', digest: 'd1' }] }), { status: 200 });
    const body = JSON.parse(init.body);
    seen.push({ path: new URL(url).pathname, model: body.model });
    if (url.endsWith('/api/show') && showHangs) {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))));
    }
    if (url.endsWith('/api/show')) return new Response('{}', { status: 200 });
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: {} })}\n\n`, { status: 200 });
  };
  const backend = createOllamaBackend({ fetchImpl, limits: { showMs: 150, createMs: 150 } });
  const run = async (signal = null) => {
    const events = [];
    const sink = { send: (e) => events.push(e), keepalive() {}, end() {}, onClose: () => () => {} };
    await backend.handle({ input: [userMsg('x')] }, sink, { entry: { slug: 'local-q', target: { model: 'q:1b', numCtx: 65536 } }, signal });
    return events;
  };
  const first = await run();
  assert.equal(first.at(-1).type, 'response.completed');
  assert.equal(seen.find((s) => s.path === '/v1/responses').model, 'q:1b', 'fell back to the base model after the deadline');
  // cancelled while waiting: the response ends at once
  const ac = new AbortController();
  const t0 = Date.now();
  const pending = run(ac.signal);
  setTimeout(() => ac.abort(), 30);
  const cancelled = await pending;
  assert.ok(Date.now() - t0 < 140, 'did not wait for the deadline');
  assert.equal(cancelled.at(-1).type, 'response.completed');
  // the failed attempt was not kept: once Ollama answers, the derived model is used
  showHangs = false;
  await new Promise((r) => setTimeout(r, 200));
  seen.length = 0;
  await run();
  const { createHash } = await import('node:crypto');
  const h = (x, n) => createHash('sha256').update(x).digest('hex').slice(0, n);
  assert.equal(seen.find((s) => s.path === '/v1/responses').model, `lcp-q-1b-65536ctx-${h('q:1b', 6)}-${h('q:1b\u000065536\u0000d1', 8)}`);
});

test('Qwen never "compacts" a conversation it cannot see (Codex would replace the real history with it)', async () => {
  const calls = [];
  await withProxy({ ollamaFetch: fakeOllamaFetch(calls) }, async ({ port }) => {
    const c = await wsClient(port);
    try {
      const k = await c.create({ model: 'local-qwen-test-1b', input: [{ type: 'compaction_trigger' }] });
      assert.equal(k.done.type, 'response.failed');
      assert.match(k.done.response.error.message, /要約する会話が見つかりません/);
      assert.equal(calls.filter((x) => x.url.endsWith('/v1/responses')).length, 0);
    } finally {
      c.close();
    }
  });
});

test('after the base model is updated (ollama pull), the larger-context model is made again from the new weights', async () => {
  const { createOllamaBackend } = await import('../src/ollama.mjs');
  let digest = 'v1';
  let tagsOk = true;
  const created = [];
  const used = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/api/tags')) return tagsOk ? new Response(JSON.stringify({ models: [{ name: 'q:1b', digest }] }), { status: 200 }) : new Response('', { status: 500 });
    const body = JSON.parse(init.body);
    if (url.endsWith('/api/show')) return new Response('{}', { status: created.includes(body.model) ? 200 : 404 });
    if (url.endsWith('/api/create')) {
      created.push(body.model);
      return new Response('{}', { status: 200 });
    }
    used.push(body.model);
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: {} })}\n\n`, { status: 200 });
  };
  const backend = createOllamaBackend({ fetchImpl, limits: { tagsMs: 0 } });
  const run = () => backend.handle({ input: [userMsg('x')] }, { send() {}, keepalive() {}, end() {}, onClose: () => () => {} }, { entry: { slug: 'local-q', target: { model: 'q:1b', numCtx: 65536 } }, signal: null });
  await run();
  await run();
  assert.equal(created.length, 1, 'made once for these weights');
  digest = 'v2';
  await run();
  assert.equal(created.length, 2, 'made again for the new weights');
  assert.notEqual(used.at(-1), used[0]);
  tagsOk = false;
  digest = 'v3';
  await run();
  assert.equal(used.at(-1), used[2], 'digest unknown now: the last known one is used');
  const fresh = createOllamaBackend({ fetchImpl, limits: { tagsMs: 0 } });
  await fresh.handle({ input: [userMsg('x')] }, { send() {}, keepalive() {}, end() {}, onClose: () => () => {} }, { entry: { slug: 'local-q', target: { model: 'q:1b', numCtx: 65536 } }, signal: null });
  assert.equal(used.at(-1), 'q:1b', 'no digest ever known: the base model itself (right weights before a larger context)');
});

test('variants made for older weights (and the first naming) are removed, never one in use or someone else\'s', async () => {
  const { createOllamaBackend } = await import('../src/ollama.mjs');
  const { createHash } = await import('node:crypto');
  const h = (x, n) => createHash('sha256').update(x).digest('hex').slice(0, n);
  const name = (d) => `lcp-q-1b-65536ctx-${h('q:1b', 6)}-${h(`q:1b\u000065536\u0000${d}`, 8)}`;
  const deleted = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/api/tags')) {
      const models = [{ name: 'q:1b', digest: 'v2' }, { name: `${name('v1')}:latest` }, { name: 'lcp-q-1b-64k:latest' }, { name: 'lcp-q-1b-65536ctx-0123abcd:latest' }, { name: `${name('v2')}:latest` }, { name: 'lcp-other-1b-65536ctx-0123abcd:latest' }, { name: 'q-1b-custom:latest' }];
      return new Response(JSON.stringify({ models }), { status: 200 });
    }
    if (url.endsWith('/api/delete')) {
      deleted.push(JSON.parse(init.body).model);
      return new Response('{}', { status: 200 });
    }
    if (url.endsWith('/api/show')) return new Response('{}', { status: 200 });
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: {} })}\n\n`, { status: 200 });
  };
  const backend = createOllamaBackend({ fetchImpl });
  await backend.handle({ input: [userMsg('x')] }, { send() {}, keepalive() {}, end() {}, onClose: () => () => {} }, { entry: { slug: 'local-q', target: { model: 'q:1b', numCtx: 65536 } }, signal: null });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(deleted.sort(), [`${name('v1')}:latest`, 'lcp-q-1b-64k:latest', 'lcp-q-1b-65536ctx-0123abcd:latest'].sort());
});

/** A small in-memory Ollama: models by name, create/show/delete/tags, and which model each request used. */
function memoryOllama(bases) {
  const models = new Map(Object.entries(bases).map(([n, d]) => [n, { digest: d }]));
  const used = [];
  const deleted = [];
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [...models.entries()].map(([n, m]) => ({ name: n.startsWith('lcp-') ? `${n}:latest` : n, digest: m.digest ?? 'x' })) }), { status: 200 });
    if (url.endsWith('/api/show')) return new Response('{}', { status: models.has(body.model) ? 200 : 404 });
    if (url.endsWith('/api/create')) {
      models.set(body.model, { from: body.from });
      return new Response('{}', { status: 200 });
    }
    if (url.endsWith('/api/delete')) {
      const n = body.model.replace(/:latest$/, '');
      deleted.push(n);
      models.delete(n);
      return new Response('{}', { status: 200 });
    }
    if (!models.has(body.model)) return new Response('{"error":"model not found"}', { status: 404 });
    used.push(body.model);
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: {} })}\n\n`, { status: 200 });
  };
  return { models, used, deleted, fetchImpl };
}
const runOn = async (backend, model) => {
  const events = [];
  await backend.handle({ input: [userMsg('x')] }, { send: (e) => events.push(e), keepalive() {}, end() {}, onClose: () => () => {} }, { entry: { slug: 'local-x', target: { model, numCtx: 65536 } }, signal: null });
  await new Promise((r) => setTimeout(r, 30)); // let a removal finish
  return events.at(-1).type;
};

test('weights A, then B, then A again: the variant for A is made again (never a removed one)', async () => {
  const { createOllamaBackend } = await import('../src/ollama.mjs');
  const o = memoryOllama({ 'q:1b': 'A' });
  const backend = createOllamaBackend({ fetchImpl: o.fetchImpl, limits: { tagsMs: 0 } });
  assert.equal(await runOn(backend, 'q:1b'), 'response.completed');
  o.models.get('q:1b').digest = 'B';
  assert.equal(await runOn(backend, 'q:1b'), 'response.completed');
  assert.equal(o.deleted.length, 1, "A's variant removed");
  o.models.get('q:1b').digest = 'A';
  assert.equal(await runOn(backend, 'q:1b'), 'response.completed', 'A again works');
  assert.ok(o.models.has(o.used.at(-1)));
});

test('two models whose names look alike (q:1b, q-1b) never remove each other\'s variants', async () => {
  const { createOllamaBackend } = await import('../src/ollama.mjs');
  const o = memoryOllama({ 'q:1b': 'A', 'q-1b': 'B' });
  const backend = createOllamaBackend({ fetchImpl: o.fetchImpl, limits: { tagsMs: 0 } });
  for (const m of ['q:1b', 'q-1b', 'q:1b', 'q-1b']) assert.equal(await runOn(backend, m), 'response.completed', m);
  assert.deepEqual(o.deleted, []);
  assert.equal(new Set(o.used).size, 2, 'one variant each');
});
