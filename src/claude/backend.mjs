// Claude backend: runs Codex turns on Claude Code with the user's subscription.
//
// A Codex conversation maps to one live Claude Code process. When Claude calls
// a relay tool, the response ends with the matching function_call /
// custom_tool_call item while the MCP call stays held; the next request
// carrying that call_id's output answers it exactly once and streams what
// Claude does next.
//
// A request continues a session only when its held call_ids, its
// previous_response_id and its conversation key agree, and its effective
// authority (model, effort, account, instructions, developer/system messages,
// tool declarations) is the session's. Anything else is an explicit restart:
// the old process is reaped and a new one receives the new authority as its
// system prompt and the whole conversation, including every real tool output,
// as a replayed transcript.

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { BoundedMap } from '../bounded.mjs';
import { COMPACTION_PROMPT, isCompactionRequest, makeCompactionItem } from '../compaction.mjs';
import { ResponseStream } from '../responses.mjs';
import { buildClaudeEnv, checkClaudeAuth, claudeEffort } from './claude-cli.mjs';
import { ClaudeSession } from './claude-session.mjs';
import { DEFAULT_LIMITS, defaultClaudeBin } from './config.mjs';
import { authorityKey, authorityMessages, isAuthorityMessage, normalizeEmitted, normalizeInput, planReplay, replayBlocks, retainForReplay, transcriptChunks, turnBlocks } from './convert.mjs';
import { COMPACTION_SUMMARY_PROMPT, summarizeChunks } from './summarize.mjs';
import { bridgeError, toBridgeError } from './errors.mjs';
import { RelayServer } from './relay.mjs';
import { RuntimeDirs } from './runtime-dir.mjs';
import { ToolTable } from './tools.mjs';

export const MCP_SERVER_PATH = fileURLToPath(new URL('./mcp-server.mjs', import.meta.url));

function headerString(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null;
}

function sha(s) {
  return createHash('sha256').update(s).digest('hex');
}

/** An account as the CLI sees it: its id and the login directory it runs with (another directory is another login). */
function accountIdentity(account) {
  return `${account?.id ?? '1'}\u0000${account?.configDir ?? ''}`;
}

function uniqueByFp(messages) {
  const seen = new Set();
  return messages.filter((m) => (seen.has(m.fp) ? false : (seen.add(m.fp), true)));
}

/**
 * opts: { logger, claudeBin?, limits?, envSource?, nodeBin?, mcpServerPath?, dirs?, ownership? }
 * Returns { handle(body, sink, ctx), health(), close() }.
 */
export async function createClaudeBackend(opts = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  const logger = opts.logger ?? { event() {} };
  const dirs = opts.dirs ?? new RuntimeDirs();
  const runtimeRoot = dirs.make('lcp-');
  const relay = new RelayServer({ socketPath: join(runtimeRoot, 'r.sock'), maxLineBytes: limits.maxLineBytes });
  await relay.listen();

  const sessions = new Map(); // id -> live session
  const byKey = new Map(); // conversation key -> session
  const byResponse = new Map(); // latest response id -> session
  const unreaped = new Set();
  const admissions = new Set();
  const reservedKeys = new Map();
  /** Prewarm response id -> its input items: Codex chains the first real turn to it. Bounded in count and size. */
  const prewarms = new BoundedMap({ maxEntries: 256, maxBytes: limits.prewarmBytes });
  /**
   * Response id -> whole conversation, for responses whose session is gone
   * (interrupted, evicted, timed out): a chained delta replays into a new
   * session. Bounded in count and size (kept as a replay can use it).
   */
  const orphans = new BoundedMap({ maxEntries: 256, maxBytes: limits.orphanBytes });
  let closing = false;

  function rememberPrewarm(id, items) {
    prewarms.set(id, retainForReplay(items));
  }

  /** Summaries of the earlier part of long conversations (same earlier part -> same summary). Bounded. */
  const summaries = new BoundedMap({ maxEntries: 64, maxBytes: 16 * 1024 * 1024 });

  /**
   * The account gate (signed in, Claude.ai subscription route), before any
   * process receives conversation content: also the one-shot summarizer.
   */
  async function ensureSubscription(account, signal) {
    if (authCache.fresh(account)) return;
    const tmp = dirs.make('auth-', runtimeRoot);
    try {
      const env = buildClaudeEnv(sessionCfg.envSource, { tmpDir: tmp, mcpToolTimeoutMs: 60_000, configDir: account?.configDir ?? null });
      await checkClaudeAuth({ bin: sessionCfg.claudeBin, env, cwd: tmp, signal });
      authCache.mark(account);
    } catch (err) {
      if (toBridgeError(err).code === 'claude_auth') {
        authCache.clear(account);
        opts.onAuthFailure?.(account?.id ?? '1');
      }
      throw err;
    } finally {
      dirs.remove(tmp);
    }
  }

  /**
   * The replay for a new session: a long conversation's earlier part is
   * summarized first (once; cached), the rest goes in verbatim.
   */
  async function replayFor(history, { account, signal }) {
    const opts = { maxToolOutputChars: limits.maxToolOutputChars };
    const plan = planReplay(history, opts);
    if (!plan.hasHistory || !plan.omitted) return replayBlocks(history, opts);
    const earlier = plan.items.slice(0, plan.omitted);
    const key = sha(`${accountIdentity(account)}\u0000${earlier.map(contentId).join('\u0000')}`);
    let summary = summaries.get(key);
    if (summary === undefined) {
      await ensureSubscription(account, signal);
      logger.event('replay_summarizing', { items: earlier.length });
      summary = await summarizeChunks(transcriptChunks(earlier, { chunkChars: limits.summaryChunkChars }), { claudeBin: sessionCfg.claudeBin, envSource: sessionCfg.envSource, dirs, rootDir: runtimeRoot, account, signal });
      if (signal?.aborted) throw bridgeError('client_disconnected');
      logger.event(summary ? 'replay_summarized' : 'replay_summary_failed', { items: earlier.length });
      if (summary) summaries.set(key, summary);
    }
    return replayBlocks(history, { ...opts, summary: summary ?? null });
  }

  /**
   * The same conversation, item for item (developer/system messages aside: they
   * are part of the authority key). Calls compare by id, type, tool and
   * payload, outputs by id and content hash, messages by content fingerprint.
   */
  function sameConversation(a, b) {
    const keys = (list) => list.filter((i) => !isAuthorityMessage(i)).map((i) => (i.kind === 'call' ? `${i.fp}:${sha(`${i.callType}\u0000${i.namespace ?? ''}\u0000${i.name}\u0000${i.payload ?? ''}`)}` : i.kind === 'output' ? `${i.fp}:${i.hash}` : i.fp));
    const x = keys(a);
    const y = keys(b);
    return x.length === y.length && x.every((k, n) => k === y[n]);
  }

  /** An item's identity with its content (the fingerprint of a call or an output is only its call id). */
  function contentId(i) {
    if (i.kind === 'call') return `${i.fp}:${sha(`${i.namespace ?? ''}\u0000${i.name}\u0000${i.payload}`)}`;
    if (i.kind === 'output') return `${i.fp}:${i.hash}`;
    return i.fp;
  }

  function rememberOrphan(id, items) {
    if (!id) return;
    orphans.set(id, retainForReplay(items));
  }

  /** Verified logins, per account identity (id and login directory). */
  const authCache = {
    stamps: new Map(),
    fresh(account) {
      const t = this.stamps.get(accountIdentity(account));
      return Boolean(t) && Date.now() - t < limits.authCacheMs;
    },
    mark(account) {
      this.stamps.set(accountIdentity(account), Date.now());
    },
    clear(account) {
      this.stamps.delete(accountIdentity(account));
    },
  };

  const sessionCfg = {
    claudeBin: opts.claudeBin ?? defaultClaudeBin(),
    envSource: opts.envSource ?? process.env,
    limits,
    dirs,
    rootDir: runtimeRoot,
    relay,
    nodeBin: opts.nodeBin ?? process.execPath,
    mcpServerPath: opts.mcpServerPath ?? MCP_SERVER_PATH,
    logger,
    authCache,
    ownership: opts.ownership,
    // A login that expired mid-use: forget the cached check and let the model list catch up.
    onAuthFailure: (account) => {
      authCache.clear(account);
      opts.onAuthFailure?.(account?.id ?? '1');
    },
  };

  function forget(s) {
    if (s.lastResponseId) rememberOrphan(s.lastResponseId, [...s.history]);
    sessions.delete(s.id);
    if (s.key && byKey.get(s.key) === s) byKey.delete(s.key);
    if (s.lastResponseId && byResponse.get(s.lastResponseId) === s) byResponse.delete(s.lastResponseId);
    if (s.reaped === false) unreaped.add(s);
  }

  function alive(s) {
    return s && s.state !== 'dead' ? s : null;
  }

  function occupiedSlots() {
    let n = sessions.size + [...unreaped].filter((s) => s.holdsLiveGroups()).length;
    for (const a of admissions) {
      if (a.session) continue;
      if (!a.transfer || !sessions.has(a.transfer.id)) n += 1;
    }
    return n;
  }

  /** Reserve a start synchronously: the conversation key and one capacity slot. */
  function reserve(key, replacing) {
    if (closing) throw bridgeError('shutting_down');
    if (key && reservedKeys.has(key)) throw bridgeError('session_busy');
    let transfer = replacing;
    const extra = replacing ? 0 : 1;
    if (occupiedSlots() + extra > limits.maxSessions) {
      if (replacing) throw bridgeError('too_many_sessions');
      const transferred = new Set([...admissions].map((a) => a.transfer));
      const quiet = [...sessions.values()].filter((s) => s.quiescent && !transferred.has(s)).sort((a, b) => a.lastUsed - b.lastUsed);
      // Next best: a conversation abandoned in the middle of a tool call (its next request replays the transcript).
      const stale = [...sessions.values()].filter((s) => !s.busy && !transferred.has(s) && s.state === 'awaiting' && Date.now() - s.lastUsed > limits.staleAwaitingMs).sort((a, b) => a.lastUsed - b.lastUsed);
      if (!quiet.length && stale.length) quiet.push(stale[0]);
      if (!quiet.length) throw bridgeError('too_many_sessions');
      transfer = quiet[0];
      logger.event('session_evict');
      transfer.kill('evicted');
    }
    let done;
    const adm = { key, transfer, session: null, settled: new Promise((r) => (done = r)), done };
    admissions.add(adm);
    if (key) reservedKeys.set(key, adm);
    return adm;
  }

  async function admit(adm, cfg) {
    try {
      if (adm.transfer) await adm.transfer.kill(adm.transfer.state === 'dead' ? 'evicted' : 'respawn');
      if (closing) throw bridgeError('shutting_down');
      // Before any process starts: a long conversation's earlier part is summarized first.
      const firstBlocks = await replayFor(cfg.history, { account: cfg.account, signal: cfg.signal });
      if (closing) throw bridgeError('shutting_down');
      if (cfg.signal?.aborted) throw bridgeError('client_disconnected');
      const s = new ClaudeSession({ ...sessionCfg, ...cfg, onDeath: forget });
      sessions.set(s.id, s);
      if (cfg.key) byKey.set(cfg.key, s);
      s.busy = true;
      adm.session = s;
      await s.start(firstBlocks);
      if (closing || s.state === 'dead') throw s.error ?? bridgeError('shutting_down');
      return s;
    } catch (err) {
      if (toBridgeError(err).code === 'claude_auth') authCache.clear(cfg.account);
      if (adm.session) adm.session.kill(closing ? 'shutdown' : 'start_rollback');
      throw err;
    } finally {
      admissions.delete(adm);
      if (adm.key && reservedKeys.get(adm.key) === adm) reservedKeys.delete(adm.key);
      adm.done();
    }
  }

  /** Deliver held outputs, start a new user turn, or restart. Invalid outputs throw before anything changes. */
  function classify(session, items, { prevId, authKey }) {
    const awaiting = session.awaitingCallIds();
    let tail;
    if (prevId) {
      tail = items;
    } else {
      const fps = items.map((i) => i.fp);
      let pos = -1;
      for (const a of [...session.anchors].reverse()) {
        pos = fps.lastIndexOf(a);
        if (pos >= 0) break;
      }
      if (pos < 0 && awaiting.length) pos = Math.max(...awaiting.map((id) => fps.lastIndexOf(`c:${id}`)));
      if (pos < 0) return { kind: 'respawn', why: 'no_anchor' };
      // Everything up to the anchor must be what the session already holds: an earlier
      // message, call or tool result changed since (an edit, a compaction) means a stale context.
      if (!sameConversation(items.slice(0, pos + 1), session.history)) return { kind: 'respawn', why: 'history_changed' };
      tail = items.slice(pos + 1);
    }
    const seen = new Map();
    const outputs = [];
    const messages = [];
    let foreign = false;
    for (const it of tail) {
      if (it.kind === 'output') {
        if (seen.has(it.callId)) {
          if (seen.get(it.callId) !== it.hash) throw bridgeError('output_duplicate');
          continue;
        }
        seen.set(it.callId, it.hash);
        if (awaiting.includes(it.callId)) {
          if (session.pending.get(it.callId).entry.kind !== it.callType) return { kind: 'respawn', why: 'kind' };
          outputs.push(it);
        } else if (session.delivered.has(it.callId)) {
          if (session.delivered.get(it.callId) !== it.hash) return { kind: 'respawn', why: 'history_changed' };
        } else {
          return { kind: 'respawn', why: 'history_changed' };
        }
      } else if (it.kind === 'message' && it.role === 'user') {
        messages.push(it);
      } else if (it.kind === 'message' && it.role !== 'assistant') {
        // developer/system: covered by the authority key
      } else {
        foreign = true;
      }
    }
    if (authKey !== session.authorityKey) return { kind: 'respawn', why: 'authority_changed' };
    if (awaiting.length) {
      if (foreign || outputs.length !== awaiting.length) return { kind: 'respawn', why: 'outputs_missing' };
      if (messages.length) return { kind: 'respawn', why: 'input_during_tool_call' };
      return { kind: 'deliver', outputs };
    }
    if (foreign || !messages.length) return { kind: 'respawn', why: foreign ? 'history_changed' : 'nothing_new' };
    if (session.state !== 'idle') return { kind: 'respawn', why: 'not_idle' };
    return { kind: 'turn', messages };
  }

  async function streamTurn(session, stream) {
    let usage = null;
    let calls = [];
    for (;;) {
      const ev = await session.next(limits.generationIdleMs);
      if (ev.type === 'text') {
        stream.text(ev.text, { separate: ev.separate });
      } else if (ev.type === 'call') {
        calls.push(ev.callId);
        for (;;) {
          const more = await session.next(limits.generationIdleMs, limits.callCoalesceMs);
          if (!more) break;
          if (more.type === 'call') calls.push(more.callId);
          else {
            session.pushBack(more);
            break;
          }
        }
        calls = calls.filter((id) => session.pending.has(id));
        if (calls.length) break;
      } else if (ev.type === 'done') {
        usage = ev.usage;
        break;
      }
    }
    const emitted = [];
    const msg = stream.closeMessage();
    if (msg) emitted.push(msg);
    for (const callId of calls) {
      const p = session.pending.get(callId);
      stream.callItem(p.item);
      session.markEmitted(callId);
      emitted.push(p.item);
    }
    const normalized = emitted.map(normalizeEmitted);
    if (emitted.length) session.anchors = normalized.map((i) => i.fp);
    session.history.push(...normalized);
    session.history = retainForReplay(session.history);
    stream.completed(usage ?? session.lastUsage);
    if (session.state !== 'dead') {
      if (session.lastResponseId) byResponse.delete(session.lastResponseId);
      session.lastResponseId = stream.id;
      byResponse.set(stream.id, session);
    }
    logger.event('claude_response_done', { calls: calls.length, text: Boolean(msg) });
  }

  /**
   * Serve one Responses request on `sink`. Never throws: every failure ends
   * the response with response.failed carrying a fixed, user-readable message.
   */
  async function handle(body, sink, ctx) {
    const target = ctx.entry.target;
    const stream = new ResponseStream(sink, { model: ctx.entry.slug, keepaliveMs: limits.keepaliveMs });
    ctx.onResponseId?.(stream.id);
    let session = null;
    // The session this request marked busy: the only one it may kill or release.
    let held = null;
    // A session this request is starting (killed on Esc before it is even handed over).
    let admission = null;
    // The whole conversation as this request sees it (kept if the request is interrupted).
    let requestHistory = null;
    let interrupted = false;
    // Esc in Codex (response.interrupt) or a closed connection: stop Claude; the next turn replays the transcript.
    const onAbort = () => {
      interrupted = true;
      held?.kill('client_disconnected');
      admission?.session?.kill('client_disconnected');
    };
    if (ctx.signal?.aborted) interrupted = true;
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (interrupted) throw bridgeError('client_disconnected');
      if (closing) throw bridgeError('shutting_down');
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw bridgeError('bad_request');
      // Prewarm (`generate: false`): nothing to generate, no process to start.
      if (body.generate === false) {
        let items = [];
        try {
          items = normalizeInput(body.input ?? [], { maxImageBytes: limits.maxImageBytes });
        } catch {
          items = [];
        }
        stream.created();
        stream.completed(null);
        rememberPrewarm(stream.id, items);
        return;
      }
      // Context compaction: one compaction item summarizing exactly the conversation of this request.
      // The live session writes it when it holds that conversation (same model and login); otherwise a
      // one-shot run summarizes the conversation's transcript. Another session of the thread never does.
      if (isCompactionRequest(body)) {
        const cprev = headerString(body.previous_response_id);
        const delta = normalizeInput(body.input, { maxImageBytes: limits.maxImageBytes });
        let live = null;
        let conversation;
        if (cprev) {
          live = alive(byResponse.get(cprev));
          const before = live ? live.history : orphans.has(cprev) ? orphans.get(cprev) : prewarms.has(cprev) ? prewarms.get(cprev) : null;
          if (!before) throw bridgeError('previous_response_unknown');
          conversation = [...before, ...delta];
          if (delta.some((i) => !isAuthorityMessage(i))) live = null; // items the session has not seen
        } else {
          conversation = delta;
          const thread = ctx.key ? alive(byKey.get(ctx.key)) : null;
          if (thread && sameConversation(delta, thread.history)) live = thread;
        }
        if (live && (live.model !== target.model || accountIdentity(live.account) !== accountIdentity(target.account))) live = null;
        // Codex compacts in the middle of a turn too (a tool call still waiting for its output): the
        // session cannot write the summary then, the transcript can — never refuse a compaction for it.
        if (live && (live.busy || live.state !== 'idle' || live.awaitingCallIds().length)) live = null;
        if (!conversation.some((i) => !isAuthorityMessage(i))) throw bridgeError('compaction_unavailable');
        stream.created();
        let summary = '';
        let usage = null;
        if (live) {
          session = live;
          session.busy = true;
          held = session;
          await session.sendTurn([{ kind: 'text', text: COMPACTION_PROMPT }]);
          for (;;) {
            const ev = await session.next(limits.generationIdleMs);
            if (ev.type === 'text') summary += ev.separate && summary ? `\n\n${ev.text}` : ev.text;
            else if (ev.type === 'call') throw bridgeError('claude_protocol');
            else if (ev.type === 'done') {
              usage = ev.usage;
              break;
            }
          }
        } else {
          await ensureSubscription(target.account, ctx.signal);
          summary = (await summarizeChunks(transcriptChunks(conversation, { chunkChars: limits.summaryChunkChars }), { claudeBin: sessionCfg.claudeBin, envSource: sessionCfg.envSource, dirs, rootDir: runtimeRoot, account: target.account, prompt: COMPACTION_SUMMARY_PROMPT, signal: ctx.signal })) ?? '';
          if (interrupted) throw bridgeError('client_disconnected');
        }
        if (!summary.trim()) throw bridgeError('claude_error');
        stream.rawItem(makeCompactionItem(summary.trim(), ctx.entry.slug));
        stream.completed(usage);
        logger.event('claude_compacted', { from_session: Boolean(live) });
        return;
      }
      if (body.instructions !== undefined && body.instructions !== null && typeof body.instructions !== 'string') throw bridgeError('bad_request', { where: 'instructions' });
      const prevIdRaw = body.previous_response_id;
      if (prevIdRaw !== undefined && prevIdRaw !== null && headerString(prevIdRaw) === null) throw bridgeError('bad_request', { where: 'previous_response_id' });
      let prevId = prevIdRaw ?? null;
      const instructions = body.instructions ?? '';
      let items = normalizeInput(body.input, { maxImageBytes: limits.maxImageBytes });
      // A turn chained to a prewarm, or to a response whose session is gone:
      // what we kept plus this delta is the whole conversation (replayed into a new session).
      // What we kept stays until this response succeeds, so a retry (e.g. after a login) still has it.
      let consumed = null;
      if (prevId && prewarms.has(prevId)) {
        items = [...prewarms.get(prevId), ...items];
        consumed = { store: prewarms, id: prevId };
        prevId = null;
      } else if (prevId && !alive(byResponse.get(prevId)) && orphans.has(prevId)) {
        items = [...orphans.get(prevId), ...items];
        consumed = { store: orphans, id: prevId };
        prevId = null;
      }
      const tools = new ToolTable(body.tools, { maxDescriptionChars: limits.maxDescriptionChars });
      const key = ctx.key ?? headerString(body.prompt_cache_key);
      const effort = claudeEffort(body.reasoning?.effort);
      const account = target.account;

      const outputIds = new Set(items.filter((i) => i.kind === 'output').map((i) => i.callId));
      const owners = [...sessions.values()].filter((s) => alive(s) && s.awaitingCallIds().some((id) => outputIds.has(id)));
      if (owners.length > 1) throw bridgeError('output_mixed_sessions');
      const owner = owners[0] ?? null;
      let prevSession = null;
      if (prevId) {
        prevSession = alive(byResponse.get(prevId));
        if (!prevSession) throw bridgeError('previous_response_unknown');
        if (owner && owner !== prevSession) throw bridgeError('response_mismatch');
      }
      session = owner ?? prevSession ?? (key ? alive(byKey.get(key)) : null);
      if (session && key && session.key && session.key !== key) throw bridgeError('response_mismatch');
      if (session?.busy) throw bridgeError('session_busy');

      // Codex repeats some developer reminders every turn: the same text twice is one authority.
      const devMessages = uniqueByFp(prevId ? [...session.devMessages, ...authorityMessages(items)] : authorityMessages(items));
      // Model, effort and account are part of the authority: changing any of them is a new process.
      const authKey = authorityKey(`${sha(instructions)}\u0000${target.model}\u0000${effort ?? ''}\u0000${accountIdentity(account)}`, devMessages, tools.fingerprint);
      const fullHistory = prevId ? [...session.history, ...items] : items;
      requestHistory = fullHistory;
      let plan = session ? classify(session, items, { prevId, authKey }) : { kind: 'new' };
      if (plan.kind === 'respawn' || !session) {
        const replacing = session;
        const adm = reserve(key, replacing);
        admission = adm;
        if (replacing) {
          replacing.busy = true;
          held = replacing;
          logger.event('session_respawn', { why: plan.why });
        }
        // The response is under way (keepalives flow) while a long history is summarized and Claude starts.
        stream.created();
        session = await admit(adm, { key, tools, instructions, devMessages, authorityKey: authKey, history: retainForReplay(fullHistory), model: target.model, effort, account, displayName: ctx.entry.info.display_name, signal: ctx.signal });
        held = session; // admit hands it over busy
        plan = { kind: 'new' };
      } else {
        session.busy = true;
        held = session;
        session.history = retainForReplay(fullHistory);
      }
      session.touch();
      if (interrupted) throw bridgeError('client_disconnected');
      stream.created();
      if (plan.kind === 'deliver') {
        for (const o of plan.outputs) await session.deliver(o.callId, o.blocks, o.hash);
      } else if (plan.kind === 'turn') {
        await session.sendTurn(turnBlocks(plan.messages));
      }
      await streamTurn(session, stream);
      consumed?.store.delete(consumed.id);
    } catch (err) {
      const e = toBridgeError(err);
      if (interrupted) {
        // Interrupted on purpose: end the response normally with what was produced so far,
        // and keep the conversation so a turn chained to this response can continue it.
        logger.event('claude_interrupted');
        if (!stream.ended) {
          stream.created();
          stream.completed(null);
        }
        try {
          rememberOrphan(stream.id, [...(requestHistory ?? held?.history ?? []), ...stream.output.filter(Boolean).filter((o) => o.type !== 'reasoning').map(normalizeEmitted)]);
        } catch {
          // nothing to keep
        }
      } else {
        logger.event('claude_response_failed', { code: e.code });
        if (!stream.ended) {
          stream.created();
          stream.failed({ code: e.code, message: e.message });
        }
      }
      // A request turned away (busy, mismatch...) never touched a session: nothing of another request is killed.
      held?.kill(e.code);
    } finally {
      ctx.signal?.removeEventListener('abort', onAbort);
      if (!stream.ended) stream.end();
      if (held) {
        held.busy = false;
        if (held.state !== 'dead') held.touch();
      }
    }
  }

  function health() {
    const live = [...sessions.values()].filter((s) => s.state !== 'dead');
    return { claude_sessions: live.length, claude_max_sessions: limits.maxSessions, claude_awaiting_tool_outputs: live.reduce((n, s) => n + s.awaitingCallIds().length, 0), claude_unreaped: unreaped.size };
  }

  async function close() {
    closing = true;
    await Promise.allSettled([...sessions.values()].map((s) => s.kill('shutdown')));
    await Promise.allSettled([...admissions].map((a) => a.settled));
    await Promise.allSettled([...sessions.values()].map((s) => s.kill('shutdown')));
    await relay.close();
    const keep = [...unreaped].map((s) => s.dir).filter(Boolean);
    for (const dir of dirs.leftovers.sort((a, b) => b.length - a.length)) {
      if (keep.some((k) => k === dir || k.startsWith(`${dir}/`) || dir.startsWith(`${k}/`))) continue;
      dirs.remove(dir);
    }
  }

  return { handle, health, close, sessions: () => [...sessions.values()] };
}
