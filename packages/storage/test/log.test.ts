import { describe, it, expect, afterEach, vi } from 'vitest';
import { setVerbose, isVerbose, vlog, shortPath } from '@sigmarun/storage';

afterEach(() => setVerbose(false));

describe('verbose step tracing (roadmap Phase 1 observability)', () => {
  it('vlog writes to stderr only when enabled, and never to stdout', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      vlog('lock', 'acquired run.lock');
      expect(err).not.toHaveBeenCalled(); // off by default
      setVerbose(true);
      expect(isVerbose()).toBe(true);
      vlog('lock', 'acquired run.lock');
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0]![0])).toContain('[sigmarun:lock] acquired run.lock');
      expect(out).not.toHaveBeenCalled(); // stdout envelope stays clean
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });

  it('shortPath tails an absolute state path under .team/', () => {
    expect(shortPath('/home/u/repo/.team/runs/RUN-0001/claims/task-claims.json'))
      .toBe('runs/RUN-0001/claims/task-claims.json');
    expect(shortPath('/tmp/x/counters.json')).toBe('x/counters.json');
  });
});
