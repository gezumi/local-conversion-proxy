// Unix-socket relay between the bridge and each session's MCP server process.
//
// The socket lives in the bridge's 0700 runtime directory. A connection must
// first send `{ t: 'hello', token }` with the per-session relay token; that
// binds it to exactly one session, which may have only one relay connection.
//
// Frames (JSON lines):
//   mcp -> bridge  { t: 'list', id } | { t: 'call', id, name, arguments } | { t: 'cancel', id }
//   bridge -> mcp  { t: 'ok' } | { t: 'list', id, tools } | { t: 'result', id, content, isError }

import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:net';
import { jsonLine, readJsonLines } from './lines.mjs';

const HELLO_TIMEOUT_MS = 15_000;

function sameToken(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export class RelayServer {
  #server = null;
  /** token -> session */
  #sessions = new Map();
  #sockets = new Set();

  constructor({ socketPath, maxLineBytes }) {
    this.socketPath = socketPath;
    this.maxLineBytes = maxLineBytes;
  }

  listen() {
    return new Promise((resolve, reject) => {
      const server = createServer((sock) => this.#onConnection(sock));
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        this.#server = server;
        resolve();
      });
    });
  }

  register(token, session) {
    this.#sessions.set(token, session);
  }

  unregister(token) {
    this.#sessions.delete(token);
  }

  #onConnection(sock) {
    this.#sockets.add(sock);
    sock.on('close', () => this.#sockets.delete(sock));
    sock.on('error', () => {});
    let session = null;
    const helloTimer = setTimeout(() => sock.destroy(), HELLO_TIMEOUT_MS);
    /** Resolves true once the socket accepted the whole frame, false if it cannot. */
    const send = (frame) =>
      new Promise((resolve) => {
        if (sock.destroyed || !sock.writable) return resolve(false);
        sock.write(jsonLine(frame), (err) => resolve(!err));
      });
    readJsonLines(sock, {
      maxLineBytes: this.maxLineBytes,
      onError: () => sock.destroy(),
      onLine: (msg) => {
        if (!session) {
          clearTimeout(helloTimer);
          let found = null;
          if (msg?.t === 'hello' && typeof msg.token === 'string') {
            for (const [token, s] of this.#sessions) if (sameToken(token, msg.token)) found = s;
          }
          if (!found || !found.attachRelay({ send, close: () => sock.destroy() })) return sock.destroy();
          session = found;
          sock.on('close', () => session.relayClosed());
          return send({ t: 'ok' });
        }
        session.onRelayFrame(msg);
      },
    });
  }

  close() {
    for (const s of this.#sockets) s.destroy();
    return new Promise((resolve) => {
      if (!this.#server) return resolve();
      this.#server.close(() => resolve());
    });
  }
}
