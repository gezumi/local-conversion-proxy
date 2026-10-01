// Claude backend constants: the MCP relay naming and every bound.
//
// There is deliberately no budget, turn or conversation-length cap. What is
// bounded is abandoned or stuck work: silence while a response waits, a
// conversation with no activity, startup, input writes and process reaping.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** MCP server label seen by Claude; tools become `mcp__codex__<opaque>`. */
export const MCP_SERVER_LABEL = 'codex';
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_LABEL}__`;

/** The only Claude Code built-in tool a session may have: deferred MCP tool loading. */
export const TOOL_SEARCH = 'ToolSearch';

/** Defer MCP tools once they exceed this share of the context window (Codex apps add 400+ tools). */
export const TOOL_SEARCH_MODE = 'auto:2';

/** The `claude` launcher Claude Code keeps up to date, or the first one on PATH. */
export function defaultClaudeBin(env = process.env) {
  const local = join(env.HOME || homedir(), '.local', 'bin', 'claude');
  if (existsSync(local)) return local;
  for (const dir of String(env.PATH ?? '').split(':')) {
    if (dir && existsSync(join(dir, 'claude'))) return join(dir, 'claude');
  }
  return local;
}

export const DEFAULT_LIMITS = Object.freeze({
  /** Largest single stream-json line read from Claude, and relay frame. */
  maxLineBytes: 48 * 1024 * 1024,
  /** Concurrent Claude sessions (one per Codex thread). Beyond this the least recently used quiescent one is evicted. */
  maxSessions: 12,
  /** Claude silent (no stdout event or relay frame) while a response waits on it. */
  generationIdleMs: 20 * 60 * 1000,
  /** Conversation with no activity; its next request replays the transcript into a new process. */
  sessionIdleMs: 6 * 60 * 60 * 1000,
  /** A stdin line / relay frame must be accepted by the pipe within this. */
  inputWriteMs: 30 * 1000,
  /** Characters of one tool output passed to Claude; larger outputs are cut explicitly with a marker. */
  maxToolOutputChars: 800 * 1000,
  /** CLI-side MCP output cap, set far above maxToolOutputChars so the CLI never truncates silently. */
  maxMcpOutputTokens: 400 * 1000,
  /** Wait for the first init event after spawn. */
  startupMs: 120 * 1000,
  /** Claude-side MCP tool timeout; matches the session idle bound. */
  mcpToolTimeoutMs: 6 * 60 * 60 * 1000,
  /** Keepalive cadence while waiting on Claude. */
  keepaliveMs: 10 * 1000,
  /** Collect concurrently issued MCP calls into one Responses turn for this long. */
  callCoalesceMs: 150,
  /** TERM -> KILL grace when reaping a Claude process group. */
  killGraceMs: 2000,
  /** Largest tool description forwarded to Claude. */
  maxDescriptionChars: 32 * 1024,
  /** Bytes of a single decoded data-URL image. */
  maxImageBytes: 20 * 1024 * 1024,
  /** Characters of transcript per summarizer run (a longer one is summarized in chunks, oldest first). */
  summaryChunkChars: 800 * 1000,
  /** Total size of kept conversations whose session is gone (for a chained next turn). */
  orphanBytes: 256 * 1024 * 1024,
  /** Total size of kept prewarm inputs. */
  prewarmBytes: 64 * 1024 * 1024,
  /** How long a verified account login stays trusted before it is checked again. */
  authCacheMs: 10 * 60 * 1000,
  /** At capacity, a session idle this long while holding an unanswered tool call may be evicted. */
  staleAwaitingMs: 30 * 60 * 1000,
});
