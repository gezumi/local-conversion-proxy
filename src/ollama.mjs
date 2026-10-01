// Ollama backend: local models (Qwen) through Ollama's own Responses API.
//
// Codex's request is reduced to what a local model can use: plain messages,
// function calls and their outputs, and the top-level function tools (the
// hundreds of app/MCP namespace tools are left out). Reasoning items are not
// sent back to Codex, so a thread can later switch to GPT or Claude safely.
// Ollama's default context is small and silently truncates long prompts, so a
// model with an explicit num_ctx is derived once (same weights, no download).

import { createHash } from 'node:crypto';
import { BoundedMap } from './bounded.mjs';
import { COMPACTION_PROMPT, compactionAsMessage, isCompactionRequest, makeCompactionItem } from './compaction.mjs';
import { ResponseStream, rid } from './responses.mjs';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => {
      if (typeof p === 'string') return p;
      if (typeof p?.text === 'string') return p.text;
      if (p?.type === 'input_image') return '[image omitted: this local model receives text only]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Codex Responses input -> items Ollama's Responses API accepts. */
export function toOllamaInput(input) {
  const out = [];
  for (const it of Array.isArray(input) ? input : []) {
    const type = it?.type ?? (it?.role ? 'message' : null);
    const summary = compactionAsMessage(it);
    if (summary) {
      out.push({ type: 'message', role: 'user', content: summary.content[0].text });
      continue;
    }
    if (type === 'message') {
      const role = it.role === 'developer' ? 'system' : it.role;
      if (!['user', 'assistant', 'system'].includes(role)) continue;
      const text = textOf(it.content);
      if (text) out.push({ type: 'message', role, content: text });
    } else if (type === 'function_call') {
      out.push({ type: 'function_call', call_id: it.call_id, name: it.namespace ? `${it.namespace}__${it.name}` : it.name, arguments: typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments ?? {}) });
    } else if (type === 'custom_tool_call') {
      out.push({ type: 'function_call', call_id: it.call_id, name: it.name, arguments: JSON.stringify({ input: it.input ?? '' }) });
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const o = it.output;
      out.push({ type: 'function_call_output', call_id: it.call_id, output: typeof o === 'string' ? o : textOf(o?.content ?? o) });
    }
    // reasoning, additional_tools, web_search_call, ...: another provider's private state
  }
  return out;
}

/**
 * Top-level tools only: functions as they are, and freeform (custom) tools such
 * as apply_patch as a function taking one string `input`.
 */
export function toOllamaTools(tools) {
  const out = [];
  for (const t of Array.isArray(tools) ? tools : []) {
    if (t?.type === 'function' && typeof t.name === 'string') {
      out.push({ type: 'function', name: t.name, description: typeof t.description === 'string' ? t.description.slice(0, 8000) : '', parameters: t.parameters ?? { type: 'object', properties: {} } });
    } else if (t?.type === 'custom' && typeof t.name === 'string') {
      const grammar = t.format?.type === 'grammar' && typeof t.format.definition === 'string' ? `\n\nInput format (${t.format.syntax ?? 'grammar'}):\n${t.format.definition}` : '';
      out.push({
        type: 'function',
        name: t.name,
        description: `${typeof t.description === 'string' ? t.description : ''}${grammar}\n\nPass the complete raw text as the "input" argument.`.slice(0, 12000),
        parameters: { type: 'object', properties: { input: { type: 'string', description: 'The complete raw input, exactly in the format above.' } }, required: ['input'] },
        custom: true,
      });
    }
  }
  return out;
}

/** An Ollama function call -> the Codex item for it (custom tools get their raw input back). */
export function toCodexCall(item, customNames) {
  const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
  const callId = item.call_id || rid('call');
  if (customNames.has(item.name)) {
    let input = args;
    try {
      const parsed = JSON.parse(args);
      if (typeof parsed?.input === 'string') input = parsed.input;
    } catch {
      // not JSON: the model passed the raw input itself
    }
    return { type: 'custom_tool_call', id: rid('ctc'), status: 'completed', call_id: callId, name: item.name, input };
  }
  return { type: 'function_call', id: rid('fc'), status: 'completed', call_id: callId, name: item.name, arguments: args };
}

async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      try {
        yield JSON.parse(data);
      } catch {
        // ignore a malformed event
      }
    }
  }
}

export function createOllamaBackend({ logger = { event() {} }, baseUrl = 'http://127.0.0.1:11434', fetchImpl = fetch, limits: limitOverrides = {} } = {}) {
  const limits = { showMs: 10_000, createMs: 120_000, tagsMs: 60_000, historyBytes: 128 * 1024 * 1024, ...limitOverrides };
  const derived = new Map(); // "model|numCtx|digest" -> Promise<name>
  /** Response id -> the whole conversation up to and including that response (Codex sends deltas after it). Bounded in count and size. */
  const histories = new BoundedMap({ maxEntries: 256, maxBytes: limits.historyBytes });
  const remember = (id, items) => histories.set(id, items);

  /** The base models' weight digests and every model name (from /api/tags), refreshed at most every `tagsMs`. */
  const tags = { at: 0, digests: new Map(), names: new Set(), pending: null };
  async function baseDigest(model) {
    if (Date.now() - tags.at >= limits.tagsMs) {
      tags.pending ??= (async () => {
        try {
          const res = await fetchImpl(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(limits.showMs) });
          if (!res.ok) throw new Error(`tags ${res.status}`);
          const list = (await res.json())?.models;
          tags.digests = new Map((Array.isArray(list) ? list : []).flatMap((m) => [[m?.name, m?.digest], [m?.model, m?.digest]]).filter(([n, d]) => typeof n === 'string' && typeof d === 'string' && d));
          tags.names = new Set((Array.isArray(list) ? list : []).flatMap((m) => [m?.name, m?.model]).filter((n) => typeof n === 'string'));
          tags.at = Date.now();
        } catch {
          // keep what we knew; ask again next time
        } finally {
          tags.pending = null;
        }
      })();
      await tags.pending;
    }
    return tags.digests.get(model) ?? (model.includes(':') ? null : (tags.digests.get(`${model}:latest`) ?? null));
  }

  /** Models a request is using right now (never removed under it). */
  const inUse = new Map();
  const use = (name) => inUse.set(name, (inUse.get(name) ?? 0) + 1);
  const release = (name) => (inUse.get(name) > 1 ? inUse.set(name, inUse.get(name) - 1) : inUse.delete(name));
  const pruned = new Map(); // family -> tags.at of the last pass
  const resolved = new Map(); // variant name -> its key in `derived`

  /**
   * The variants this proxy made earlier for the same base model and context
   * (other weights, or an older naming) keep obsolete weights on disk: remove
   * them, once per model list, unless a request is using one. Current names
   * carry a hash of the base model's id, so they are never confused with
   * another model's; names of the older namings are removed only when exactly
   * one base model could have made them. A removed variant is also forgotten
   * here, so going back to those weights makes it again.
   */
  function pruneObsolete(model, numCtx, current) {
    const family = familyOf(model, numCtx);
    if (pruned.get(family) === tags.at) return;
    pruned.set(family, tags.at);
    const bases = [...new Set([...tags.names].filter((n) => !n.startsWith('lcp-')).map((n) => n.replace(/:latest$/, '')))];
    const sole = (stemOf) => bases.filter((b) => stemOf(b) === stemOf(model)).length === 1;
    const short = (m) => m.replace(/[^A-Za-z0-9.]+/g, '-').slice(0, 60);
    const full = (m) => m.replace(/[^A-Za-z0-9.]+/g, '-');
    const ours = (n) =>
      (n.startsWith(family) && /^[0-9a-f]{8}$/.test(n.slice(family.length))) ||
      (n.startsWith(`lcp-${short(model)}-`) && new RegExp(`^${numCtx}ctx-[0-9a-f]{8}$`).test(n.slice(`lcp-${short(model)}-`.length)) && sole(short)) ||
      (n.startsWith(`lcp-${full(model)}-`) && /^\d+k$/.test(n.slice(`lcp-${full(model)}-`.length)) && sole(full));
    for (const name of tags.names) {
      const bare = name.replace(/:latest$/, '');
      if (!ours(bare) || bare === current || inUse.has(bare) || inUse.has(name)) continue;
      fetchImpl(`${baseUrl}/api/delete`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(limits.showMs) })
        .then((res) => {
          logger.event(res.ok ? 'ollama_variant_removed' : 'ollama_variant_remove_failed', { status: res.status });
          if (res.ok && resolved.has(bare)) {
            derived.delete(resolved.get(bare));
            resolved.delete(bare);
          }
        })
        .catch(() => logger.event('ollama_variant_remove_failed'));
    }
  }

  /** Every variant of (model, numCtx) starts so: the sanitized name, the size, and a hash of the exact model id. */
  function familyOf(model, numCtx) {
    return `lcp-${model.replace(/[^A-Za-z0-9.]+/g, '-').slice(0, 60)}-${numCtx}ctx-${createHash('sha256').update(model).digest('hex').slice(0, 6)}-`;
  }

  /**
   * A model with num_ctx set, made once from the same weights: its name
   * carries the base model's weight digest, so after an update of the base
   * (ollama pull) a new one is made. The base name if that fails, takes too
   * long (each Ollama call is bounded; a failed attempt is not kept) or the
   * digest is unknown (right weights before a larger context). The caller's
   * wait ends with its signal.
   */
  function modelWithContext(model, numCtx, signal) {
    if (!numCtx) return Promise.resolve(model);
    const pending = (async () => {
      const digest = await baseDigest(model);
      if (!digest) {
        logger.event('ollama_digest_unknown');
        return model;
      }
      const k = `${model}|${numCtx}|${digest}`;
      if (!derived.has(k)) {
        const name = `${familyOf(model, numCtx)}${createHash('sha256').update(`${model}\u0000${numCtx}\u0000${digest}`).digest('hex').slice(0, 8)}`;
        const post = (path, body, ms) => fetchImpl(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
        derived.set(
          k,
          (async () => {
            const show = await post('/api/show', { model: name }, limits.showMs);
            if (show.ok) return name;
            const res = await post('/api/create', { model: name, from: model, parameters: { num_ctx: numCtx }, stream: false }, limits.createMs);
            if (!res.ok) throw new Error(`create ${res.status}`);
            logger.event('ollama_model_derived', { num_ctx: numCtx });
            return name;
          })().catch(() => {
            derived.delete(k);
            logger.event('ollama_derive_failed');
            return model;
          }),
        );
      }
      const name = await derived.get(k);
      if (name !== model) {
        resolved.set(name, k);
        pruneObsolete(model, numCtx, name);
      }
      return name;
    })();
    if (!signal) return pending;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  async function handle(body, sink, ctx) {
    const stream = new ResponseStream(sink, { model: ctx.entry.slug });
    ctx.onResponseId?.(stream.id);
    const ac = new AbortController();
    // Esc in Codex or a closed connection stops the Ollama request.
    const onAbort = () => ac.abort();
    if (ctx.signal?.aborted) ac.abort();
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    let input = [];
    let compacting = false;
    let usedModel = null;
    try {
      input = Array.isArray(body?.input) ? body.input : [];
      const prev = body?.previous_response_id;
      if (prev) {
        if (!histories.has(prev)) {
          stream.created();
          stream.failed({ code: 'previous_response_not_found', message: '前回の応答が見つかりません（プロキシ再起動など）。もう一度送信してください。' });
          return;
        }
        input = [...histories.get(prev), ...input];
      }
      if (body?.generate === false) {
        stream.created();
        stream.completed(null);
        remember(stream.id, input);
        return;
      }
      stream.created();
      const model = await modelWithContext(ctx.entry.target.model, ctx.entry.target.numCtx, ac.signal);
      usedModel = model;
      use(model);
      compacting = isCompactionRequest(body);
      const declared = compacting ? [] : toOllamaTools(body.tools);
      const customNames = new Set(declared.filter((t) => t.custom).map((t) => t.name));
      const tools = declared.map(({ custom, ...t }) => t);
      const convo = toOllamaInput(input);
      // a summary of nothing would replace the real history in Codex: only with the conversation at hand
      if (compacting && !convo.some((m) => m.type !== 'message' || m.role !== 'system')) throw Object.assign(new Error('ollama'), { userMessage: '要約する会話が見つかりません（前回の応答が見つかりません）。会話はそのまま続けられます。' });
      if (compacting) convo.push({ type: 'message', role: 'user', content: COMPACTION_PROMPT });
      const req = {
        model,
        instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
        input: convo,
        stream: true,
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
        ...(body.reasoning?.effort ? { reasoning: { effort: ['low', 'medium', 'high'].includes(body.reasoning.effort) ? body.reasoning.effort : 'medium' } } : {}),
      };
      const res = await fetchImpl(`${baseUrl}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req), signal: ac.signal });
      if (!res.ok || !res.body) {
        logger.event('ollama_http_error', { status: res.status });
        throw Object.assign(new Error('ollama'), { userMessage: `Ollama がエラーを返しました（HTTP ${res.status}）。Ollama が起動しているか、モデル ${ctx.entry.target.model} があるか確認してください。` });
      }
      let usage = null;
      let finished = false;
      let summary = '';
      for await (const ev of sseEvents(res.body)) {
        if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
          if (compacting) summary += ev.delta;
          else stream.text(ev.delta);
        } else if (ev.type === 'response.output_item.done' && ev.item?.type === 'function_call' && !compacting) {
          stream.callItem(toCodexCall(ev.item, customNames));
        } else if (ev.type === 'response.completed') {
          usage = ev.response?.usage ?? null;
          finished = true;
        } else if (ev.type === 'response.failed' || ev.type === 'error') {
          throw Object.assign(new Error('ollama'), { userMessage: 'Ollama がこのターンの途中で失敗しました。' });
        }
      }
      if (!finished && ac.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (!finished) throw Object.assign(new Error('ollama'), { userMessage: 'Ollama の応答が途中で切れました（Ollama が停止した可能性があります）。もう一度送信してください。' });
      if (compacting) {
        if (!summary.trim()) throw Object.assign(new Error('ollama'), { userMessage: '会話の要約を作れませんでした。' });
        const item = makeCompactionItem(summary.trim(), ctx.entry.slug);
        stream.rawItem(item);
        stream.completed(usage);
        remember(stream.id, [item]);
        logger.event('ollama_compacted');
        return;
      }
      stream.completed(usage);
      remember(stream.id, [...input, ...stream.output.filter(Boolean)]);
      logger.event('ollama_response_done', { tools: tools.length });
    } catch (err) {
      if (ac.signal.aborted) {
        // Interrupted: end the response normally with what was produced so far, and keep the
        // conversation so the next turn (chained to this response) can continue it.
        stream.created();
        stream.completed(null);
        if (!compacting) remember(stream.id, [...input, ...stream.output.filter(Boolean)]);
        return;
      }
      logger.event('ollama_failed', { code: err?.cause?.code ?? err?.code ?? 'error' });
      const message = err?.userMessage ?? 'Ollama に接続できませんでした。Ollama アプリ（またはollama serve）が起動しているか確認してください。';
      stream.failed({ code: 'ollama_error', message });
    } finally {
      if (usedModel) release(usedModel);
      ctx.signal?.removeEventListener('abort', onAbort);
      if (!stream.ended) stream.end();
    }
  }

  return { handle, health: () => ({}) };
}
