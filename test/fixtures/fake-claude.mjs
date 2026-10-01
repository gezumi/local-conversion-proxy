// Fake Claude Code CLI for behavioral tests. It speaks stream-json on stdio,
// starts the MCP server named in --mcp-config exactly like the real CLI, and
// follows a scenario file (one action list per user turn).
//
// Environment (set by the per-test wrapper script, since the bridge strips env):
//   FAKE_SCENARIO  path to { turns: [[action, ...], ...] }
//   FAKE_RECORD    path of a JSON-lines record the test inspects
//   FAKE_AUTH      JSON printed by `auth status --json`
//   FAKE_VERSION   printed by --version

import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const record = (o) => process.env.FAKE_RECORD && appendFileSync(process.env.FAKE_RECORD, `${JSON.stringify(o)}\n`);

// Probe hang knobs: FAKE_*_DELAY_MS delays the answer; FAKE_PROBE_IGNORE_TERM ignores SIGTERM.
if ((argv[0] === '--version' || argv[0] === 'auth') && process.env.FAKE_PROBE_IGNORE_TERM) process.on('SIGTERM', () => {});
// FAKE_LOCK_SCRATCH: leave an entry in the probe's cwd (the owner's scratch) that the owner cannot remove.
if ((argv[0] === '--version' || argv[0] === 'auth') && process.env.FAKE_LOCK_SCRATCH) {
  const locked = `${process.cwd()}/locked-${argv[0].replace(/-/g, '')}`;
  mkdirSync(locked, { recursive: true });
  writeFileSync(`${locked}/f`, 'x');
  chmodSync(locked, 0o500);
  if (process.env.FAKE_RECORD) appendFileSync(process.env.FAKE_RECORD, `${JSON.stringify({ kind: 'locked_scratch', path: locked })}\n`);
}
if (argv[0] === '--version') {
  if (process.env.FAKE_RECORD) appendFileSync(process.env.FAKE_RECORD, `${JSON.stringify({ kind: 'version_probe', pid: process.pid })}\n`);
  const delay = Number(process.env.FAKE_VERSION_DELAY_MS ?? 0);
  if (delay) await new Promise((r) => setTimeout(r, delay));
  process.stdout.write(`${process.env.FAKE_VERSION ?? '2.1.285'} (Claude Code)\n`);
  process.exit(0);
}
if (argv[0] === 'auth') {
  // FAKE_AUTH_FILE lets a test change the signed-in account while the bridge runs.
  const fromFile = process.env.FAKE_AUTH_FILE && existsSync(process.env.FAKE_AUTH_FILE) ? readFileSync(process.env.FAKE_AUTH_FILE, 'utf8').trim() : null;
  const delay = Number(process.env.FAKE_AUTH_DELAY_MS ?? 0);
  if (process.env.FAKE_RECORD) appendFileSync(process.env.FAKE_RECORD, `${JSON.stringify({ kind: 'auth_probe', pid: process.pid, configDir: process.env.CLAUDE_CONFIG_DIR ?? null })}\n`);
  if (delay) await new Promise((r) => setTimeout(r, delay));
  process.stdout.write(`${fromFile ?? process.env.FAKE_AUTH ?? JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'owner-secret@example.com', orgName: 'secret-org' })}\n`);
  process.exit(0);
}

// One-shot summarizer mode (`-p --output-format json`, prompt on stdin).
{
  const i = argv.indexOf('--output-format');
  if (i >= 0 && argv[i + 1] === 'json') {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) input += chunk;
    if (process.env.FAKE_RECORD) appendFileSync(process.env.FAKE_RECORD, `${JSON.stringify({ kind: 'summary_request', chars: input.length, mentionsFirst: input.includes('the very first request'), probe: process.env.FAKE_SUMMARY_PROBE ? input.includes(process.env.FAKE_SUMMARY_PROBE) : null, compaction: input.includes('Codex is compacting it'), model: argv[argv.indexOf('--model') + 1] })}\n`);
    if (process.env.FAKE_SUMMARY_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_SUMMARY_DELAY_MS)));
    if (process.env.FAKE_SUMMARY_FAIL) {
      process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Prompt is too long' })}\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'FAKE SUMMARY: the user first asked for the very first request; work continued.' })}\n`);
    process.exit(0);
  }
}

// `processes: [scenario, scenario, ...]` gives the Nth spawned process its own scenario.
const loaded = process.env.FAKE_SCENARIO ? JSON.parse(readFileSync(process.env.FAKE_SCENARIO, 'utf8')) : { turns: [] };
const priorProcesses = existsSync(process.env.FAKE_RECORD ?? '') ? readFileSync(process.env.FAKE_RECORD, 'utf8').split('\n').filter((l) => l.includes('"kind":"argv"')).length : 0;
const scenario = loaded.processes ? (loaded.processes[priorProcesses] ?? { turns: [] }) : loaded;
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const model = flag('--model');
let assistantModel = scenario.assistantModel ?? model;
record({ kind: 'argv', argv, envKeys: Object.keys(process.env).sort(), maxMcpOutputTokens: process.env.MAX_MCP_OUTPUT_TOKENS, pid: process.pid, cwd: process.cwd(), configDir: process.env.CLAUDE_CONFIG_DIR ?? null });
record({ kind: 'system', text: readFileSync(flag('--system-prompt-file'), 'utf8') });

const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

// --- MCP client over the configured stdio server ---------------------------
const mcpConfig = JSON.parse(readFileSync(flag('--mcp-config'), 'utf8'));
const [serverName, server] = Object.entries(mcpConfig.mcpServers)[0];
const mcp = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] });
record({ kind: 'mcp_pid', pid: mcp.pid });
let rpcId = 0;
const waiting = new Map();
createInterface({ input: mcp.stdout }).on('line', (line) => {
  const msg = JSON.parse(line);
  const w = waiting.get(msg.id);
  if (w) {
    waiting.delete(msg.id);
    w(msg);
  }
});
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = ++rpcId;
    waiting.set(id, resolve);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
const notify = (method, params) => mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } });
notify('notifications/initialized', {});
const listed = await rpc('tools/list', {});
const tools = listed.result.tools;
record({ kind: 'tools', protocol: init.result.protocolVersion, tools: tools.map((t) => ({ name: t.name, title: t.title, schema: t.inputSchema, description: t.description })) });
const byTitle = (title) => tools.find((t) => t.title === title);

const exposed = tools.map((t) => `mcp__${serverName}__${t.name}`);
const initTools = scenario.initTools === 'dropOne' ? exposed.slice(1) : scenario.initTools === 'duplicate' ? [...exposed, exposed[0]] : (scenario.initTools ?? exposed);
emit({ type: 'system', subtype: 'init', model: scenario.initModel ?? model, tools: initTools, mcp_servers: scenario.initServers ?? [{ name: serverName, status: 'connected' }], session_id: 'fake' });
emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
emit({ type: 'system', subtype: 'status', status: null });

// --- turns --------------------------------------------------------------------
const summarize = (content) => {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  return {
    texts: blocks.filter((b) => b.type === 'text').map((b) => b.text),
    images: blocks.filter((b) => b.type === 'image').map((b) => b.source?.media_type ?? b.mimeType),
  };
};
let last = null;
let turn = -1;
let toolUseSeq = 0;
let msgSeq = 0;
const text = (t) => {
  const id = `msg_fake_${++msgSeq}`;
  if (argv.includes('--include-partial-messages')) {
    emit({ type: 'stream_event', event: { type: 'message_start', message: { id, model: assistantModel } }, parent_tool_use_id: null });
    const half = Math.ceil(t.length / 2);
    for (const part of [t.slice(0, half), t.slice(half)]) if (part) emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } }, parent_tool_use_id: null });
  }
  emit({ type: 'assistant', message: { id, model: assistantModel, role: 'assistant', content: [{ type: 'text', text: t }], usage: { input_tokens: 10, output_tokens: 5 } }, parent_tool_use_id: null });
};

async function callTools(specs) {
  const uses = specs.map((s) => ({ spec: s, tool: byTitle(s.title) ?? { name: s.name ?? 'missing' }, id: `toolu_${++toolUseSeq}` }));
  emit({ type: 'assistant', message: { model: assistantModel, role: 'assistant', content: uses.map((u) => ({ type: 'tool_use', id: u.id, name: `mcp__${serverName}__${u.tool.name}`, input: u.spec.args })) }, parent_tool_use_id: null });
  const results = await Promise.all(uses.map((u) => rpc('tools/call', { name: u.tool.name, arguments: u.spec.args })));
  for (const [i, r] of results.entries()) {
    const s = summarize(r.result.content);
    record({ kind: 'result', title: uses[i].spec.title, isError: r.result.isError, ...s });
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: uses[i].id, content: r.result.content }] } });
    last = { ...s, isError: r.result.isError };
  }
}

async function runTurn(content) {
  const summary = summarize(content);
  record({ kind: 'user', ...summary });
  const actions = scenario.turns[turn] ?? [{ echoPrompt: true }];
  for (const a of actions) {
    if (a.text !== undefined) text(a.text);
    if (a.sleepMs) await new Promise((r) => setTimeout(r, a.sleepMs));
    if (a.echoPrompt) text(`prompt: ${summary.texts.join('|')} images=${summary.images.length}`);
    if (a.call) await callTools([a.call]);
    if (a.parallel) await callTools(a.parallel);
    if (a.cancel) {
      const tool = byTitle(a.cancel.title);
      const id = rpcId + 1;
      rpc('tools/call', { name: tool.name, arguments: a.cancel.args }).then(() => record({ kind: 'cancelled_call_answered' }));
      await new Promise((r) => setTimeout(r, a.cancel.afterMs));
      notify('notifications/cancelled', { requestId: id, reason: 'test' });
      record({ kind: 'cancel_sent' });
    }
    if (a.echoLast) text(`result: ${last.texts.join('|')} images=${last.images.join(',')} isError=${last.isError}`);
    if (a.assistantModel) assistantModel = a.assistantModel;
    if (a.synthetic) emit({ type: 'assistant', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'API Error: secret-detail' }] }, parent_tool_use_id: null });
    if (a.stderr) process.stderr.write(a.stderr);
    if (a.exit !== undefined) process.exit(a.exit);
    if (a.hang) await new Promise(() => {});
    if (a.error) {
      emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'secret failure text' });
      return;
    }
    if (a.errorResult) {
      emit({ type: 'result', subtype: 'success', is_error: true, result: a.errorResult });
      return;
    }
    if (a.garbage) process.stdout.write('this is not json\n');
    if (a.closeStdin) {
      // Node never closes fd 0 on destroy(); close the pipe's read end for real.
      process.stdin.removeAllListeners('end');
      process.stdin.pause();
      closeSync(0);
    }
    if (a.stopReading) {
      process.stdin.removeAllListeners('data');
      process.stdin.pause();
    }
    if (a.stubborn) {
      // A grandchild in Claude's process group that ignores SIGTERM.
      // Continue only once its TERM handler is installed (it says so on stdout).
      const g = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdout.write('ready\\n')"], { stdio: ['ignore', 'pipe', 'ignore'] });
      await new Promise((r) => g.stdout.once('data', r));
      g.stdout.destroy();
      record({ kind: 'stubborn_pid', pid: g.pid });
    }
  }
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 3 } });
}

let chain = Promise.resolve();
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'user') return;
  turn += 1;
  chain = chain.then(() => runTurn(msg.message.content));
});
process.stdin.on('end', () => {
  mcp.kill();
  process.exit(0);
});
