import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { GatewayError, readJsonState, type ResolveOptions } from '@sigmarun/storage';
import { failEnvelope, okEnvelope, type Envelope } from '@sigmarun/core';
import { openRun, sweepRun } from '@sigmarun/dispatch';
import { computeProgress, writeProgress } from './progress.js';

export interface WatchOptions extends ResolveOptions {
  runId: string;
  force?: boolean;
  /** test hook: keep the advisory lock after the tick to simulate a long-running watcher */
  holdLock?: boolean;
}

const TERMINAL = new Set(['reported', 'archived', 'cancelled']);

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
  if (TERMINAL.has(run.status)) {
    return okEnvelope({
      message: `Run ${runId} is ${run.status} (terminal); watch exits.`,
      data: { terminal: true, run_status: run.status },
      startedAt,
    });
  }

  const lockDir = join(runDir, 'locks', 'watch.lock');
  let acquired = false;
  if (!opts.force) {
    try {
      mkdirSync(lockDir, { recursive: false });
      acquired = true;
    } catch {
      if (existsSync(lockDir)) {
        return failEnvelope('lock_timeout', `Another watch already holds ${runId} (locks/watch.lock). Use --force to override.`, {
          startedAt,
        });
      }
      mkdirSync(lockDir, { recursive: true });
      acquired = true;
    }
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
    if (acquired && !opts.holdLock) rmSync(lockDir, { recursive: true, force: true });
  }
}
