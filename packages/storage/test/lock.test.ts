import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, utimesSync, existsSync } from 'node:fs';
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

  it('takes over a stale lock (mtime older than staleMs)', () => {
    const dir = mkTmpDir(); dirs.push(dir);
    const lock = join(dir, 'project.lock');
    mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const release = acquireLock(lock, { timeoutMs: 500, staleMs: 30_000 });
    expect(existsSync(lock)).toBe(true);
    release();
  });
});
