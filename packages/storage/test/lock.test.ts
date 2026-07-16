import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, utimesSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, GatewayError } from '@sigmarun/storage';
import { mkTmpDir, cleanup } from './helpers.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()!); });

describe('mkdir lock (contract: docs/17 §4)', () => {
  it('acquires and releases; reacquire after release succeeds', () => {
    const dir = mkTmpDir(); dirs.push(dir);
    const lock = join(dir, 'project.lock');
    const release = acquireLock(lock, { timeoutMs: 500, staleMs: 30_000 });
    expect(existsSync(lock)).toBe(true);
    release();
    expect(existsSync(lock)).toBe(false);
    acquireLock(lock, { timeoutMs: 500, staleMs: 30_000 })();
  });

  it('times out with lock_timeout while a fresh lock is held', () => {
    const dir = mkTmpDir(); dirs.push(dir);
    const lock = join(dir, 'project.lock');
    mkdirSync(lock);
    const t0 = Date.now();
    try {
      acquireLock(lock, { timeoutMs: 300, staleMs: 30_000 });
      expect.unreachable('should throw');
    } catch (e) {
      expect((e as GatewayError).code).toBe('lock_timeout');
    }
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('takes over a stale lock whose meta is unreadable (crashed before meta landed)', () => {
    const dir = mkTmpDir(); dirs.push(dir);
    const lock = join(dir, 'project.lock');
    mkdirSync(lock); // no meta.json — holder liveness cannot be proven, so it is seizable
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const release = acquireLock(lock, { timeoutMs: 500, staleMs: 30_000 });
    expect(existsSync(lock)).toBe(true);
    release();
  });

  it('takes over a stale lock whose holder process is gone (dead pid)', () => {
    const dir = mkTmpDir(); dirs.push(dir);
    const lock = join(dir, 'project.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'meta.json'), JSON.stringify({ pid: 424242, token: 'dead', acquired_at: new Date(Date.now() - 60_000).toISOString() }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const release = acquireLock(lock, { timeoutMs: 500, staleMs: 30_000 });
    expect(existsSync(lock)).toBe(true);
    release();
  });

  it('does NOT seize an alive holder whose lock mtime is merely old (long transaction)', () => {
    const dir = mkTmpDir(); dirs.push(dir);
    const lock = join(dir, 'project.lock');
    mkdirSync(lock);
    // meta names THIS (alive) process: an old mtime here is a long transaction, not a crash
    writeFileSync(join(lock, 'meta.json'), JSON.stringify({ pid: process.pid, token: 'alive', acquired_at: new Date(Date.now() - 60_000).toISOString() }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const t0 = Date.now();
    try {
      acquireLock(lock, { timeoutMs: 300, staleMs: 30_000 });
      expect.unreachable('an alive holder must not be seized');
    } catch (e) {
      expect((e as GatewayError).code).toBe('lock_timeout');
    }
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('seizes even an alive-looking holder past the hard ceiling (recycled-pid safety net)', () => {
    const dir = mkTmpDir(); dirs.push(dir);
    const lock = join(dir, 'project.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'meta.json'), JSON.stringify({ pid: process.pid, token: 'alive', acquired_at: new Date().toISOString() }));
    // staleMs=1000 → ceiling = 20s; a 30s-old mtime is past it, so seize regardless of liveness
    const old = new Date(Date.now() - 30_000);
    utimesSync(lock, old, old);
    const release = acquireLock(lock, { timeoutMs: 500, staleMs: 1000 });
    expect(existsSync(lock)).toBe(true);
    release();
  });
});
