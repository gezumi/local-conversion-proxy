#!/usr/bin/env node
// Stdio MCP server that Claude Code starts for one bridge session.
//
// It owns no tools itself: tools/list and tools/call are forwarded over the
// bridge's Unix-socket relay (authenticated by a per-session token from the
// environment), and a tools/call response is written only when the bridge
// answers with Codex's real output. If the relay or stdin goes away, it exits.

import { connect } from 'node:net';
import { jsonLine, readJsonLines } from './lines.mjs';

const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_LINE_BYTES = 48 * 1024 * 1024;

const socketPath = process.env.CLAUDE_BRIDGE_RELAY_SOCKET;
const token = process.env.CLAUDE_BRIDGE_RELAY_TOKEN;
if (!socketPath || !token) process.exit(2);

let nextRelayId = 1;
/** relay id -> { rpcId, kind } */
const inflight = new Map();
/** JSON-RPC id -> relay id, for cancellation */
const byRpc = new Map();
let ready = false;
const queued = [];

function out(msg) {
  process.stdout.write(jsonLine({ jsonrpc: '2.0', ...msg }));
}

function fail(id, code, message) {
  out({ id, error: { code, message } });
}

const sock = connect(socketPath);
sock.on('error', () => process.exit(1));
sock.on('close', () => process.exit(1));
sock.on('connect', () => sock.write(jsonLine({ t: 'hello', token })));

function toRelay(frame) {
  if (ready) sock.write(jsonLine(frame));
  else queued.push(frame);
}

readJsonLines(sock, {
  maxLineBytes: MAX_LINE_BYTES,
  onError: () => process.exit(1),
  onLine: (msg) => {
    if (msg?.t === 'ok') {
      ready = true;
      for (const f of queued.splice(0)) sock.write(jsonLine(f));
      return;
    }
    const pending = inflight.get(msg?.id);
    if (!pending) return;
    inflight.delete(msg.id);
    byRpc.delete(pending.rpcId);
    if (msg.t === 'list' && pending.kind === 'list') {
      out({ id: pending.rpcId, result: { tools: Array.isArray(msg.tools) ? msg.tools : [] } });
    } else if (msg.t === 'result' && pending.kind === 'call') {
      out({ id: pending.rpcId, result: { content: Array.isArray(msg.content) ? msg.content : [], isError: msg.isError === true } });
    }
  },
});

function forward(rpcId, kind, frame) {
  const id = nextRelayId++;
  inflight.set(id, { rpcId, kind });
  byRpc.set(rpcId, id);
  toRelay({ ...frame, id });
}

readJsonLines(process.stdin, {
  maxLineBytes: MAX_LINE_BYTES,
  onError: () => process.exit(1),
  onLine: (msg) => {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        return out({
          id,
          result: {
            protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[1],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'codex-bridge-relay', version: '0.1.0' },
          },
        });
      }
      case 'ping':
        return out({ id, result: {} });
      case 'tools/list':
        return forward(id, 'list', { t: 'list' });
      case 'tools/call':
        if (typeof params?.name !== 'string') return fail(id, -32602, 'tools/call requires a tool name');
        return forward(id, 'call', { t: 'call', name: params.name, arguments: params.arguments ?? {} });
      case 'notifications/cancelled': {
        const relayId = byRpc.get(params?.requestId);
        if (relayId !== undefined) {
          inflight.delete(relayId);
          byRpc.delete(params.requestId);
          toRelay({ t: 'cancel', id: relayId });
        }
        return;
      }
      default:
        if (isRequest) {
          if (method === 'resources/list') return out({ id, result: { resources: [] } });
          if (method === 'prompts/list') return out({ id, result: { prompts: [] } });
          return fail(id, -32601, 'method not found');
        }
    }
  },
});

process.stdin.on('end', () => process.exit(0));
