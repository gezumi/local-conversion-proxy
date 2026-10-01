// Caches of conversations, bounded by entry count AND by total size: they
// live in the process that also carries GPT traffic, so they must never grow
// without limit. The oldest entries go first; one too large to keep is not kept.

export class BoundedMap {
  #map = new Map(); // key -> { value, bytes }
  #bytes = 0;

  constructor({ maxEntries, maxBytes }) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  get size() {
    return this.#map.size;
  }

  get bytes() {
    return this.#bytes;
  }

  has(key) {
    return this.#map.has(key);
  }

  get(key) {
    return this.#map.get(key)?.value;
  }

  delete(key) {
    const e = this.#map.get(key);
    if (!e) return false;
    this.#bytes -= e.bytes;
    this.#map.delete(key);
    return true;
  }

  /** Store `value` costing `bytes` (approxBytes(value) if omitted); false if it is too large to keep. */
  set(key, value, bytes = approxBytes(value)) {
    this.delete(key);
    if (bytes > this.maxBytes) return false;
    this.#map.set(key, { value, bytes });
    this.#bytes += bytes;
    while (this.#map.size > this.maxEntries || this.#bytes > this.maxBytes) this.delete(this.#map.keys().next().value);
    return true;
  }
}

/** Approximate memory of a JSON-like value (strings counted at 2 bytes per character). */
export function approxBytes(value, depth = 0) {
  if (typeof value === 'string') return 2 * value.length + 16;
  if (value === null || typeof value !== 'object') return 8;
  if (depth > 64) return 64;
  let n = 32;
  if (Array.isArray(value)) {
    for (const v of value) n += approxBytes(v, depth + 1);
  } else {
    for (const k of Object.keys(value)) n += 2 * k.length + approxBytes(value[k], depth + 1);
  }
  return n;
}
