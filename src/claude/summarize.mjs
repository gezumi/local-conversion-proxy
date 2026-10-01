// Summaries of the part of a long conversation that does not fit a replay,
// and of a whole conversation for Codex's compaction.
//
// When a long Codex conversation is replayed into a new Claude session (a
// switch from GPT, a proxy restart, a changed tool set...), the most recent
// part goes in verbatim and the earlier part is summarized first by one-shot
// Claude Code runs (no tools, no settings, nothing persisted), on the same
// account. A transcript too long for one run is summarized in chunks, oldest
// first, each run carrying the summary so far: nothing from the start (the
// user's goals) falls out. A failed or cancelled summary falls back to an
// explicit note.

import { buildClaudeEnv } from './claude-cli.mjs';
import { runProbe } from './proc.mjs';

export const SUMMARY_MODEL = 'claude-sonnet-5-5';

export const SUMMARY_PROMPT = `You are given the EARLIER part of a long conversation between a user and an AI coding agent working through OpenAI Codex, as a transcript. A new agent session will continue this conversation. It will see the most recent part of the conversation verbatim, but NOT this earlier part, so your summary is its only knowledge of it.

If the transcript begins with <summary_of_the_part_before>, that is a summary of what came before it: carry everything in it forward.

Write a handoff summary of this earlier part. Include: the user's goals and explicit instructions or preferences (quote important ones verbatim); decisions made and why; what was built or changed (files, commands and their results, what is verified and what is not); problems found and how they were handled; open questions and unfinished work; and every identifier, path, name, number or snippet that may still be needed. Prefer concrete facts over narration. Do not invent anything that is not in the transcript.

Reply with the summary only, in the language the user has been using, in at most about 2,500 words.`;

/** For Codex's compaction when no live session holds the conversation: the summary replaces all of it. */
export const COMPACTION_SUMMARY_PROMPT = `You are given a conversation between a user and an AI coding agent working through OpenAI Codex, as a transcript. Codex is compacting it: your summary will REPLACE this whole conversation, and the agent will continue the work from the summary alone.

If the transcript begins with <summary_of_the_part_before>, that is a summary of what came before it: carry everything in it forward.

Write a handoff summary that lets the work continue seamlessly. Include: the user's goals and explicit instructions or preferences (quote important ones verbatim); decisions made and why; what was built or changed (files, commands and their results, what is verified and what is not); problems found and how they were handled; the current state and the exact next steps; open questions and unfinished work; and every identifier, path, name, number or snippet that may still be needed. Prefer concrete facts over narration. Do not invent anything that is not in the transcript.

Reply with the summary only, in the language the user has been using, in at most about 2,500 words.`;

/** For every chunk but the last of a long transcript: the summary so far, carried into the next run. */
export const ROLLING_SUMMARY_PROMPT = `You are given part of a long conversation between a user and an AI coding agent working through OpenAI Codex, as a transcript. If it begins with <summary_of_the_part_before>, that is a summary of what came before it. The conversation continues after this part; your summary will be carried into the summary of the rest.

Write a running summary of everything so far (the summary before it, if any, and this part). Include: the user's goals and explicit instructions or preferences (quote important ones verbatim); decisions made and why; what was built or changed (files, commands and their results, what is verified and what is not); problems found and how they were handled; open questions and unfinished work; and every identifier, path, name, number or snippet that may still be needed. Prefer concrete facts over narration. Do not invent anything that is not in the transcript.

Reply with the summary only, in the language the user has been using, in at most about 2,500 words.`;

/**
 * A summary of a transcript of any length (chunks from transcriptChunks,
 * oldest first): each run gets the summary so far plus the next chunk, the
 * last one with `prompt`. null if any run fails or the work is cancelled.
 */
export async function summarizeChunks(chunks, { prompt = SUMMARY_PROMPT, signal = null, ...run }) {
  let summary = null;
  for (let i = 0; i < chunks.length; i += 1) {
    const before = summary ? `<summary_of_the_part_before>\n${summary}\n</summary_of_the_part_before>\n\n` : '';
    summary = await summarizeEarlier({ ...run, signal, transcript: `${before}${chunks[i]}`, prompt: i === chunks.length - 1 ? prompt : ROLLING_SUMMARY_PROMPT });
    if (!summary || signal?.aborted) return null;
  }
  return summary;
}

/** Summary text, or null when it could not be made (the caller then notes the omission). */
export async function summarizeEarlier({ claudeBin, envSource, dirs, rootDir, account = null, transcript, model = SUMMARY_MODEL, prompt = SUMMARY_PROMPT, signal = null, timeoutMs = 8 * 60 * 1000 }) {
  if (!transcript) return null;
  const tmp = dirs.make('sum-', rootDir);
  try {
    const env = buildClaudeEnv(envSource, { tmpDir: tmp, mcpToolTimeoutMs: 60_000, configDir: account?.configDir ?? null });
    const args = ['-p', '--model', model, '--effort', 'low', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--disable-slash-commands', '--output-format', 'json'];
    const r = await runProbe(claudeBin, args, { env, cwd: tmp, timeoutMs, maxStdout: 4 * 1024 * 1024, graceMs: 1000, signal, input: `${prompt}\n\n<transcript>\n${transcript}\n</transcript>` });
    if (!r.ok) return null;
    const j = JSON.parse(r.stdout.trim().split('\n').pop());
    return !j.is_error && typeof j.result === 'string' && j.result.trim() ? j.result.trim() : null;
  } catch {
    return null;
  } finally {
    dirs.remove(tmp);
  }
}
