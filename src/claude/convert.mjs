// Responses input items -> normalized items, Claude content blocks and MCP content.
//
// Text and data-URL images are preserved block by block. External image URLs
// are never fetched; they become an explicit placeholder. Items that only carry
// another provider's private state (reasoning, compaction, tool declarations
// sent as input) are skipped; any other unknown item or content kind becomes an
// explicit placeholder instead of failing the turn.

import { createHash } from 'node:crypto';
import { readCompaction, summaryText } from '../compaction.mjs';
import { bridgeError } from './errors.mjs';
import { canonicalJson } from './tools.mjs';

const IGNORED_ITEM_TYPES = new Set(['reasoning', 'compaction_trigger', 'web_search_call', 'image_generation_call', 'item_reference', 'additional_tools', 'tool_search_call', 'tool_search_output', 'mcp_list_tools']);
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_PARTS = new Set(['input_text', 'output_text', 'text', 'refusal']);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function sha(s) {
  return createHash('sha256').update(s).digest('hex');
}

function partText(part) {
  if (part.type === 'refusal') return typeof part.refusal === 'string' ? part.refusal : '';
  return typeof part.text === 'string' ? part.text : '';
}

/** `data:image/png;base64,...` -> { mime, data } or null. */
export function parseDataUrl(url, maxImageBytes) {
  if (typeof url !== 'string' || !url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const meta = url.slice(5, comma).toLowerCase();
  const [mime, ...params] = meta.split(';');
  if (!IMAGE_MIME.has(mime) || !params.includes('base64')) return null;
  const data = url.slice(comma + 1);
  if (Math.floor((data.length * 3) / 4) > maxImageBytes) return null;
  if (!BASE64.test(data)) return null;
  return { mime, data };
}

function imageUrlOf(part) {
  if (typeof part.image_url === 'string') return part.image_url;
  if (part.image_url && typeof part.image_url.url === 'string') return part.image_url.url;
  return null;
}

function jsonText(v, max = 4000) {
  let t;
  try {
    t = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    t = String(v);
  }
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** One Responses content part -> neutral block { kind: 'text'|'image', ... }. Never throws: odd parts become text. */
function neutralPart(part, maxImageBytes) {
  if (typeof part === 'string') return { kind: 'text', text: part };
  if (part === null || typeof part !== 'object') return { kind: 'text', text: jsonText(part) };
  if (typeof part.type !== 'string') return { kind: 'text', text: typeof part.text === 'string' ? part.text : jsonText(part) };
  if (TEXT_PARTS.has(part.type)) return { kind: 'text', text: partText(part) };
  if (part.type === 'input_image' || part.type === 'image') {
    const img = parseDataUrl(imageUrlOf(part), maxImageBytes);
    if (img) return { kind: 'image', ...img };
    return { kind: 'text', text: '[image omitted by the bridge: only inline data-URL PNG/JPEG/GIF/WebP images within the size bound are forwarded; external URLs are never fetched]' };
  }
  return { kind: 'text', text: `[content of type ${String(part.type).slice(0, 40)} omitted by the proxy]` };
}

function neutralContent(content, maxImageBytes) {
  if (typeof content === 'string') return [{ kind: 'text', text: content }];
  if (content === undefined || content === null) return [];
  if (Array.isArray(content)) return content.map((p) => neutralPart(p, maxImageBytes));
  if (typeof content === 'object' && 'content' in content) return neutralContent(content.content, maxImageBytes);
  return [neutralPart(content, maxImageBytes)];
}

function header(text, blocks) {
  return [{ kind: 'text', text }, ...blocks];
}

function blocksFingerprint(blocks) {
  return sha(canonicalJson(blocks.map((b) => (b.kind === 'text' ? ['t', b.text] : ['i', sha(b.data)]))));
}

/**
 * Normalize the request input. Returns items of shape
 *   { kind: 'message', role, blocks, fp }
 *   { kind: 'call', callType, callId, name, namespace, payload, fp }
 *   { kind: 'output', callType, callId, blocks, hash, fp }
 */
export function normalizeInput(input, { maxImageBytes }) {
  if (typeof input === 'string') input = [{ type: 'message', role: 'user', content: input }];
  if (!Array.isArray(input)) throw bridgeError('bad_request', { where: 'input' });
  const out = [];
  for (const raw of input) {
    if (raw === null || typeof raw !== 'object') continue;
    const type = raw.type ?? (raw.role ? 'message' : undefined);
    if (IGNORED_ITEM_TYPES.has(type)) continue;
    if (type === 'compaction' || type === 'compaction_summary') {
      // Ours carries the summary; another provider's is opaque, so say that context is missing.
      const c = readCompaction(raw);
      const text = c ? summaryText(c.summary) : '[Earlier conversation was compacted by another model; its summary is not readable here.]';
      const blocks = [{ kind: 'text', text }];
      out.push({ kind: 'message', role: 'user', blocks, fp: `m:user:${blocksFingerprint(blocks)}` });
      continue;
    }
    const named = [raw.namespace, raw.name].filter((v) => typeof v === 'string' && v).join('.');
    if (type === 'message') {
      const role = ['user', 'developer', 'system', 'assistant'].includes(raw.role) ? raw.role : 'user';
      const blocks = neutralContent(raw.content, maxImageBytes);
      out.push({ kind: 'message', role, blocks, fp: `m:${role}:${blocksFingerprint(blocks)}` });
    } else if ((type === 'function_call' || type === 'custom_tool_call') && (typeof raw.call_id !== 'string' || !raw.call_id)) {
      // A call Codex recorded without an id (e.g. an internal agent call): keep it as text.
      const payload = type === 'function_call' ? raw.arguments : raw.input;
      const blocks = [{ kind: 'text', text: `[earlier tool call ${named || '(unnamed)'}]\n${jsonText(payload ?? '', 20_000)}` }];
      out.push({ kind: 'message', role: 'assistant', blocks, fp: `m:assistant:${blocksFingerprint(blocks)}` });
    } else if ((type === 'function_call_output' || type === 'custom_tool_call_output') && (typeof raw.call_id !== 'string' || !raw.call_id)) {
      // A result Codex recorded without an id (e.g. from another agent or a client tool): keep it as text.
      const blocks = header(`[result${named ? ` from ${named}` : ''}]`, neutralContent(raw.output, maxImageBytes));
      out.push({ kind: 'message', role: 'user', blocks, fp: `m:user:${blocksFingerprint(blocks)}` });
    } else if (type === 'function_call' || type === 'custom_tool_call') {
      const callType = type === 'function_call' ? 'function' : 'custom';
      const payload = callType === 'function' ? raw.arguments : raw.input;
      out.push({
        kind: 'call',
        callType,
        callId: raw.call_id,
        name: typeof raw.name === 'string' ? raw.name : '',
        namespace: typeof raw.namespace === 'string' ? raw.namespace : null,
        payload: typeof payload === 'string' ? payload : canonicalJson(payload ?? null),
        fp: `c:${raw.call_id}`,
      });
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const content = neutralContent(raw.output, maxImageBytes);
      const blocks = content.length ? content : [{ kind: 'text', text: '' }];
      out.push({
        kind: 'output',
        callType: type === 'function_call_output' ? 'function' : 'custom',
        callId: raw.call_id,
        blocks,
        hash: blocksFingerprint(blocks),
        fp: `o:${raw.call_id}`,
      });
    } else if (raw.content !== undefined) {
      // Other items that carry content (agent_message from another Codex agent, ...): keep the text.
      const who = typeof raw.author === 'string' ? ` from ${raw.author}` : '';
      const blocks = header(`[${String(type ?? 'item').slice(0, 40)}${who}]`, neutralContent(raw.content, maxImageBytes));
      out.push({ kind: 'message', role: 'user', blocks, fp: `m:user:${blocksFingerprint(blocks)}` });
    } else {
      // Some other provider-side item (local shell, MCP approval, ...): keep a visible trace.
      out.push({ kind: 'message', role: 'assistant', blocks: [{ kind: 'text', text: `[earlier ${String(type).slice(0, 40)} item omitted by the proxy]` }], fp: `x:${String(type).slice(0, 40)}:${out.length}` });
    }
  }
  return out;
}

/** A Responses item this bridge emitted, in `normalizeInput` form (same fingerprint). */
export function normalizeEmitted(item) {
  if (item.type === 'message') {
    const blocks = item.content.map((c) => ({ kind: 'text', text: c.text }));
    return { kind: 'message', role: 'assistant', blocks, fp: `m:assistant:${blocksFingerprint(blocks)}` };
  }
  const custom = item.type === 'custom_tool_call';
  return {
    kind: 'call',
    callType: custom ? 'custom' : 'function',
    callId: item.call_id,
    name: item.name,
    namespace: item.namespace ?? null,
    payload: custom ? item.input : item.arguments,
    fp: `c:${item.call_id}`,
  };
}

export function emittedFingerprint(item) {
  return normalizeEmitted(item).fp;
}

/** Developer/system-role messages carry Codex's authority; they go to the system prompt. */
export function isAuthorityMessage(item) {
  return item.kind === 'message' && (item.role === 'developer' || item.role === 'system');
}

export function authorityMessages(items) {
  return items.filter(isAuthorityMessage);
}

/** Identity of the effective system authority: instructions, developer/system messages, tool declarations. */
export function authorityKey(instructions, devMessages, toolsFingerprint) {
  return sha(canonicalJson([sha(instructions ?? ''), devMessages.map((m) => m.fp), toolsFingerprint]));
}

/** System-prompt text for developer/system messages, in order. */
export function authorityText(devMessages) {
  return devMessages
    .map((m) => {
      const body = m.blocks.map((b) => (b.kind === 'text' ? b.text : '[image in a Codex developer message: not representable in a system prompt]')).join('\n');
      return `<codex_${m.role}_message>\n${body}\n</codex_${m.role}_message>`;
    })
    .join('\n\n');
}

/**
 * Bound the text of one tool output to `maxChars` in total. Oversized text
 * keeps its head and tail and says exactly how much was cut; nothing is
 * dropped silently. Images are kept (each is already size-bounded).
 */
export function boundOutput(blocks, maxChars) {
  const total = blocks.reduce((n, b) => n + (b.kind === 'text' ? b.text.length : 0), 0);
  if (total <= maxChars) return { blocks, bounded: false };
  const out = blocks.map((b) => {
    if (b.kind !== 'text') return b;
    const share = Math.floor((b.text.length * maxChars) / total);
    if (b.text.length <= share) return b;
    const head = Math.ceil(share / 2);
    const tail = share - head;
    const cut = b.text.length - head - tail;
    return {
      kind: 'text',
      text: `${b.text.slice(0, head)}\n[bridge: ${cut} characters omitted from the middle of this Codex tool output (${b.text.length} total) to keep it within the model context]\n${tail ? b.text.slice(-tail) : ''}`,
    };
  });
  return { blocks: out, bounded: true };
}

export function toClaudeBlocks(blocks) {
  return blocks.map((b) =>
    b.kind === 'text' ? { type: 'text', text: b.text } : { type: 'image', source: { type: 'base64', media_type: b.mime, data: b.data } },
  );
}

export function toMcpContent(blocks) {
  return blocks.map((b) => (b.kind === 'text' ? { type: 'text', text: b.text } : { type: 'image', data: b.data, mimeType: b.mime }));
}

function roleLabel(role) {
  return role === 'user' ? 'User' : 'Assistant (you)';
}

/**
 * Content for a turn made of user messages (the normal start of a
 * conversation, or a later turn). Developer/system messages never travel
 * here: they are part of the system prompt.
 */
export function turnBlocks(messages) {
  const blocks = [];
  for (const m of messages) {
    if (m.role !== 'user') throw bridgeError('internal');
    blocks.push(...m.blocks);
  }
  return mergeEmptyText(blocks);
}

function mergeEmptyText(blocks) {
  const out = blocks.filter((b) => b.kind !== 'text' || b.text.length > 0);
  return out.length ? out : [{ kind: 'text', text: '(empty message)' }];
}

/** Size budget for replaying a conversation into a new Claude session. */
export const REPLAY_LIMITS = Object.freeze({
  /** Characters of transcript text (~250-300k tokens): leaves room in the context and keeps a respawn affordable. */
  budgetChars: 1_000_000,
  /** The most recent tool outputs keep up to this much each. */
  recentOutputs: 12,
  recentOutputChars: 100_000,
  /** Older tool outputs are cut to their head and tail. */
  olderOutputChars: 6_000,
  /** Images replayed (newest first), by count and by total size of their data; older ones become a note. */
  maxImages: 16,
  imageBytes: 24 * 1024 * 1024,
});

/** Newest-first image budget: true while one more image of `size` still fits. */
function imageBudget(limits) {
  let count = 0;
  let bytes = 0;
  return (size) => {
    if (count + 1 > limits.maxImages || bytes + size > limits.imageBytes) return false;
    count += 1;
    bytes += size;
    return true;
  };
}

/**
 * A conversation as kept in memory between turns: only what a replay can
 * still use. Images past the replay's image budget (newest first, counted as
 * planReplay counts them) become its note, and each tool output is cut to the
 * size a replay would give it at its age (the newest `recentOutputs` larger,
 * older ones smaller), so a live conversation's memory stays bounded however
 * long it runs. Fingerprints and hashes keep their values (taken from the full
 * content), so nothing else about the conversation changes.
 */
export function retainForReplay(items, limits = REPLAY_LIMITS) {
  const imageFits = imageBudget(limits);
  let outputsSeen = 0;
  let out = null;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (isAuthorityMessage(it) || !Array.isArray(it.blocks)) continue;
    let blocks = it.blocks;
    let boundedTo = it.boundedTo;
    if (it.kind === 'output') {
      outputsSeen += 1;
      const cap = outputsSeen <= limits.recentOutputs ? limits.recentOutputChars : limits.olderOutputChars;
      if (!(boundedTo <= cap)) {
        const b = boundOutput(blocks, cap);
        blocks = b.blocks;
        boundedTo = cap;
      }
    }
    if (blocks.some((b) => b.kind === 'image')) {
      const kept = blocks.map((b) => (b.kind !== 'image' || imageFits(b.data?.length ?? 0) ? b : { kind: 'text', text: '[earlier image omitted from the replay]' }));
      if (kept.some((b, k) => b !== blocks[k])) blocks = kept;
    }
    if (blocks !== it.blocks || boundedTo !== it.boundedTo) {
      out ??= items.slice();
      out[i] = { ...it, blocks, ...(boundedTo === undefined ? {} : { boundedTo }) };
    }
  }
  return out ?? items;
}

function blocksChars(blocks) {
  return blocks.reduce((n, b) => n + (b.kind === 'text' ? b.text.length : 2_000), 0);
}

function renderItem(it, outputCap) {
  if (it.kind === 'message') return [{ kind: 'text', text: `--- ${roleLabel(it.role)} ---` }, ...it.blocks];
  if (it.kind === 'call') {
    const name = it.namespace ? `${it.namespace}.${it.name}` : it.name;
    return [{ kind: 'text', text: `--- Assistant (you) tool call ${name} [${it.callId}] ---\n${it.payload}` }];
  }
  // an output already kept at most this size (retainForReplay) is not cut again
  if (it.kind === 'output') return [{ kind: 'text', text: `--- Codex tool output [${it.callId}] ---` }, ...(it.boundedTo && it.boundedTo <= outputCap ? it.blocks : boundOutput(it.blocks, outputCap).blocks)];
  return null;
}

/**
 * Which part of a conversation fits a replay: rendered newest first within
 * the budget. { items, hasHistory, rendered (oldest first), omitted (count of
 * leading items left out) }.
 */
export function planReplay(allItems, { maxToolOutputChars = Infinity, limits = REPLAY_LIMITS } = {}) {
  const items = allItems.filter((i) => !isAuthorityMessage(i));
  const hasHistory = items.some((i) => i.kind !== 'message' || i.role === 'assistant');
  const rendered = [];
  let outputsSeen = 0;
  const imageFits = imageBudget(limits);
  let used = 0;
  let omitted = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it.kind === 'output') outputsSeen += 1;
    const cap = Math.min(maxToolOutputChars, outputsSeen <= limits.recentOutputs ? limits.recentOutputChars : limits.olderOutputChars);
    let blocks = renderItem(it, cap);
    if (!blocks) continue;
    blocks = blocks.map((b) => (b.kind !== 'image' || imageFits(b.data?.length ?? 0) ? b : { kind: 'text', text: '[earlier image omitted from the replay]' }));
    const size = blocksChars(blocks);
    if (used + size > limits.budgetChars && rendered.length > 0) {
      omitted = i + 1;
      break;
    }
    used += size;
    rendered.push(blocks);
  }
  rendered.reverse();
  return { items, hasHistory, rendered, omitted };
}

/**
 * A conversation as plain text for a summarizer, in chunks of at most
 * `chunkChars` (oldest first, nothing left out): tool outputs shortened, no
 * images. The summarizer takes the chunks in order (summarize.mjs).
 */
export function transcriptChunks(items, { chunkChars = 800_000, outputChars = 2_000 } = {}) {
  const chunks = [];
  let current = [];
  let used = 0;
  for (const it of items) {
    const blocks = renderItem(it, outputChars);
    if (!blocks) continue;
    let text = blocks.map((b) => (b.kind === 'text' ? b.text : '[image]')).join('\n');
    // one item larger than a whole chunk (a huge pasted text) keeps its head and tail
    if (text.length > chunkChars) text = boundOutput([{ kind: 'text', text }], chunkChars - 200).blocks[0].text;
    if (used + text.length + 1 > chunkChars && current.length) {
      chunks.push(current.join('\n'));
      current = [];
      used = 0;
    }
    current.push(text);
    used += text.length + 1;
  }
  if (current.length) chunks.push(current.join('\n'));
  return chunks;
}

/**
 * Content that replays a whole existing Codex conversation into a new Claude
 * process (first request after a proxy restart, a model or account switch,
 * history rewritten by compaction, or a changed tool set). Tool calls in it
 * were already executed by Codex; their recorded outputs are replayed, never
 * re-run. A conversation larger than the budget keeps its most recent part in
 * full; the earlier part is given as `summary` when one was made, otherwise
 * its omission is stated.
 */
export function replayBlocks(allItems, { maxToolOutputChars = Infinity, limits = REPLAY_LIMITS, summary = null } = {}) {
  const plan = planReplay(allItems, { maxToolOutputChars, limits });
  if (!plan.hasHistory) return turnBlocks(plan.items);
  const lead = 'The proxy started a new Claude session for an existing Codex conversation.';
  const rules = 'Tool calls in the transcript were already executed by Codex and their real outputs are shown; do not repeat them unless the task needs fresh results. Continue the conversation from its end.';
  let intro;
  const extra = [];
  if (plan.omitted && summary) {
    intro = `${lead} It is long: its first ${plan.omitted} items are given as a summary (written from the original transcript), followed by the most recent part verbatim, in order. ${rules}`;
    extra.push({ kind: 'text', text: `--- Summary of the earlier part of this conversation ---\n${summary}\n--- End of summary; the most recent part follows ---` });
  } else if (plan.omitted) {
    intro = `${lead} It is long, so its first ${plan.omitted} items were left out; the transcript below is the most recent part, in order (older outputs shortened). If something you need from the earlier part is missing, ask the user or re-read the files. ${rules}`;
  } else {
    intro = `${lead} The transcript below is that conversation so far, replayed in order. ${rules}`;
  }
  const blocks = [{ kind: 'text', text: intro }, ...extra, ...plan.rendered.flat()];
  const last = plan.items[plan.items.length - 1];
  if (last && last.kind !== 'message') blocks.push({ kind: 'text', text: '--- end of transcript: continue from the last tool output ---' });
  return mergeEmptyText(blocks);
}
