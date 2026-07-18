import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GatewayError } from './errors.js';
import { vlog, shortPath } from './log.js';

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
  /** Fired when THIS acquire wins a stale-lock takeover (after the atomic rename, before the
   * mkdir retry). The caller records it — the lock layer cannot write ledger events (layering). */
  onTakeover?: (info: { age_ms: number; stale_pid?: number; stale_token?: string }) => void;
}

/**
 * Block the calling thread for `ms` WITHOUT burning a core. Node has no synchronous sleep, but
 * Atomics.wait parks the thread on a never-signalled SharedArrayBuffer word until the timeout — a
 * real CPU yield. The old `while (Date.now() < end) {}` busy-spin pinned one core per waiter and,
 * under fan-out, the spinners starved the very holder they were all waiting on: superlinear
 * lock_timeout collapse (P1-10). Same idiom the watch loop already uses (cli.ts).
 */
const PARK = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(PARK, 0, 0, ms);
}

/**
 * mkdir-based advisory lock.
 * @contract docs/17 §4 — exponential backoff, total timeout -> lock_timeout; stale takeover: seize first, record after.
 */
/**
 * Non-throwing acquire: the single entry point transactions should use.
 * One helper instead of eleven hand-rolled try/catch IIFEs — the copies had
 * already drifted (publish locked a different path than every other run mutator).
 */
export function tryAcquireLock(lockDir: string, opts: LockOptions = {}): (() => void) | GatewayError {
  try {
    return acquireLock(lockDir, opts);
  } catch (err) {
    return err as GatewayError;
  }
}

/** Canonical run-transaction lock path: <runDir>/run.lock — every run mutator must use this. */
export function runLockPath(runDir: string): string {
  return join(runDir, 'run.lock');
}

let lockCounter = 0;

/**
 * Remove the lock ONLY if meta.json still carries our token. A takeover (below) or a
 * concurrent holder will have replaced the token, in which case releasing must be a no-op —
 * otherwise a slow-but-alive holder's `release()` would destroy the taker-over's live lock,
 * and a third contender would then mkdir into the gap: two holders at once (the silent-
 * corruption path the tokenless version had). If meta is unreadable we cannot prove ownership,
 * so we also leave it (a leaked dir is cleaned by the next stale takeover).
 */
function releaseIfMine(lockDir: string, token: string): void {
  try {
    const meta = JSON.parse(readFileSync(join(lockDir, 'meta.json'), 'utf8')) as { token?: string };
    if (meta.token === token) rmSync(lockDir, { recursive: true, force: true });
  } catch { /* absent/unreadable — cannot confirm ownership; do not remove */ }
}

/**
 * The lock dir's mtime is stamped once at mkdir and never refreshed, so age alone cannot tell a
 * crashed holder apart from a legitimately long transaction. Beyond this multiple of staleMs we
 * seize regardless — a bound so a recycled pid that probes as "alive" cannot leak the lock forever.
 */
const HARD_STALE_MULTIPLE = 20;

type Holder = 'alive' | 'dead' | 'unknown';

/**
 * Classify the process recorded in the lock's meta.json. Best-effort and same-host only — sigmarun
 * locks are repo-local, so probing the pid is valid:
 *   'alive'   — the pid is running, or EPERM (exists but not ours to signal). Never seizable early.
 *   'dead'    — meta names a pid and it is PROVABLY gone (ESRCH). Seizable at once: a crashed holder
 *               must not freeze the run for the whole staleMs window (P1-10).
 *   'unknown' — meta is absent/torn or has no numeric pid. This is NOT proof of death: a holder still
 *               between its mkdir and its meta write looks exactly like this, so we must not seize it
 *               early — fall back to age (only a staleMs-old meta-less lock is genuinely stale).
 * The distinction between 'dead' and 'unknown' is the crux: seizing 'unknown' early would steal a
 * lock a live process is still initialising (the mkdir→meta-write race in acquireLock itself).
 */
function probeHolder(lockDir: string): Holder {
  let pid: unknown;
  try {
    pid = (JSON.parse(readFileSync(join(lockDir, 'meta.json'), 'utf8')) as { pid?: unknown }).pid;
  } catch {
    return 'unknown'; // absent or torn meta — cannot prove death; may be mid-creation
  }
  if (typeof pid !== 'number') return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    // ESRCH ⇒ no such process (crashed). Anything else (EPERM, unexpected) ⇒ treat as alive: do not seize.
    return (err as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'alive';
  }
}

export function acquireLock(lockDir: string, opts: LockOptions = {}): () => void {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const staleMs = opts.staleMs ?? 30_000;
  const start = Date.now();
  const token = `${process.pid}-${Date.now()}-${lockCounter++}`;
  let wait = 50;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'meta.json'), JSON.stringify({
        pid: process.pid,
        token,
        acquired_at: new Date().toISOString(),
      }));
      vlog('lock', `acquired ${shortPath(lockDir)}`);
      return () => { vlog('lock', `released ${shortPath(lockDir)}`); releaseIfMine(lockDir, token); };
    } catch {
      let stale = false;
      let ageMs = 0;
      try {
        ageMs = Date.now() - statSync(lockDir).mtimeMs;
        // Pid-FIRST, not age-first (P1-10). The lock mtime is stamped once and never refreshed, so a
        // crashed holder and a legitimately long transaction are indistinguishable by age. Probe the
        // holder up front: a provably dead one is seized at once (no waiting out staleMs — that was
        // the crash-freeze); a live one is protected until the hard ceiling (a long transaction we
        // must not steal — recycled pids still get seized past the ceiling); an unprovable holder
        // (absent/torn meta, possibly mid-creation) falls back to plain age staleness.
        const holder = probeHolder(lockDir);
        stale =
          holder === 'dead' ||
          ageMs > staleMs * HARD_STALE_MULTIPLE ||
          (holder === 'unknown' && ageMs > staleMs);
      } catch { /* raced away between attempts; retry immediately */ }
      if (stale) {
        // Exclusive takeover: rename is atomic, so only ONE contender wins it — the losers
        // get ENOENT and fall back to the mkdir attempt. (The tokenless version had every
        // contender rmSync+mkdir, so two could both "win".)
        vlog('lock', `stale takeover of ${shortPath(lockDir)}`);
        const dead = `${lockDir}.dead-${token}`;
        try {
          renameSync(lockDir, dead);
          let staleMeta: { pid?: number; token?: string } = {};
          try {
            staleMeta = JSON.parse(readFileSync(join(dead, 'meta.json'), 'utf8')) as { pid?: number; token?: string };
          } catch { /* holder crashed before meta landed — age is all we know */ }
          rmSync(dead, { recursive: true, force: true });
          opts.onTakeover?.({ age_ms: Math.round(ageMs), stale_pid: staleMeta.pid, stale_token: staleMeta.token });
        } catch { /* another contender took it first — just retry the mkdir */ }
        continue;
      }
      if (Date.now() - start >= timeoutMs) {
        vlog('lock', `timeout on ${shortPath(lockDir)} after ${timeoutMs}ms`);
        throw new GatewayError('lock_timeout', `Could not acquire lock within ${timeoutMs}ms: ${lockDir}`);
      }
      // Exponential backoff with bounded random jitter: [cap/2, cap). The jitter de-synchronises
      // contenders so N waiters don't wake in lockstep and collide on the same mkdir (thundering
      // herd) — with the busy-wait gone, this is what keeps high fan-out from re-stampeding.
      const cap = Math.min(wait, 1000);
      sleepSync(Math.floor(cap / 2 + Math.random() * (cap / 2)));
      wait *= 2;
    }
  }
}
