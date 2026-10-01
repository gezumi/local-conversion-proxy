// The one change this tool makes to ~/.codex/config.toml: a single line
//   openai_base_url = "http://127.0.0.1:<port>" # local-conversion-proxy
// at the very top of the file (always top level in TOML, whatever follows).
// The provider stays Codex's built-in `openai` one (ChatGPT sign-in, features
// and GPT models unchanged). Removing the line restores direct access for new
// threads at once; a running Codex app needs no restart for that.
//
// While the proxy is off (by hand, or by the watchdog), a default model only
// the proxy can serve (claude-… / local-…) is replaced by the recorded GPT
// model, or commented out when there is none, and put back when it is on.
//
// Every edit goes through a small TOML scanner: only whole statements outside
// strings and multi-line values are ever changed, every other byte is kept
// (a leading BOM stays first), and an edit that would repeat a key is refused.
// A backup is written before each change; a symlinked config is edited at its
// target.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const MARK = '# local-conversion-proxy';
const OURS = /^[ \t]*openai_base_url[ \t]*=[ \t]*"http:\/\/127\.0\.0\.1:(\d+)"[ \t]*# local-conversion-proxy[ \t]*$/;
const BOM = '﻿';
export const SWAP_MARK = '# lcp-swapped: ';
/** Default models only the proxy can serve. */
export const LOCAL_MODEL = /^(claude-|local-)[A-Za-z0-9._:-]+$/;
const SAFE_MODEL = /^[A-Za-z0-9._:-]+$/;

export function managedLine(port) {
  return `openai_base_url = "http://127.0.0.1:${port}" ${MARK}`;
}

function splitLines(text) {
  // Keep each line's own terminator so untouched lines are byte-identical.
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

const isWs = (c) => c === ' ' || c === '\t';

function unescapeBasic(s) {
  try {
    return s.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (_, e) => {
      if (e.length > 1) return String.fromCodePoint(Number.parseInt(e.slice(1), 16));
      return { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }[e] ?? e;
    });
  } catch {
    return s;
  }
}

/** The key of a `key = value` statement at s[i] (bare, "basic", 'literal', dotted): { parts, end } (end: just after `=`), or null. */
function readKey(s, i) {
  const parts = [];
  for (;;) {
    while (isWs(s[i])) i += 1;
    if (s[i] === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      if (j >= s.length) return null;
      parts.push(unescapeBasic(s.slice(i + 1, j)));
      i = j + 1;
    } else if (s[i] === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return null;
      parts.push(s.slice(i + 1, j));
      i = j + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!m) return null;
      parts.push(m[0]);
      i += m[0].length;
    }
    while (isWs(s[i])) i += 1;
    if (s[i] === '.') {
      i += 1;
      continue;
    }
    return s[i] === '=' ? { parts, end: i + 1 } : null;
  }
}

/** Lex s from i to the end of the line, carrying an open multi-line string and the bracket depth of a value. */
function lexRest(s, i, state) {
  let { ml, depth } = state;
  while (i < s.length) {
    if (ml) {
      if (ml === '"""' && s[i] === '\\') {
        i += 2;
        continue;
      }
      if (s[i] === ml[0]) {
        let n = 0;
        while (s[i + n] === ml[0]) n += 1;
        i += n;
        if (n >= 3) ml = null; // up to two quotes before the closing three are content
        continue;
      }
      i += 1;
      continue;
    }
    const c = s[i];
    if (c === '#') break; // a comment runs to the end of the line
    if (c === '"' || c === "'") {
      if (s.startsWith(c.repeat(3), i)) {
        ml = c.repeat(3);
        i += 3;
        continue;
      }
      i += 1;
      while (i < s.length && s[i] !== c) i += c === '"' && s[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === '[' || c === '{') depth += 1;
    else if ((c === ']' || c === '}') && depth > 0) depth -= 1;
    i += 1;
  }
  return { ml, depth };
}

/**
 * A line-level view of a TOML document. Each line is one of: 'blank',
 * 'comment', 'table' (a header), 'keyval' (a statement; `key` holds its key
 * parts, `valueAt` where its value starts), 'unknown' (a statement this
 * scanner cannot read) or 'continuation' (inside a multi-line string, array
 * or inline table: never edited). `root`: before the first table header.
 */
export function scanToml(text) {
  const hadBom = text.startsWith(BOM);
  const lines = [];
  let state = { ml: null, depth: 0 };
  let root = true;
  for (const raw of splitLines(hadBom ? text.slice(1) : text)) {
    const clean = raw.replace(/\r?\n?$/, '');
    const rec = { raw, clean, kind: 'continuation', root, key: null, valueAt: 0 };
    let from = 0;
    if (!state.ml && state.depth === 0) {
      const lead = clean.length - clean.replace(/^[ \t]+/, '').length;
      const c = clean[lead];
      if (c === undefined) {
        rec.kind = 'blank';
      } else if (c === '#') {
        rec.kind = 'comment';
        from = clean.length;
      } else if (c === '[') {
        rec.kind = 'table';
        root = false;
        rec.root = false;
        from = lead;
      } else {
        const k = readKey(clean, lead);
        if (k) {
          rec.kind = 'keyval';
          rec.key = k.parts;
          rec.valueAt = k.end;
          from = k.end;
        } else {
          rec.kind = 'unknown';
        }
      }
    }
    state = lexRest(clean, from, state);
    lines.push(rec);
  }
  return { hadBom, lines };
}

function joinLines(hadBom, lines) {
  return `${hadBom ? BOM : ''}${lines.map((l) => l.raw).join('')}`;
}

const keyIs = (l, name) => l.kind === 'keyval' && l.key.length === 1 && l.key[0] === name;
const isOurs = (l) => l.kind === 'keyval' && OURS.test(l.clean);
const isForeign = (l) => l.root && keyIs(l, 'openai_base_url') && !OURS.test(l.clean);

function rootCount(lines, name) {
  return lines.filter((l) => l.root && keyIs(l, name)).length;
}

/** An edit may never repeat a root key it touches (Codex would refuse the whole file). */
function guard(before, after) {
  const a = scanToml(before).lines;
  const b = scanToml(after).lines;
  for (const name of ['openai_base_url', 'model']) {
    if (rootCount(b, name) > Math.max(1, rootCount(a, name))) throw Object.assign(new Error(`config.toml edit would repeat ${name}`), { code: 'config_duplicate_key' });
  }
  return after;
}

/** { enabled, port, foreign }: our line present (and its port); another top-level openai_base_url. */
export function configState(text) {
  const { lines } = scanToml(text);
  const ours = lines.find((l) => isOurs(l) && l.root) ?? lines.find(isOurs);
  return { enabled: Boolean(ours), port: ours ? Number(OURS.exec(ours.clean)[1]) : null, foreign: lines.some(isForeign) };
}

/** Text without our line(s), wherever a statement of ours is. */
export function disableText(text) {
  const doc = scanToml(text);
  const kept = doc.lines.filter((l) => !isOurs(l));
  if (kept.length === doc.lines.length) return text;
  return guard(text, joinLines(doc.hadBom, kept));
}

/** Text with our line (for `port`) as the first line. Throws if another top-level openai_base_url is set. */
export function enableText(text, port) {
  const doc = scanToml(text);
  if (doc.lines.some(isForeign)) throw Object.assign(new Error('config.toml already sets openai_base_url'), { code: 'foreign_base_url' });
  const ours = doc.lines.filter(isOurs);
  if (ours.length === 1 && doc.lines[0] === ours[0] && ours[0].clean === managedLine(port)) return text;
  const kept = doc.lines.filter((l) => !isOurs(l));
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return guard(text, `${doc.hadBom ? BOM : ''}${managedLine(port)}${eol}${kept.map((l) => l.raw).join('')}`);
}

/** A TOML string at s[i] (basic, literal, or multi-line of either), decoded: { value, end }, or null. */
function readString(s, i) {
  const q = s[i];
  if (q !== '"' && q !== "'") return null;
  if (s.startsWith(q.repeat(3), i)) {
    let j = i + 3;
    while (j < s.length) {
      if (q === '"' && s[j] === '\\') {
        j += 2;
        continue;
      }
      if (s[j] === q) {
        let n = 0;
        while (s[j + n] === q) n += 1;
        if (n >= 3) {
          let body = s.slice(i + 3, j + n - 3).replace(/^\r?\n/, '');
          if (q === '"') body = unescapeBasic(body.replace(/\\[ \t]*\r?\n[ \t\r\n]*/g, ''));
          return { value: body, end: j + n };
        }
        j += n;
        continue;
      }
      j += 1;
    }
    return null;
  }
  let j = i + 1;
  while (j < s.length && s[j] !== q && s[j] !== '\n') j += q === '"' && s[j] === '\\' ? 2 : 1;
  if (s[j] !== q) return null;
  const raw = s.slice(i + 1, j);
  return { value: q === '"' ? unescapeBasic(raw) : raw, end: j + 1 };
}

/**
 * The root-table `model` statement: { index, count, value } — its first line,
 * how many lines it spans, and its decoded string value (null if it is not a
 * string) — or null.
 */
function modelStatement(lines) {
  const index = lines.findIndex((l) => l.root && keyIs(l, 'model'));
  if (index < 0) return null;
  let count = 1;
  while (index + count < lines.length && lines[index + count].kind === 'continuation') count += 1;
  const text = lines
    .slice(index, index + count)
    .map((l) => l.raw)
    .join('');
  let i = lines[index].valueAt;
  while (isWs(text[i])) i += 1;
  const str = readString(text, i);
  const value = str && /^[ \t]*(#[^\n]*)?\r?\n?$/.test(text.slice(str.end)) ? str.value : null;
  return { index, count, value };
}

/** The default model (the root `model`, whatever its TOML spelling), or null. */
export function topLevelModel(text) {
  return modelStatement(scanToml(text).lines)?.value ?? null;
}

export const FALLBACK_MARK = '# lcp-fallback';
const FALLBACK_LINE = /^model = "[A-Za-z0-9._:-]+" # lcp-fallback$/;

/**
 * Codex without the proxy: our line removed; a default model only the proxy
 * can serve is commented out (every line of its statement, as written), with
 * `fallback` (a GPT model) as a marked model line after it when there is one.
 * { text, swapped }: swapped is the model that was set aside ('' if none).
 */
export function failOpenText(text, fallback = '') {
  const doc = scanToml(text);
  const lines = doc.lines.filter((l) => !isOurs(l));
  let swapped = '';
  const m = modelStatement(lines);
  if (m?.value && LOCAL_MODEL.test(m.value)) {
    swapped = m.value;
    const old = lines.slice(m.index, m.index + m.count);
    const eol = /\r\n$/.test(old[0].raw) ? '\r\n' : '\n';
    const hadEol = /\n$/.test(old.at(-1).raw);
    const usable = typeof fallback === 'string' && SAFE_MODEL.test(fallback) && !LOCAL_MODEL.test(fallback);
    // at the end of a file without a final newline, the inserted line carries none (unswap puts it back exactly)
    const commented = old.map((l, k) => ({ ...l, kind: 'comment', raw: `${SWAP_MARK}${l.raw}${usable && !hadEol && k === old.length - 1 ? eol : ''}` }));
    const insert = usable ? [{ raw: `model = "${fallback}" ${FALLBACK_MARK}${hadEol ? eol : ''}`, clean: `model = "${fallback}" ${FALLBACK_MARK}`, kind: 'keyval', root: true, key: ['model'] }] : [];
    lines.splice(m.index, m.count, ...commented, ...insert);
  }
  if (lines.length === doc.lines.length && !swapped) return { text, swapped };
  return { text: guard(text, joinLines(doc.hadBom, lines)), swapped };
}

/**
 * Our set-aside statements (`# lcp-swapped: …` lines): [{ start, end, value }]
 * — their line ranges and the model each one sets. One run of such lines can
 * hold several statements, set aside at different times.
 */
function swappedBlocks(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!(lines[i].root && lines[i].kind === 'comment' && lines[i].raw.startsWith(SWAP_MARK))) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].raw.startsWith(SWAP_MARK)) j += 1;
    const inner = scanToml(
      lines
        .slice(i, j)
        .map((l) => l.raw.slice(SWAP_MARK.length))
        .join(''),
    ).lines;
    for (let k = 0; k < inner.length; ) {
      let e = k + 1;
      while (e < inner.length && inner[e].kind === 'continuation') e += 1;
      blocks.push({ start: i + k, end: i + e, value: topLevelModel(inner.slice(k, e).map((l) => l.raw).join('')) });
      k = e;
    }
    i = j - 1;
  }
  return blocks;
}

/**
 * Undo failOpenText's model change: our marked fallback line out and the
 * statement set aside for `swapped` back, byte for byte (other set-aside
 * statements are obsolete and go). A model chosen since then — by other means,
 * or in our line — stays, and every set-aside statement goes.
 */
export function unswapText(text, swapped, fallback = '') {
  if (!swapped || !LOCAL_MODEL.test(swapped)) return text;
  const doc = scanToml(text);
  const lines = [...doc.lines];
  const m = modelStatement(lines);
  const ours = m && m.count === 1 && FALLBACK_LINE.test(lines[m.index].clean) && (!fallback || m.value === fallback);
  const dropBlocks = (list) => {
    const drop = new Set(swappedBlocks(list).flatMap((b) => Array.from({ length: b.end - b.start }, (_, k) => b.start + k)));
    return list.filter((_, i) => !drop.has(i));
  };
  if (m && !ours) {
    const kept = dropBlocks(lines);
    return kept.length === lines.length ? text : guard(text, joinLines(doc.hadBom, kept));
  }
  if (ours) {
    const atEof = !/\n$/.test(lines[m.index].raw);
    lines.splice(m.index, 1);
    if (atEof && m.index > 0) lines[m.index - 1] = { ...lines[m.index - 1], raw: lines[m.index - 1].raw.replace(/\r?\n$/, '') };
  }
  const target = swappedBlocks(lines)
    .filter((b) => b.value === swapped)
    .at(-1);
  if (!target) return text;
  for (let i = target.start; i < target.end; i += 1) lines[i] = { ...lines[i], raw: lines[i].raw.slice(SWAP_MARK.length) };
  // the restored lines no longer carry the mark: what is left of them is obsolete
  return guard(text, joinLines(doc.hadBom, dropBlocks(lines)));
}

function backup(backupsDir, text) {
  mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(backupsDir, `config.toml.${stamp}`), text, { mode: 0o600 });
  const all = readdirSync(backupsDir).filter((f) => f.startsWith('config.toml.')).sort();
  for (const f of all.slice(0, Math.max(0, all.length - 30))) rmSync(join(backupsDir, f), { force: true });
}

function writeAtomic(path, text) {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.config.toml.lcp-${process.pid}.tmp`);
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/** The real file behind config.toml (a symlinked config is edited in place, the link kept). */
export function configTarget(configPath) {
  try {
    return realpathSync(configPath);
  } catch {
    return configPath;
  }
}

/** Apply a change; returns { changed, before, after }. A missing config is created. */
export function updateConfig(configPath, backupsDir, change) {
  const target = configTarget(configPath);
  const before = existsSync(target) ? readFileSync(target, 'utf8') : '';
  const after = change(before);
  if (after === before) return { changed: false, before, after };
  backup(backupsDir, before);
  writeAtomic(target, after);
  return { changed: true, before, after };
}

export function readConfigState(configPath) {
  const target = configTarget(configPath);
  if (!existsSync(target)) return { exists: false, enabled: false, port: null, foreign: false };
  return { exists: true, ...configState(readFileSync(target, 'utf8')) };
}
