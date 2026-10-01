// Owned process groups: every child the bridge spawns is a group leader
// (`detached: true`), so the whole group can be signalled and then checked.
// Reaping is bounded and returns whether closure was actually confirmed.

import { spawn } from 'node:child_process';

/** True while any process is left in group `pid` (EPERM also means it exists). */
export function groupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function signalGroup(pid, sig) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  try {
    process.kill(-pid, sig);
  } catch {
    // group already empty
  }
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * TERM the group, give it `graceMs`, KILL the group, then poll up to
 * `confirmMs` until the leader has exited and the group is empty.
 * Resolves true only when both are confirmed.
 */
export async function reapGroup(child, { graceMs, confirmMs = Math.max(1000, graceMs) }) {
  const pid = child?.pid;
  if (pid === undefined || pid === null) return true; // never started: nothing to reap
  // -0 / -1 would address our own group / every process: never signal those.
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  if (!hasExited(child) || groupAlive(pid)) {
    signalGroup(pid, 'SIGTERM');
    const end = Date.now() + graceMs;
    while (Date.now() < end && (!hasExited(child) || groupAlive(pid))) await sleep(20);
  }
  signalGroup(pid, 'SIGKILL');
  const end = Date.now() + confirmMs;
  while (Date.now() < end && (!hasExited(child) || groupAlive(pid))) await sleep(20);
  return hasExited(child) && !groupAlive(pid);
}

/**
 * Reap a process group known only by its id (no child object): TERM, grace,
 * KILL, confirm empty. For groups another owned process published for us.
 * `ownership.groupReaper` is the test injection point.
 */
export async function reapPgid(pgid, { graceMs, confirmMs = Math.max(1000, graceMs), ownership = null } = {}) {
  if (ownership?.groupReaper) return ownership.groupReaper(pgid, { graceMs });
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) return false;
  if (!groupAlive(pgid)) return true;
  signalGroup(pgid, 'SIGTERM');
  let end = Date.now() + graceMs;
  while (Date.now() < end && groupAlive(pgid)) await sleep(20);
  signalGroup(pgid, 'SIGKILL');
  end = Date.now() + confirmMs;
  while (Date.now() < end && groupAlive(pgid)) await sleep(20);
  return !groupAlive(pgid);
}

// ---- the owned-child settlement contract ------------------------------------
//
// A child counts as cleaned up only when BOTH are proven: the reaper confirmed
// its process group is gone, and its 'close' (all stdio released) was
// observed within the bound. Every owner (probes, app-CLI runs, app-server
// verification) settles through `settleOwned`; a caller must not report
// success, or release state the child could still use, unless `confirmed`.
// `ownership` is the scoped injection point for tests: { reaper, observeClose }.

export const DEFAULT_OWNERSHIP = Object.freeze({
  reaper: reapGroup,
  observeClose: (child) => new Promise((resolve) => child.once('close', () => resolve(true))),
});

/** Start observing close right after spawn (before it can be missed). */
export function watchClose(child, ownership = DEFAULT_OWNERSHIP) {
  return (ownership.observeClose ?? DEFAULT_OWNERSHIP.observeClose)(child);
}

/** Reap the group and wait (bounded) for the observed close. { reaped, closed, confirmed } */
export async function settleOwned(child, closedPromise, { graceMs, closeMs = Math.max(1000, graceMs), ownership = DEFAULT_OWNERSHIP }) {
  // Never spawned (spawn error, no pid): there is no process to reap or close to await.
  if (child?.pid === undefined || child?.pid === null) return { reaped: true, closed: true, confirmed: true };
  const reaper = ownership.reaper ?? reapGroup;
  const reaped = await reaper(child, { graceMs });
  let timer;
  const closed = await Promise.race([
    closedPromise.then(() => true, () => false),
    new Promise((r) => {
      timer = setTimeout(() => r(false), closeMs);
    }),
  ]);
  clearTimeout(timer);
  return { reaped, closed, confirmed: reaped === true && closed === true };
}

/**
 * Run a short probe command in its own group with a deadline and a bounded
 * stdout. The group is reaped whatever happens; the result is ok only if the
 * command succeeded AND its cleanup was confirmed (`confirmed`). stderr is discarded.
 * `onSpawn(pid)` / `onSettled(pid)` let an owner track live probe groups.
 */
export function runProbe(bin, args, { env, cwd, timeoutMs = 30_000, maxStdout = 256 * 1024, graceMs = 1000, signal = null, ownership = DEFAULT_OWNERSHIP, onSpawn = null, onSettled = null, input = null }) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ ok: false, stdout: '', reaped: true, closed: true, confirmed: true, aborted: true });
    let child;
    try {
      child = spawn(bin, args, { env, cwd, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: true, windowsHide: true });
    } catch {
      return resolve({ ok: false, stdout: '', reaped: true, closed: true, confirmed: true });
    }
    // Ownership is fully established (close watcher, handlers, deadline, abort)
    // BEFORE anyone else learns of the child, so a failing registration below
    // is settled by this owner instead of orphaning a detached group.
    let stdout = '';
    let overflow = false;
    let settled = false;
    let registrationFailed = false;
    const closed = watchClose(child, ownership);
    const finish = async (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Once the group is gone nothing holds the pipes; the rest of stdout arrives before close.
      const s = await settleOwned(child, closed, { graceMs, ownership });
      child.stdout.destroy();
      child.stderr.destroy();
      if (s.confirmed && child.pid && !registrationFailed) {
        // A failing settlement notice keeps the group tracked (safe over-approximation); never throws here.
        try {
          onSettled?.(child.pid);
        } catch {
          // tracking stays conservative
        }
      }
      resolve({ ok: ok && !overflow && s.confirmed && !registrationFailed, stdout: overflow ? '' : stdout, reaped: s.reaped, closed: s.closed, confirmed: s.confirmed, registrationFailed });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    // The owner (e.g. a session being shut down) may cancel: the probe group is reaped like a timeout.
    signal?.addEventListener('abort', () => finish(false), { once: true });
    // decoded as one stream: a character split across chunks stays whole
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (overflow) return;
      stdout += d;
      if (stdout.length > maxStdout) {
        overflow = true;
        stdout = '';
        finish(false);
      }
    });
    child.stderr.on('data', () => {});
    if (input !== null) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    child.once('error', () => finish(false));
    // 'exit', not 'close': a grandchild holding the pipes must not keep the probe open.
    child.once('exit', (code) => finish(code === 0));
    if (child.pid && onSpawn) {
      try {
        onSpawn(child.pid);
      } catch {
        // Could not register the group with our own owner: do not continue the probe.
        registrationFailed = true;
        finish(false);
      }
    }
  });
}
