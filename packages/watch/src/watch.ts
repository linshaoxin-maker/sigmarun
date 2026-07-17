import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { GatewayError, readJsonState, tryAcquireLock, type ResolveOptions } from '@sigmarun/storage';
import { failEnvelope, okEnvelope, RUN_TERMINAL, type Envelope } from '@sigmarun/core';
import { openRun, sweepRun } from '@sigmarun/dispatch';
import { computeProgress, writeProgress } from './progress.js';

export interface WatchOptions extends ResolveOptions {
  runId: string;
  force?: boolean;
  /** Keep the advisory lock held after the tick returns. The looped `watch` sets this so the
   * single-instance lock spans the WHOLE loop, not just the first tick — otherwise the lock was
   * released immediately and every later (force:true) tick skipped locking, letting two watchers
   * run at once. Also a test hook for simulating a long-running watcher. */
  holdLock?: boolean;
}

// RUN_TERMINAL lives in core/state-machine (E2) — one vocabulary, not one per consumer.

/**
 * One watch tick (docs/17 §7): advisory single-instance lock, sweep (same code as claim-next),
 * lock-free progress recompute, snapshot out. The looped mode wraps this; tests drive --once.
 */
export function watchOnce(opts: WatchOptions): Envelope {
  const startedAt = Date.now();
  const ctx = openRun(opts);
  if (ctx instanceof GatewayError) return failEnvelope(ctx.code, ctx.message, { startedAt });
  const { runDir, runId } = ctx;

  const run = readJsonState(join(runDir, 'run.json')).doc as { status: string };
  if (RUN_TERMINAL.has(run.status)) {
    return okEnvelope({
      message: `Run ${runId} is ${run.status} (terminal); watch exits.`,
      data: { terminal: true, run_status: run.status },
      startedAt,
    });
  }

  // Single-instance advisory lock via the lock-manager (was a raw mkdir with NO stale handling —
  // the one V6 violation in the codebase: a kill -9'd watcher locked the run out of watch forever,
  // with --force as the only exit. The manager's 60s stale takeover now self-heals that).
  const lockDir = join(runDir, 'locks', 'watch.lock');
  let release: (() => void) | null = null;
  if (!opts.force) {
    mkdirSync(join(runDir, 'locks'), { recursive: true });
    const r = tryAcquireLock(lockDir, { timeoutMs: 1, staleMs: 60_000 });
    if (r instanceof GatewayError) {
      return failEnvelope('lock_timeout', `Another watch already holds ${runId} (locks/watch.lock). Use --force to override.`, {
        startedAt,
      });
    }
    release = r;
  }

  try {
    const sweep = sweepRun({ cwd: opts.cwd, env: opts.env, teamRootFlag: opts.teamRootFlag, runId, triggeredBy: 'watch' });
    const swept = sweep.ok ? (sweep.data as { reclaimed: Array<{ task_id: string }> }).reclaimed : [];
    const progress = computeProgress(runDir);
    writeProgress(runDir, progress);
    return okEnvelope({
      message: `Tick on ${runId}: ${swept.length} reclaimed, progress ${progress.progress_pct as number}%.`,
      data: { terminal: false, swept, progress },
      startedAt,
    });
  } finally {
    if (release && !opts.holdLock) release();
  }
}
