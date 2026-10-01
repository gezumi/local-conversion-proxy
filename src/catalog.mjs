// The models this proxy serves itself, as Codex model-catalog entries.
//
// They are appended to the upstream /models list, so Codex (desktop, phone via
// remote control, CLI) shows them next to the GPT models while the provider
// stays the built-in `openai` one. Every other slug belongs to the upstream.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE_INSTRUCTIONS = readFileSync(new URL('./data/codex-base-instructions.md', import.meta.url), 'utf8');

const CLAUDE_EFFORTS = [
  ['low', '速さ優先'],
  ['medium', 'バランス'],
  ['high', 'じっくり考える'],
  ['xhigh', 'さらに深く考える'],
  ['max', '最大限に考える'],
];
const OLLAMA_EFFORTS = [
  ['low', '速さ優先'],
  ['medium', 'バランス'],
  ['high', 'じっくり考える'],
];

/** Every slug of this proxy's own starts so (Claude model ids are claude-…, Ollama slugs local-…). */
export const LOCAL_SLUG = /^(claude-|local-)/;

/** Slug for (Claude model, account). Account 1 keeps the plain model id. */
export function claudeSlug(modelId, accountId) {
  return accountId === '1' ? modelId : `${modelId}-a${accountId}`;
}

export function ollamaSlug(ollamaModel) {
  return `local-${String(ollamaModel).replace(/[^A-Za-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

export function accountDisplayName(settings, account, modelName) {
  if (account.id === '1' && !account.label) return modelName;
  const label = account.label || account.id;
  return String(settings.claude.labelFormat || '{model} · {label}').replaceAll('{model}', modelName).replaceAll('{label}', label);
}

function efforts(list) {
  return list.map(([effort, description]) => ({ effort, description }));
}

function claudeInfo({ slug, displayName, accountText, priority }) {
  return {
    slug,
    display_name: displayName,
    description: `Claude Code のサブスク枠で実行（${accountText}）。ツールは Codex が実行します。`,
    default_reasoning_level: 'high',
    supported_reasoning_levels: efforts(CLAUDE_EFFORTS),
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority,
    upgrade: null,
    base_instructions: BASE_INSTRUCTIONS,
    default_reasoning_summary: 'none',
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: 'freeform',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: true,
    context_window: 1_000_000,
    max_context_window: 1_000_000,
    effective_context_window_percent: 90,
    experimental_supported_tools: [],
    input_modalities: ['text', 'image'],
    supports_search_tool: false,
    use_responses_lite: false,
  };
}

function ollamaInfo({ slug, displayName, contextWindow, priority }) {
  return {
    slug,
    display_name: displayName,
    description: 'この Mac の Ollama で実行（ローカル・追加料金なし）。',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: efforts(OLLAMA_EFFORTS),
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority,
    upgrade: null,
    base_instructions: BASE_INSTRUCTIONS,
    default_reasoning_summary: 'none',
    support_verbosity: false,
    default_verbosity: null,
    // Codex's model list rejects "function" here; the Ollama backend turns freeform tools into functions.
    apply_patch_tool_type: 'freeform',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: false,
    context_window: contextWindow,
    max_context_window: contextWindow,
    effective_context_window_percent: 85,
    experimental_supported_tools: [],
    input_modalities: ['text'],
    supports_search_tool: false,
    use_responses_lite: false,
  };
}

/**
 * All local entries: [{ slug, backend, info, target, disabled }], where target
 * says how to run the slug: Claude { model, account } or Ollama { model }.
 * `avail` (see availability.mjs) hides what this Mac cannot run right now.
 * Turned-off accounts and Ollama are left out, or with `includeDisabled`
 * (for routing: their requests are refused locally) marked disabled.
 */
export function buildCatalog(settings, avail = null, { includeDisabled = false } = {}) {
  const out = [];
  let priority = 200;
  // every slug names exactly one entry: an Ollama id that sanitizes to a taken slug gets a short hash of the id
  const taken = new Set(settings.claude.accounts.flatMap((a) => settings.claude.models.map((m) => claudeSlug(m.id, a.id))));
  const uniqueOllamaSlug = (id) => {
    const base = ollamaSlug(id);
    const hash = createHash('sha256').update(id).digest('hex');
    let slug = base;
    for (let n = 6, k = 2; taken.has(slug); n += 2) slug = n <= hash.length ? `${base}-${hash.slice(0, n)}` : `${base}-${hash.slice(0, 8)}-${k++}`;
    taken.add(slug);
    return slug;
  };
  for (const account of settings.claude.accounts) {
    if (account.disabled && !includeDisabled) continue;
    if (avail && !avail.claudeAccount(account.id)) continue;
    for (const m of settings.claude.models) {
      const slug = claudeSlug(m.id, account.id);
      const displayName = accountDisplayName(settings, account, m.name);
      const accountText = account.id === '1' ? 'アカウント1' : `アカウント${account.id}${account.label ? `「${account.label}」` : ''}`;
      out.push({ slug, backend: 'claude', disabled: account.disabled === true, target: { model: m.id, modelName: m.name, account }, info: claudeInfo({ slug, displayName, accountText, priority: priority++ }) });
    }
  }
  if (settings.ollama?.enabled || includeDisabled) {
    for (const m of settings.ollama?.models ?? []) {
      const slug = uniqueOllamaSlug(m.id);
      if (avail && !avail.ollamaModel(m.id)) continue;
      const contextWindow = m.contextWindow ?? 32768;
      // numCtx: null means "the model's own context" (no derived model); absent means the catalog window.
      const numCtx = m.numCtx === undefined ? contextWindow : m.numCtx;
      out.push({ slug, backend: 'ollama', disabled: !settings.ollama?.enabled, target: { model: m.id, contextWindow, numCtx }, info: ollamaInfo({ slug, displayName: m.name ?? m.id, contextWindow, priority: priority++ }) });
    }
  }
  return out;
}

/** Append local entries to an upstream /models body (object with `models`). Upstream entries win on a slug clash. */
export function injectModels(upstreamBody, catalog) {
  // An upstream shape we do not recognise is returned untouched: GPT must never depend on our parsing.
  if (!upstreamBody || typeof upstreamBody !== 'object' || !Array.isArray(upstreamBody.models)) return upstreamBody;
  const models = upstreamBody.models;
  const taken = new Set(models.map((m) => m?.slug));
  const extra = catalog.filter((e) => !taken.has(e.slug)).map((e) => e.info);
  return { ...upstreamBody, models: [...models, ...extra] };
}
