// Newline-delimited JSON framing with a hard per-line byte bound.
//
// Lines are split on the 0x0A byte and each complete line is decoded with a
// fatal UTF-8 decoder, so malformed bytes fail instead of being replaced. The
// byte bound is checked before buffers are concatenated. At end of stream a
// non-empty final frame must still be a complete JSON value. An exception
// thrown by `onLine` becomes the same single failure as a framing error.

const NL = 0x0a;

/**
 * Feed chunks from `stream`; call `onLine(value)` for each parsed JSON line and
 * `onError(code)` once on the first oversize/undecodable/unparsable line or
 * handler failure (reading stops). `onEnd()` is called once on a clean end.
 */
export function readJsonLines(stream, { maxLineBytes, onLine, onError, onEnd = null }) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = [];
  let pendingBytes = 0;
  let failed = false;
  const fail = (code) => {
    if (failed) return;
    failed = true;
    pending = [];
    pendingBytes = 0;
    onError(code);
  };
  const handle = (bytes) => {
    let text;
    try {
      text = decoder.decode(bytes);
    } catch {
      return fail('line_not_utf8');
    }
    const trimmed = text.trim();
    if (!trimmed) return;
    let value;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return fail('line_not_json');
    }
    try {
      onLine(value);
    } catch {
      fail('line_handler_failed');
    }
  };
  stream.on('data', (chunk) => {
    if (failed) return;
    let buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    for (;;) {
      const nl = buf.indexOf(NL);
      if (nl === -1) break;
      if (pendingBytes + nl > maxLineBytes) return fail('line_too_large');
      const line = pending.length ? Buffer.concat([...pending, buf.subarray(0, nl)], pendingBytes + nl) : buf.subarray(0, nl);
      pending = [];
      pendingBytes = 0;
      buf = buf.subarray(nl + 1);
      handle(line);
      if (failed) return;
    }
    if (buf.length) {
      if (pendingBytes + buf.length > maxLineBytes) return fail('line_too_large');
      pending.push(buf);
      pendingBytes += buf.length;
    }
  });
  stream.on('end', () => {
    if (failed) return;
    if (pendingBytes) {
      const last = Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      handle(last);
      if (failed) return;
    }
    onEnd?.();
  });
}

export function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}
