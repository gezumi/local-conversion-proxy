// Context compaction for locally served models.
//
// Codex compacts an `openai`-provider thread by sending a request whose input
// is `{ type: 'compaction_trigger' }` and expecting exactly one `compaction`
// item back; that item then replaces the earlier history. For our models the
// item carries a handoff summary written by the model itself, marked so this
// proxy can recognise it later. A request bound for OpenAI never receives our
// item as such (OpenAI could not decrypt it): it becomes a plain summary message.

import { rid } from './responses.mjs';

export const PREFIX = 'lcp-compaction:v1:';

export const COMPACTION_PROMPT = `[Context checkpoint requested by Codex — do not call any tools]
The conversation is about to be compacted. Write a handoff summary that lets you (or another model) continue this task seamlessly with no other context.
Include: the user's goals and explicit instructions or preferences (quote important ones verbatim); key decisions and why; the current state of the work (files changed, commands run and their results, what is verified and what is not); open problems and the exact next steps; every identifier, path, name, number or code snippet that will still be needed.
Be complete but concise. Reply with the summary only, in the language the user has been using.`;

export function isCompactionRequest(body) {
  return Array.isArray(body?.input) && body.input.some((i) => i?.type === 'compaction_trigger');
}

export function makeCompactionItem(summary, model) {
  const payload = Buffer.from(JSON.stringify({ summary, model, at: new Date().toISOString() }), 'utf8').toString('base64url');
  return { type: 'compaction', id: rid('cmp'), encrypted_content: `${PREFIX}${payload}` };
}

/** Our compaction item -> { summary, model, at }; anything else -> null. */
export function readCompaction(item) {
  if (!item || (item.type !== 'compaction' && item.type !== 'compaction_summary')) return null;
  const c = item.encrypted_content;
  if (typeof c !== 'string' || !c.startsWith(PREFIX)) return null;
  try {
    const v = JSON.parse(Buffer.from(c.slice(PREFIX.length), 'base64url').toString('utf8'));
    return typeof v?.summary === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function summaryText(summary) {
  return `[Summary of the earlier conversation (context compaction) / これまでの会話の要約]\n\n${summary}`;
}

/** Our compaction item as a plain user message (for OpenAI or Ollama). */
export function compactionAsMessage(item) {
  const c = readCompaction(item);
  return c ? { type: 'message', role: 'user', content: [{ type: 'input_text', text: summaryText(c.summary) }] } : null;
}

/** For a request going to OpenAI: replace our compaction items. Returns null when nothing needed changing. */
export function rewriteForUpstream(body) {
  if (!Array.isArray(body?.input) || !body.input.some((i) => readCompaction(i))) return null;
  return { ...body, input: body.input.map((i) => compactionAsMessage(i) ?? i) };
}
