import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GatewayError } from './errors.js';

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
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

export function acquireLock(lockDir: string, opts: LockOptions = {}): () => void {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const staleMs = opts.staleMs ?? 30_000;
  const start = Date.now();
  let wait = 50;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'meta.json'), JSON.stringify({
        pid: process.pid,
        acquired_at: new Date().toISOString(),
      }));
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch {
      let stale = false;
      try {
        stale = Date.now() - statSync(lockDir).mtimeMs > staleMs;
      } catch { /* raced away between attempts; retry immediately */ }
      if (stale) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - start >= timeoutMs) {
        throw new GatewayError('lock_timeout', `Could not acquire lock within ${timeoutMs}ms: ${lockDir}`);
      }
      sleepSync(Math.min(wait, 1000));
      wait *= 2;
    }
  }
}
