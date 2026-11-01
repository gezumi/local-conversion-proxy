// One Claude Code process per Codex conversation, plus its MCP relay link.
//
// The process runs `-p` with stream-json input, so later user turns are new
// stdin lines to the same process. A relay MCP call is held open (its promise
// is the pending relay frame) until Codex's real output for the matching
// call_id arrives on a later HTTP POST, and is answered exactly once.
//
// The session's authority (Codex instructions, developer/system messages and
// tool declarations) is fixed at spawn: it is the system prompt and the MCP
// tool list. A change of authority is a new session, never an in-band message.
//
// The session produces events for whichever HTTP response is attached:
//   { type: 'text', text } | { type: 'call', callId } | { type: 'done', usage }
// A failure kills the process group and rejects the waiting response.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { buildClaudeArgs, buildClaudeEnv, buildMcpConfig, checkClaudeAuth } from './claude-cli.mjs';
import { MCP_TOOL_PREFIX, TOOL_SEARCH } from './config.mjs';
import { authorityText, boundOutput, toClaudeBlocks, toMcpContent } from './convert.mjs';
import { BridgeError, bridgeError } from './errors.mjs';
import { jsonLine, readJsonLines } from './lines.mjs';
import { groupAlive, settleOwned, watchClose } from './proc.mjs';
import { writeOwnerOnlyFile } from './runtime-dir.mjs';
import { callItem, newCallId } from './tools.mjs';

/** Stream-json event types that carry no authority and need no action. */
const NOTIFICATION_TYPES = new Set(['rate_limit_event', 'tool_progress', 'tool_use_summary', 'keep_alive', 'auth_status', 'prompt_suggestion', 'streamlined_text', 'streamlined_tool_use_summary']);

/**
 * Which fixed, user-facing error an error text from the Claude Code CLI means.
 * The text itself never leaves this process.
 */
export function classifyCliError(text, status = null) {
  const t = String(text ?? '');
  // The CLI reports the API's HTTP status with its error (api_error_status): it decides first.
  const s = Number.isInteger(status) ? status : null;
  if (s === 401) return 'claude_auth';
  if (s === 404) return 'claude_model_unavailable';
  if (s === 413) return 'claude_too_long';
  if (s === 529) return 'claude_overloaded';
  if (s === 429) return /usage limit|hit your limit|limit reached|out of (extra )?usage|weekly limit|5-hour limit|session limit|上限/i.test(t) ? 'claude_usage_limit' : 'claude_rate_limited';
  if (s !== null && s >= 500 && s <= 599) return /overloaded/i.test(t) ? 'claude_overloaded' : 'claude_api_error';
  if (/issue with the selected model|model .*(may not exist|not found|not available)|not have access to (it|this model)/i.test(t)) return 'claude_model_unavailable';
  if (/log ?in|authenticat|oauth|credential|session expired|token (has )?expired/i.test(t)) return 'claude_auth';
  if (/prompt is too long|too long|context (window|length|limit)|maximum context|request_too_large|\b413\b|exceeds? (the )?(max|context)/i.test(t)) return 'claude_too_long';
  if (/usage limit|hit your limit|limit reached|out of (extra )?usage|weekly limit|5-hour limit|session limit|上限/i.test(t)) return 'claude_usage_limit';
  if (/\b429\b|rate[_ -]?limit|too many requests/i.test(t)) return 'claude_rate_limited';
  if (/\b529\b|overloaded/i.test(t)) return 'claude_overloaded';
  if (/api error: 5\d\d|internal server error|connection error|request timed out|ECONNRESET|ETIMEDOUT|fetch failed/i.test(t)) return 'claude_api_error';
  return 'claude_error';
}

function preamble(displayName, model) {
  return `You are ${displayName} (${model}) serving as the model behind OpenAI Codex (desktop app, phone app or CLI) through a local proxy.
The Codex tools for this conversation are your MCP tools on the "codex" server. Each tool's title and description name the original Codex tool. Calling one asks Codex to run that tool under Codex's own sandbox and approval rules; the result you receive is Codex's real output. You have no other way to act on the machine.
When there are many Codex tools they are deferred: use ${TOOL_SEARCH} to load a tool before calling it (for example "select:<tool name>", or keywords). The core Codex tools are usually exec_command / shell (run commands), write_stdin, apply_patch (edit files), view_image and update_plan.
Custom (freeform) Codex tools take one string argument, "input", written exactly in the format their description gives.
The Codex instructions follow, then the Codex developer messages of this conversation. Where they say "you", they mean you.`;
}

export function buildSystemPrompt(instructions, devMessages = [], { displayName = 'Claude', model = 'claude' } = {}) {
  const dev = authorityText(devMessages);
  return `${preamble(displayName, model)}\n\n${typeof instructions === 'string' ? instructions : ''}${dev ? `\n\n${dev}` : ''}`;
}

let sessionSeq = 0;

export class ClaudeSession {
  id = `s${++sessionSeq}`;
  /** starting -> generating <-> awaiting -> idle -> generating ... -> dead */
  state = 'starting';
  busy = false;
  lastUsed = Date.now();
  /** Fingerprints of the items the last response emitted (oldest first). */
  anchors = [];
  /** Id of the last completed response; the only valid previous_response_id. */
  lastResponseId = null;
  /** Normalized conversation as the bridge knows it (for previous_response_id deltas). */
  history = [];
  /** callId -> { relayId, entry, args, item, emitted } */
  pending = new Map();
  /** callId -> output hash, for replay de-duplication. */
  delivered = new Map();
  lastUsage = null;
  pid = null;
  /** null until reaping finished; then whether the process group's closure was confirmed. */
  reaped = null;

  #cfg;
  #child = null;
  #relay = null;
  #relayListed = false;
  #relayToken = randomBytes(32).toString('hex');
  #events = [];
  #waiter = null;
  #error = null;
  #initSeen = false;
  #startupTimer = null;
  #idleTimer = null;
  #dir = null;
  #killing = null;
  #authAbort = null;
  #authPhase = null;
  /** Process groups of the account probe that are not (yet) confirmed gone. */
  #authGroups = new Set();
  #closed = null;
  #currentMessage = null;
  #messageHasText = false;
  /** Ids of assistant messages whose text was already streamed as deltas. */
  #streamedMessages = new Set();
  /** True once an account probe of this session could not be confirmed stopped. */
  authUnconfirmed = false;

  /**
   * cfg: { key, tools, instructions, devMessages, authorityKey, history,
   *        claudeBin, envSource, limits, dirs, rootDir, relay, nodeBin,
   *        mcpServerPath, logger, onDeath }
   */
  constructor(cfg) {
    this.#cfg = cfg;
    this.model = cfg.model;
    this.effort = cfg.effort ?? null;
    this.accountId = cfg.account?.id ?? '1';
    this.account = cfg.account ?? null;
    this.key = cfg.key;
    this.tools = cfg.tools;
    this.authorityKey = cfg.authorityKey;
    this.devMessages = cfg.devMessages ?? [];
    this.history = cfg.history ?? [];
  }

  get dir() {
    return this.#dir;
  }

  /**
   * Spawn Claude and send the first user message immediately (init depends on
   * it). Resolves once the message was accepted by the pipe; rejects with the
   * session's error if the start failed (the session is then being reaped).
   */
  async start(blocks) {
    const { dirs, rootDir, limits, relay } = this.#cfg;
    try {
      this.#dir = dirs.make('s-', rootDir);
      const workDir = dirs.make('w-', this.#dir);
      const systemPromptPath = writeOwnerOnlyFile(join(this.#dir, 'system-prompt.md'), buildSystemPrompt(this.#cfg.instructions, this.devMessages, { displayName: this.#cfg.displayName ?? this.model, model: this.model }));
      const mcpConfigPath = writeOwnerOnlyFile(
        join(this.#dir, 'mcp.json'),
        JSON.stringify(
          buildMcpConfig({
            nodeBin: this.#cfg.nodeBin,
            mcpServerPath: this.#cfg.mcpServerPath,
            socketPath: relay.socketPath,
            token: this.#relayToken,
            toolTimeoutMs: limits.mcpToolTimeoutMs,
          }),
        ),
      );
      const args = buildClaudeArgs({ mcpConfigPath, systemPromptPath, model: this.model, effort: this.effort });
      const env = buildClaudeEnv(this.#cfg.envSource, { tmpDir: this.#dir, mcpToolTimeoutMs: limits.mcpToolTimeoutMs, maxMcpOutputTokens: limits.maxMcpOutputTokens, configDir: this.#cfg.account?.configDir ?? null });
      // Account gate before EVERY model process: signed in, Claude.ai firstParty,
      // and the owner's configured account. Fails closed: no prompt, no spawn.
      // The probe is an owned PHASE of this session: its settlement (group
      // reaped AND close observed) is part of the one kill() verdict, and its
      // live group ids are tracked while it runs.
      this.#authAbort = new AbortController();
      const cache = this.#cfg.authCache;
      this.#authPhase = cache?.fresh(this.#cfg.account)
        ? Promise.resolve({ ok: true, confirmed: true })
        : checkClaudeAuth({
            bin: this.#cfg.claudeBin,
            env,
            cwd: workDir,
            signal: this.#authAbort.signal,
            ownership: this.#cfg.ownership,
            onSpawn: (pgid) => this.#authGroups.add(pgid),
            onSettled: (pgid) => this.#authGroups.delete(pgid),
          }).then(
            () => {
              cache?.mark(this.#cfg.account);
              return { ok: true, confirmed: true };
            },
            (err) => ({ ok: false, confirmed: err?.code !== 'process_cleanup_unconfirmed', code: err?.code ?? 'claude_auth' }),
          );
      const auth = await this.#authPhase;
      this.#authAbort = null;
      if (!auth.confirmed) this.authUnconfirmed = true;
      if (this.state === 'dead') throw this.#error; // killed during the probe: never spawn
      if (!auth.ok) throw bridgeError(auth.code);
      relay.register(this.#relayToken, this);
      const child = spawn(this.#cfg.claudeBin, args, { cwd: workDir, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true });
      this.#child = child;
      this.pid = child.pid ?? null;
      this.#closed = watchClose(child);
      child.once('error', () => this.#fail('claude_start_failed'));
      child.once('exit', () => {
        if (this.state !== 'dead') this.#fail('claude_exited');
      });
      child.stdin.on('error', () => {});
      child.stderr.on('data', () => {}); // drained, never read or logged
      readJsonLines(child.stdout, {
        maxLineBytes: limits.maxLineBytes,
        onError: (why) => this.#fail('claude_protocol', { why }),
        onLine: (ev) => this.#onEvent(ev),
        onEnd: () => {
          if (this.state !== 'dead') this.#fail('claude_exited', { why: 'stdout_closed' });
        },
      });
      this.#startupTimer = setTimeout(() => {
        if (!this.#initSeen) this.#fail('claude_timeout');
      }, limits.startupMs);
      this.#cfg.logger?.event('session_start', { tools: this.tools.size, skipped_tools: this.tools.skipped });
      this.touch();
    } catch (err) {
      this.#fail(err instanceof BridgeError ? err.code : 'claude_start_failed');
    }
    await this.#writeUser(blocks);
  }

  /** A later user turn on the same process. */
  async sendTurn(blocks) {
    if (this.state !== 'idle') throw bridgeError('session_busy');
    this.state = 'sending';
    await this.#writeUser(blocks);
  }

  /**
   * Write one stream-json user line and wait until the pipe accepted all of
   * it (bounded). Only then is the session `generating`.
   */
  async #writeUser(blocks) {
    if (this.state === 'dead') throw this.#error;
    const line = jsonLine({ type: 'user', message: { role: 'user', content: toClaudeBlocks(blocks) }, parent_tool_use_id: null, session_id: '' });
    const ok = await this.#accepted((cb) => this.#child.stdin.write(line, cb));
    if (!ok) {
      this.#fail('claude_input_failed');
      throw this.#error;
    }
    this.#cfg.logger?.event('user_turn_sent', { images: blocks.filter((b) => b.kind === 'image').length });
    if (this.state === 'starting' || this.state === 'sending') this.state = 'generating';
  }

  /** Run `write(cb)`; true if the callback reported success within inputWriteMs. */
  #accepted(write) {
    return new Promise((resolve) => {
      let done = false;
      const settle = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => settle(false), this.#cfg.limits.inputWriteMs);
      try {
        const r = write((err) => settle(!err));
        if (r && typeof r.then === 'function') r.then(settle, () => settle(false));
      } catch {
        settle(false);
      }
    });
  }

  touch() {
    this.lastUsed = Date.now();
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.kill('idle'), this.#cfg.limits.sessionIdleMs);
    this.#idleTimer.unref?.();
  }

  /** No response attached, no held or queued tool work: safe to evict. */
  get quiescent() {
    return this.state === 'idle' && !this.busy && this.pending.size === 0 && this.#events.length === 0;
  }

  // ---- relay side ---------------------------------------------------------

  attachRelay(conn) {
    if (this.#relay || this.state === 'dead') return false;
    this.#relay = conn;
    return true;
  }

  relayClosed() {
    this.#relay = null;
    if (this.state !== 'dead') this.#fail('mcp_disconnected');
  }

  onRelayFrame(msg) {
    if (this.state === 'dead' || !msg || typeof msg !== 'object') return;
    this.#activity();
    if (msg.t === 'list') {
      this.#relayListed = true;
      this.#relay?.send({ t: 'list', id: msg.id, tools: this.tools.list() });
    } else if (msg.t === 'call') {
      this.#onCall(msg);
    } else if (msg.t === 'cancel') {
      this.#onCancel(msg.id);
    }
  }

  #reply(relayId, content, isError) {
    return this.#relay ? this.#relay.send({ t: 'result', id: relayId, content, isError }) : Promise.resolve(false);
  }

  #onCall(msg) {
    const entry = typeof msg.name === 'string' ? this.tools.resolve(msg.name) : null;
    if (!entry) return this.#reply(msg.id, [{ type: 'text', text: 'Unknown tool: this bridge only relays the Codex tools listed by tools/list.' }], true);
    const args = msg.arguments ?? {};
    const invalid = this.tools.validate(entry, args);
    if (invalid) {
      this.#cfg.logger?.event('tool_args_invalid');
      return this.#reply(msg.id, [{ type: 'text', text: `Invalid arguments for Codex tool ${entry.title}: ${invalid}. The call was not sent to Codex; fix the arguments and call again.` }], true);
    }
    const callId = newCallId();
    this.pending.set(callId, { relayId: msg.id, entry, args, item: callItem(entry, callId, args), emitted: false });
    this.#push({ type: 'call', callId });
  }

  /**
   * Claude abandoned an MCP call. Not yet shown to Codex: drop it. Already a
   * Codex call item: Codex will still run it and send its output, which could
   * no longer reach Claude, so this process ends and the next request replays
   * the conversation (with that real output) into a new one.
   */
  #onCancel(relayId) {
    for (const [callId, p] of this.pending) {
      if (p.relayId !== relayId) continue;
      if (p.emitted) return this.#fail('claude_protocol', { why: 'emitted_call_cancelled' });
      this.pending.delete(callId);
      this.#events = this.#events.filter((e) => !(e.type === 'call' && e.callId === callId));
    }
  }

  markEmitted(callId) {
    const p = this.pending.get(callId);
    if (p) p.emitted = true;
    this.state = 'awaiting';
  }

  /** Emitted calls still waiting for Codex output. */
  awaitingCallIds() {
    return [...this.pending].filter(([, p]) => p.emitted).map(([id]) => id);
  }

  /**
   * Answer one held MCP call with Codex's real output, exactly once. The call
   * leaves `pending` before the write, so no second delivery is possible; if
   * the relay does not accept the frame the session fails (and the next
   * request replays the output into a new process).
   */
  async deliver(callId, blocks, hash) {
    const p = this.pending.get(callId);
    if (!p || !p.emitted) throw bridgeError('output_unknown_call');
    this.pending.delete(callId);
    this.delivered.set(callId, hash);
    const bounded = boundOutput(blocks, this.#cfg.limits.maxToolOutputChars);
    if (bounded.bounded) this.#cfg.logger?.event('tool_output_bounded', { bounded_outputs: 1 });
    const ok = await this.#accepted(() => this.#reply(p.relayId, toMcpContent(bounded.blocks), false));
    if (!ok) {
      this.#fail('mcp_disconnected');
      throw this.#error;
    }
    // Counts only: how many image blocks Claude actually received, never their bytes.
    this.#cfg.logger?.event('tool_output_delivered', { images: bounded.blocks.filter((b) => b.kind === 'image').length, bounded_outputs: bounded.bounded ? 1 : 0 });
    if (this.state === 'awaiting' && this.awaitingCallIds().length === 0) this.state = 'generating';
  }

  // ---- Claude stdout ------------------------------------------------------

  #onEvent(ev) {
    if (this.state === 'dead') return;
    this.#activity();
    if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return this.#fail('claude_protocol');
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') return this.#onInit(ev);
        return; // status, api_retry, compact_boundary, hook progress...: notifications
      case 'assistant':
        return this.#onAssistant(ev);
      case 'user':
        return; // echo of tool results / replayed input
      case 'result':
        return this.#onResult(ev);
      case 'stream_event':
        return this.#onStreamEvent(ev);
      default:
        if (NOTIFICATION_TYPES.has(ev.type)) return;
        // Unknown kinds are tolerated only if they cannot carry model content.
        if ('message' in ev || ev.type === 'control_request') return this.#fail('claude_protocol');
    }
  }

  /**
   * Admit the process only if it runs the exact model, has exactly one MCP
   * server (the relay) connected, and exposes exactly the relay tools of this
   * request: no built-ins, none missing (the zero-tool failure class), none extra.
   */
  #onInit(ev) {
    if (ev.model !== this.model) return this.#fail('claude_model_mismatch');
    const servers = Array.isArray(ev.mcp_servers) ? ev.mcp_servers : [];
    if (servers.some((s) => s?.name !== 'codex')) return this.#fail('claude_protocol', { why: 'extra_mcp' });
    if (servers.length !== 1 || servers[0].status !== 'connected' || !this.#relay || !this.#relayListed) {
      return this.#fail('claude_tools_not_exposed', { why: 'mcp_not_connected' });
    }
    const tools = (Array.isArray(ev.tools) ? ev.tools : []).filter((t) => t !== TOOL_SEARCH);
    if (tools.some((t) => typeof t !== 'string' || !t.startsWith(MCP_TOOL_PREFIX))) return this.#fail('claude_tools_not_exposed', { why: 'builtin_tool' });
    const expected = new Set(this.tools.list().map((t) => `${MCP_TOOL_PREFIX}${t.name}`));
    const got = new Set(tools);
    if (got.size !== tools.length || got.size !== expected.size || [...expected].some((t) => !got.has(t))) {
      return this.#fail('claude_tools_not_exposed', { why: 'tools_not_exposed' });
    }
    this.#initSeen = true;
    clearTimeout(this.#startupTimer);
  }

  #onAssistant(ev) {
    if (!this.#initSeen) return this.#fail('claude_protocol', { why: 'assistant_before_init' });
    const m = ev.message;
    if (!m || typeof m !== 'object') return this.#fail('claude_protocol');
    // "<synthetic>" marks CLI-generated error text (usage limit, API error): not model output.
    if (m.model === '<synthetic>') {
      const code = classifyCliError((Array.isArray(m.content) ? m.content : []).map((b) => (typeof b?.text === 'string' ? b.text : '')).join(' '), ev.api_error_status ?? m.api_error_status ?? null);
      if (code === 'claude_auth') this.#cfg.onAuthFailure?.(this.#cfg.account);
      return this.#fail(code);
    }
    if (m.model !== this.model) return this.#fail('claude_model_mismatch');
    if (ev.parent_tool_use_id) return this.#fail('claude_protocol', { why: 'subagent' });
    if (m.usage) this.lastUsage = m.usage;
    const streamed = typeof m.id === 'string' && this.#streamedMessages.has(m.id);
    let first = true;
    for (const block of Array.isArray(m.content) ? m.content : []) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        // Text already streamed as deltas is not sent again.
        if (block.text && !streamed) {
          this.#push({ type: 'text', text: block.text, separate: first });
          first = false;
        }
      } else if (block?.type === 'tool_use') {
        if (block.name === TOOL_SEARCH) continue; // executed inside Claude Code
        if (typeof block.name !== 'string' || !block.name.startsWith(MCP_TOOL_PREFIX)) return this.#fail('claude_protocol', { why: 'foreign_tool' });
      }
    }
  }

  /** Partial-message events: stream text deltas as they arrive. */
  #onStreamEvent(ev) {
    if (!this.#initSeen || ev.parent_tool_use_id) return;
    const e = ev.event;
    if (!e || typeof e !== 'object') return;
    if (e.type === 'message_start') {
      this.#currentMessage = typeof e.message?.id === 'string' ? e.message.id : null;
      this.#messageHasText = false;
      if (e.message?.model && e.message.model !== this.model) return this.#fail('claude_model_mismatch');
    } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string' && e.delta.text) {
      if (this.#currentMessage) this.#streamedMessages.add(this.#currentMessage);
      this.#push({ type: 'text', text: e.delta.text, separate: !this.#messageHasText });
      this.#messageHasText = true;
    }
  }

  #onResult(ev) {
    if (ev.subtype !== 'success' || ev.is_error) {
      // The CLI's own text is never forwarded; it only picks the user-facing reason.
      const code = classifyCliError(typeof ev.result === 'string' ? ev.result : '', ev.api_error_status ?? null);
      if (code === 'claude_auth') this.#cfg.onAuthFailure?.(this.#cfg.account);
      return this.#fail(code);
    }
    if (!this.#initSeen) return this.#fail('claude_protocol');
    if (!this.#relay) return this.#fail('mcp_disconnected', { why: 'result_before_relay' });
    if (this.pending.size) return this.#fail('claude_protocol', { why: 'result_with_pending' });
    this.state = 'idle';
    this.#streamedMessages.clear();
    this.#push({ type: 'done', usage: ev.usage ?? this.lastUsage });
  }

  // ---- event queue for the attached response ------------------------------

  #push(event) {
    this.#events.push(event);
    this.#wake();
  }

  /** Return an event taken by `next` but not consumed (it belongs to a later response). */
  pushBack(event) {
    this.#events.unshift(event);
  }

  #wake() {
    const w = this.#waiter;
    if (!w || !this.#events.length) return;
    this.#waiter = null;
    clearTimeout(w.timer);
    w.resolve(this.#events.shift());
  }

  #activity() {
    const w = this.#waiter;
    if (w) w.arm();
  }

  /**
   * Next event, or reject after `idleMs` without any Claude activity. With
   * `quietMs` set, resolves `null` instead of rejecting when that shorter wait ends.
   */
  next(idleMs, quietMs = null) {
    if (this.#events.length) return Promise.resolve(this.#events.shift());
    if (this.#error) return Promise.reject(this.#error);
    return new Promise((resolve, reject) => {
      const w = {
        resolve,
        reject,
        timer: null,
        arm: () => {
          if (quietMs !== null) return; // a quiet wait is not extended by activity
          clearTimeout(w.timer);
          w.timer = setTimeout(() => this.#fail('claude_timeout'), idleMs);
        },
      };
      if (quietMs !== null) {
        w.timer = setTimeout(() => {
          if (this.#waiter === w) this.#waiter = null;
          resolve(null);
        }, quietMs);
      } else {
        w.arm();
      }
      this.#waiter = w;
    });
  }

  // ---- lifecycle -----------------------------------------------------------

  #fail(code, detail = {}) {
    if (this.state === 'dead') return;
    this.#error = bridgeError(code, detail);
    this.#cfg.logger?.event('session_fail', { code: this.#error.code, ...detail });
    const w = this.#waiter;
    this.#waiter = null;
    if (w) {
      clearTimeout(w.timer);
      w.reject(this.#error);
    }
    this.kill(code);
  }

  get error() {
    return this.#error;
  }

  /**
   * Terminate the process group, close the relay and, once the group is
   * confirmed gone, remove this session's files. If closure cannot be
   * confirmed within the bound, the files stay (for diagnosis) and
   * `reaped` is false; `onDeath` reports either outcome.
   */
  kill(reason = 'closed') {
    if (this.#killing) return this.#killing;
    if (!this.#error) this.#error = bridgeError(reason === 'shutdown' ? 'shutting_down' : 'claude_exited');
    this.state = 'dead';
    clearTimeout(this.#startupTimer);
    clearTimeout(this.#idleTimer);
    this.#authAbort?.abort(); // a start still in its account probe spawns nothing
    const w = this.#waiter;
    this.#waiter = null;
    if (w) {
      clearTimeout(w.timer);
      w.reject(this.#error);
    }
    this.#cfg.relay.unregister(this.#relayToken);
    this.#relay?.close();
    this.#relay = null;
    this.#killing = (async () => {
      // ONE verdict over every owned phase. First the account probe (aborted
      // above; its group is reaped by its owner): nothing about this session's
      // files is decided before that settles.
      const auth = this.#authPhase ? await this.#authPhase : { confirmed: true };
      if (!auth.confirmed) this.authUnconfirmed = true;
      // No model can have been spawned after this point: state is dead.
      const child = this.#child;
      if (child) {
        try {
          child.stdin.end();
        } catch {
          // ignore
        }
      }
      // Same owned-child contract as every other spawn: group reaped AND close observed.
      const modelReaped = child ? (await settleOwned(child, this.#closed, { graceMs: this.#cfg.limits.killGraceMs })).confirmed : true;
      if (child) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
      const reaped = modelReaped && !this.authUnconfirmed;
      this.reaped = reaped;
      // Scratch (and the probe's cwd inside it) is kept whenever any phase is unconfirmed.
      if (reaped && this.#dir) this.#cfg.dirs.remove(this.#dir);
      this.#cfg.logger?.event('session_end', { reason, reaped });
      this.#cfg.onDeath?.(this);
      return reaped;
    })();
    return this.#killing;
  }

  /**
   * Whether this (dead, unreaped) session may still hold live processes: its
   * model group, or an account-probe group not confirmed gone. Unknown => true.
   */
  holdsLiveGroups() {
    if (this.reaped === true) return false;
    const groups = [...this.#authGroups];
    if (this.pid) groups.push(this.pid);
    if (!groups.length) return true; // nothing nameable: assume held
    return groups.some((g) => groupAlive(g));
  }
}
