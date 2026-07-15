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

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* short busy wait; CLI-scale contention only */ }
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
        stale = ageMs > staleMs;
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
      sleepSync(Math.min(wait, 1000));
      wait *= 2;
    }
  }
}
