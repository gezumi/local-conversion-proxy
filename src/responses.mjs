// Responses streaming events for locally served models, written to a sink:
// an SSE HTTP response (POST /responses) or Codex's WebSocket (response.create).

import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';

export function rid(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

export class SseSink {
  constructor(res) {
    this.res = res;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
  }
  get closed() {
    return this.res.destroyed || this.res.writableEnded;
  }
  send(obj) {
    if (!this.closed) this.res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
  }
  keepalive() {
    if (!this.closed) this.res.write(': keepalive\n\n');
  }
  end() {
    if (!this.closed) this.res.end();
  }
  onClose(fn) {
    this.res.once('close', fn);
    return () => this.res.off('close', fn);
  }
}

export class WsSink {
  constructor(ws) {
    this.ws = ws;
  }
  get closed() {
    return this.ws.readyState !== WebSocket.OPEN;
  }
  send(obj) {
    if (!this.closed) this.ws.send(JSON.stringify(obj));
  }
  keepalive() {
    // Codex ignores event types it does not know; any frame keeps its stream-idle timer alive.
    this.send({ type: 'lcp.keepalive' });
  }
  end() {
    // The WebSocket belongs to the conversation, not to one response.
  }
  onClose(fn) {
    this.ws.once('close', fn);
    return () => this.ws.off('close', fn);
  }
}

export function usageOf(u) {
  const cached = Number(u?.cache_read_input_tokens ?? u?.input_tokens_details?.cached_tokens) || 0;
  const created = Number(u?.cache_creation_input_tokens) || 0;
  const plainInput = Number(u?.input_tokens) || 0;
  const input = u?.input_tokens_details ? plainInput : plainInput + cached + created;
  const output = Number(u?.output_tokens) || 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: Number(u?.output_tokens_details?.reasoning_tokens) || 0 },
    total_tokens: input + output,
  };
}

/**
 * One response on a sink. Text is streamed as deltas into one assistant
 * message item; tool calls are complete items. Always ends with exactly one
 * of completed() / failed().
 */
export class ResponseStream {
  id = rid('resp');
  output = [];
  #sink;
  #model;
  #seq = 0;
  #msg = null;
  #reasoning = null;
  #keepalive = null;
  ended = false;

  constructor(sink, { model, keepaliveMs = 10_000 }) {
    this.#sink = sink;
    this.#model = model;
    this.#keepalive = setInterval(() => this.#sink.keepalive(), keepaliveMs);
    this.#keepalive.unref?.();
  }

  get sink() {
    return this.#sink;
  }

  #base(status) {
    return { id: this.id, object: 'response', created_at: Math.floor(Date.now() / 1000), status, model: this.#model, output: [] };
  }

  event(type, data) {
    if (this.ended) return;
    this.#sink.send({ type, sequence_number: this.#seq++, ...data });
  }

  #created = false;

  /** response.created + response.in_progress, once. */
  created() {
    if (this.#created) return;
    this.#created = true;
    this.event('response.created', { response: this.#base('in_progress') });
    this.event('response.in_progress', { response: this.#base('in_progress') });
  }

  /** Stream a reasoning summary (shown by Codex as the model's thinking). */
  reasoning(delta) {
    if (!delta) return;
    this.closeMessage();
    if (!this.#reasoning) {
      this.#reasoning = { id: rid('rs'), index: this.output.length, text: '' };
      this.output.push(null);
      this.event('response.output_item.added', { output_index: this.#reasoning.index, item: { type: 'reasoning', id: this.#reasoning.id, summary: [] } });
      this.event('response.reasoning_summary_part.added', { item_id: this.#reasoning.id, output_index: this.#reasoning.index, summary_index: 0, part: { type: 'summary_text', text: '' } });
    }
    this.#reasoning.text += delta;
    this.event('response.reasoning_summary_text.delta', { item_id: this.#reasoning.id, output_index: this.#reasoning.index, summary_index: 0, delta });
  }

  closeReasoning() {
    const r = this.#reasoning;
    if (!r) return null;
    this.#reasoning = null;
    const part = { type: 'summary_text', text: r.text };
    this.event('response.reasoning_summary_text.done', { item_id: r.id, output_index: r.index, summary_index: 0, text: r.text });
    this.event('response.reasoning_summary_part.done', { item_id: r.id, output_index: r.index, summary_index: 0, part });
    const item = { type: 'reasoning', id: r.id, summary: [part] };
    this.event('response.output_item.done', { output_index: r.index, item });
    this.output[r.index] = item;
    return item;
  }

  /** Append assistant text, opening the message item on first use. `separate` starts a new paragraph. */
  text(delta, { separate = false } = {}) {
    if (!delta) return;
    this.closeReasoning();
    if (!this.#msg) {
      this.#msg = { id: rid('msg'), index: this.output.length, text: '' };
      this.output.push(null);
      this.event('response.output_item.added', { output_index: this.#msg.index, item: { type: 'message', id: this.#msg.id, role: 'assistant', status: 'in_progress', content: [] } });
      this.event('response.content_part.added', { item_id: this.#msg.id, output_index: this.#msg.index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    } else if (separate && this.#msg.text && !this.#msg.text.endsWith('\n\n')) {
      delta = `\n\n${delta}`;
    }
    this.#msg.text += delta;
    this.event('response.output_text.delta', { item_id: this.#msg.id, output_index: this.#msg.index, content_index: 0, delta });
  }

  get hasText() {
    return Boolean(this.#msg?.text);
  }

  closeMessage() {
    const m = this.#msg;
    if (!m) return null;
    this.#msg = null;
    const part = { type: 'output_text', text: m.text, annotations: [] };
    const item = { type: 'message', id: m.id, role: 'assistant', status: 'completed', content: [part] };
    this.event('response.output_text.done', { item_id: m.id, output_index: m.index, content_index: 0, text: m.text });
    this.event('response.content_part.done', { item_id: m.id, output_index: m.index, content_index: 0, part });
    this.event('response.output_item.done', { output_index: m.index, item });
    this.output[m.index] = item;
    return item;
  }

  /** A complete function_call / custom_tool_call item. */
  callItem(item) {
    this.closeReasoning();
    this.closeMessage();
    const index = this.output.length;
    this.output.push(item);
    const added = item.type === 'function_call' ? { ...item, status: 'in_progress', arguments: '' } : { ...item, status: 'in_progress', input: '' };
    this.event('response.output_item.added', { output_index: index, item: added });
    if (item.type === 'function_call') {
      this.event('response.function_call_arguments.delta', { item_id: item.id, output_index: index, delta: item.arguments });
      this.event('response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: item.arguments });
    } else {
      this.event('response.custom_tool_call_input.delta', { item_id: item.id, output_index: index, delta: item.input });
      this.event('response.custom_tool_call_input.done', { item_id: item.id, output_index: index, input: item.input });
    }
    this.event('response.output_item.done', { output_index: index, item });
  }

  /** Pass through a complete upstream-shaped output item (Ollama). */
  rawItem(item) {
    this.closeReasoning();
    this.closeMessage();
    const index = this.output.length;
    this.output.push(item);
    this.event('response.output_item.added', { output_index: index, item });
    this.event('response.output_item.done', { output_index: index, item });
  }

  completed(usage) {
    this.closeReasoning();
    this.closeMessage();
    this.event('response.completed', { response: { ...this.#base('completed'), output: this.output.filter(Boolean), usage: usageOf(usage) } });
    this.end();
  }

  failed({ code = 'lcp_error', message }) {
    this.closeReasoning();
    this.closeMessage();
    this.event('response.failed', { response: { ...this.#base('failed'), error: { code, message } } });
    this.end();
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.#keepalive);
    this.#sink.end();
  }
}
