// Private scratch directories: created by this run, owner-only, removed by this run.
//
// Every directory is a fresh `mkdtemp` (so it cannot pre-exist or be a planted
// link) chmod'ed to 0700. Its identity (dev + inode) is recorded at creation.
// Only a recorded directory whose on-disk identity still matches is removed,
// and the record is dropped only after removal succeeded, so a failed cleanup
// stays visible (`leftovers`) for diagnosis.

import { chmodSync, closeSync, lstatSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

/** macOS sun_path is 104 bytes; keep room for `/<dir>/r.sock`. */
const MAX_BASE_CHARS = 72;

function baseTmp() {
  let base = tmpdir();
  try {
    base = realpathSync(base);
  } catch {
    base = '/tmp';
  }
  return base.length > MAX_BASE_CHARS ? realpathSync('/tmp') : base;
}

function ownedDirStat(dir) {
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('runtime_dir_unsafe');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('runtime_dir_owner');
  return st;
}

export class RuntimeDirs {
  /** path -> { dev, ino } */
  #created = new Map();

  /**
   * A new owner-only directory, optionally inside `parent`. A parent must be a
   * directory this instance created and still holds with the same identity.
   */
  make(prefix = 'cbl-', parent = null) {
    if (parent !== null) this.#assertOwned(parent);
    const dir = mkdtempSync(join(parent ?? baseTmp(), prefix));
    chmodSync(dir, 0o700);
    const st = ownedDirStat(dir);
    this.#created.set(dir, { dev: st.dev, ino: st.ino });
    return dir;
  }

  owns(dir) {
    try {
      this.#assertOwned(dir);
      return true;
    } catch {
      return false;
    }
  }

  #assertOwned(dir) {
    const id = this.#created.get(dir);
    if (!id) throw new Error('runtime_dir_not_owned');
    const st = ownedDirStat(dir);
    if (st.dev !== id.dev || st.ino !== id.ino) throw new Error('runtime_dir_replaced');
  }

  /**
   * Remove one directory this instance created. Anything else is refused.
   * Returns true when the directory is gone. On failure (or identity change)
   * the record is kept so `leftovers` reports it.
   */
  remove(dir) {
    const id = this.#created.get(dir);
    if (!id) return false;
    let st;
    try {
      st = lstatSync(dir);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        this.#forget(dir);
        return true;
      }
      return false;
    }
    if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== id.dev || st.ino !== id.ino) return false;
    try {
      rmSync(dir, { recursive: true, force: false });
    } catch {
      return false;
    }
    this.#forget(dir);
    return true;
  }

  /** Drop `dir` and every recorded descendant (they went with it). */
  #forget(dir) {
    this.#created.delete(dir);
    for (const other of [...this.#created.keys()]) if (other.startsWith(dir + sep)) this.#created.delete(other);
  }

  removeAll() {
    // Children before parents: longest paths first.
    for (const dir of [...this.#created.keys()].sort((a, b) => b.length - a.length)) this.remove(dir);
    return this.#created.size === 0;
  }

  /** Directories whose removal failed or has not happened yet. */
  get leftovers() {
    return [...this.#created.keys()];
  }

  get count() {
    return this.#created.size;
  }
}

/**
 * Create a new 0600 file (never through an existing path) and write all of
 * `contents`. `writeFileSync` on an fd loops until every byte is written.
 */
export function writeOwnerOnlyFile(path, contents) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, contents);
  } finally {
    closeSync(fd);
  }
  return path;
}
