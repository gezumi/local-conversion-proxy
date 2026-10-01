import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCliError } from '../src/claude/claude-session.mjs';
import { REPLAY_LIMITS, normalizeInput, replayBlocks } from '../src/claude/convert.mjs';

const opts = { maxImageBytes: 1024 * 1024 };

test('items Codex records without a call_id, agent messages and odd content shapes never stop a conversation', () => {
  const items = normalizeInput(
    [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'start' }] },
      // seen in a real thread: an output with id/name/namespace but no call_id
      { type: 'function_call_output', id: 'x1', name: 'send', namespace: 'agents', output: 'agent result text' },
      { type: 'custom_tool_call', id: 'x2', name: 'exec', input: 'ls' },
      { type: 'agent_message', id: 'a1', author: 'worker-1', recipient: 'main', content: [{ type: 'input_text', text: 'report from a sub agent' }] },
      { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: { weird: true } },
      { type: 'message', role: 'assistant', content: { text: 'object content' } },
      { type: 'message', role: 'user', content: [null, 'plain string part', { text: 'typeless part' }, { type: 'input_file', file_id: 'f' }] },
      { type: 'message', role: 'critic', content: 'unknown role' },
    ],
    opts,
  );
  const text = JSON.stringify(items);
  assert.match(text, /agent result text/);
  assert.match(text, /\[result from agents\.send\]/);
  assert.match(text, /earlier tool call exec/);
  assert.match(text, /report from a sub agent/);
  assert.match(text, /weird/);
  assert.match(text, /object content/);
  assert.match(text, /plain string part/);
  assert.match(text, /typeless part/);
  assert.equal(items.find((i) => i.kind === 'output').callId, 'c1');
});

test('a long conversation is replayed within budget: the newest part in full, older outputs shortened, a note about the rest', () => {
  const input = [{ type: 'message', role: 'user', content: 'the very first request' }];
  for (let i = 0; i < 400; i += 1) {
    input.push({ type: 'function_call', call_id: `c${i}`, name: 'exec_command', arguments: `{"cmd":"step ${i}"}` });
    input.push({ type: 'function_call_output', call_id: `c${i}`, output: `output ${i} `.repeat(2000) });
  }
  input.push({ type: 'message', role: 'user', content: 'the latest question' });
  const blocks = replayBlocks(normalizeInput(input, opts));
  const all = blocks.map((b) => b.text ?? '').join('\n');
  assert.ok(all.length <= REPLAY_LIMITS.budgetChars + 10_000, `within budget (${all.length})`);
  assert.match(all, /the latest question/);
  assert.match(all, /step 399/);
  assert.match(all, /were left out/);
  assert.doesNotMatch(all, /the very first request/);
  assert.match(all, /characters omitted/);
});

test('a short conversation is replayed whole, without an omission note', () => {
  const blocks = replayBlocks(normalizeInput([{ type: 'message', role: 'user', content: 'q' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] }, { type: 'message', role: 'user', content: 'q2' }], opts));
  const all = blocks.map((b) => b.text ?? '').join('\n');
  assert.doesNotMatch(all, /left out/);
  assert.match(all, /q2/);
});

test('Claude Code error texts map to the right user-facing reason', () => {
  assert.equal(classifyCliError('Prompt is too long'), 'claude_too_long');
  assert.equal(classifyCliError('API Error: 400 input length and max_tokens exceed context limit: 1012345 + 32000 > 1000000'), 'claude_too_long');
  assert.equal(classifyCliError('API Error: 429 rate_limit_error per-minute rate limit'), 'claude_rate_limited');
  assert.equal(classifyCliError('Claude AI usage limit reached|1790833200'), 'claude_usage_limit');
  assert.equal(classifyCliError("You've hit your limit · resets 3pm"), 'claude_usage_limit');
  assert.equal(classifyCliError('Failed to authenticate: OAuth session expired and could not be refreshed'), 'claude_auth');
  assert.equal(classifyCliError('API Error: 529 Overloaded'), 'claude_overloaded');
  assert.equal(classifyCliError('Something else'), 'claude_error');
});

test('a character split across output chunks of a CLI call stays whole (summaries in Japanese)', async () => {
  const { runProbe } = await import('../src/claude/proc.mjs');
  const script = 'process.stdout.write(Buffer.from([0xe6])); setTimeout(() => process.stdout.write(Buffer.from([0x97, 0xa5, 0x0a])), 80);';
  const r = await runProbe(process.execPath, ['-e', script], { env: process.env, cwd: process.cwd(), timeoutMs: 10_000, graceMs: 500 });
  assert.equal(r.ok, true);
  assert.equal(r.stdout, '日\n');
});
