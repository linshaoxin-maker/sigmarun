import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { GatewayError, assertRealPathInside, readJsonState, writeJsonStateAtomic, type ResolveOptions } from '@sigmarun/storage';
import { appendEvent, failEnvelope, okEnvelope, type Envelope } from '@sigmarun/core';
import { findActiveClaim, loadClaims, openRun, readOrDefault, saveState, withRunLock, type TaskRow } from './claim-engine.js';

export interface WorktreeRegisterOptions extends ResolveOptions {
  runId: string;
  taskId: string;
  agentId: string;
  path: string;
  branch: string;
}

export interface WorktreeAdoptOptions extends ResolveOptions {
  runId: string;
  taskId: string;
  agentId: string;
}

interface WorktreeEntry {
  worktree_id: string;
  task_id: string;
  path: string;
  branch: string;
  base_branch: string;
  base_commit: string;
  status: string;
  owner_agent_id: string | null;
  previous_owner_agent_ids: string[];
  created_at: string;
}

function loadWorktrees(runDir: string, runId: string) {
  const file = join(runDir, 'worktrees.json');
  const state = readOrDefault(file, { schema_version: 'team.worktrees.v1', run_id: runId, entries: [] });
  return { file, doc: state.doc as { entries: WorktreeEntry[] } & Record<string, unknown>, rev: state.rev };
}

/** claimed -> working: the "worktree exists" precondition of docs/15 §3.3, row `claimed -> working`. */
function startTask(runDir: string, taskId: string): { row?: TaskRow; commit: () => void } {
  const taskFile = join(runDir, 'tasks', taskId, 'task.json');
  const task = readJsonState(taskFile);
  (task.doc as Record<string, unknown>).status = 'working';
  const listFile = join(runDir, 'team-task-list.json');
  const list = readJsonState(listFile);
  const row = (list.doc as { tasks: TaskRow[] }).tasks.find((r) => r.task_id === taskId);
  if (row) row.status = 'working';
  return {
    row,
    commit: () => {
      writeJsonStateAtomic(taskFile, task.doc as Record<string, unknown>, { expectedRev: task.rev });
      writeJsonStateAtomic(listFile, list.doc as Record<string, unknown>, { expectedRev: list.rev });
    },
  };
}

export function registerWorktree(opts: WorktreeRegisterOptions): Envelope {
  const startedAt = Date.now();
  return withRunLock(opts, startedAt, (runDir, runId) => {
    const stores = loadClaims(runDir, runId);
    const found = findActiveClaim(stores, opts.taskId, opts.agentId);
    if (!('claim' in found)) return failEnvelope(found.code, found.message, { startedAt });

    const taskFile = join(runDir, 'tasks', opts.taskId, 'task.json');
    const task = readJsonState(taskFile);
    const status = (task.doc as { status: string }).status;
    // claimed is the normal entry. working is allowed ONLY when no live worktree entry exists —
    // the prune-recovery path (S13): a working task whose tree vanished out-of-band had no way
    // back in (register wanted claimed, adopt only sees abandoned, prune marks pruned).
    const preWt = loadWorktrees(runDir, runId);
    const hasLiveTree = preWt.doc.entries.some((e) => e.task_id === opts.taskId && ['active', 'abandoned'].includes(e.status));
    if (!(status === 'claimed' || (status === 'working' && !hasLiveTree))) {
      return failEnvelope('invalid_transition',
        status === 'working'
          ? `Task ${opts.taskId} is working with a live worktree entry; adopt it or prune first.`
          : `Task ${opts.taskId} is ${status}; worktree register needs claimed (or working after a prune).`,
        { startedAt });
    }

    const branchPattern = new RegExp(`^team/${runId}/${opts.taskId}(-[a-z0-9-]+)?$`);
    if (!branchPattern.test(opts.branch)) {
      return failEnvelope(
        'schema_invalid',
        `Branch "${opts.branch}" does not match team/${runId}/${opts.taskId}-<slug> (docs/16 §3.3).`,
        { startedAt },
      );
    }
    if (!existsSync(opts.path) || !existsSync(join(opts.path, '.git'))) {
      return failEnvelope('io_error', `Path ${opts.path} does not exist or is not a git worktree.`, {
        nextActions: [`Create it first: git worktree add ${opts.path} -b ${opts.branch} <base>`],
        startedAt,
      });
    }
    const run = readJsonState(join(runDir, 'run.json')).doc as { base_branch?: string; worktree_root?: string };
    const repoRoot = dirname(dirname(dirname(runDir)));
    const worktreeRoot = resolve(repoRoot, run.worktree_root ?? `../.team-worktrees/${runId}`);
    try {
      assertRealPathInside(worktreeRoot, opts.path, 'worktree path');
    } catch (err) {
      if (err instanceof GatewayError) return failEnvelope(err.code, err.message, { startedAt });
      throw err;
    }
    const worktreePath = realpathSync(opts.path);
    const baseCommit = (() => {
      try {
        return execFileSync('git', ['-C', opts.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      } catch {
        return 'unknown';
      }
    })();

    const wt = preWt;
    const now = new Date().toISOString();
    const priorTrees = wt.doc.entries.filter((e) => e.task_id === opts.taskId).length;
    const worktreeId = priorTrees === 0 ? `WT-${opts.taskId}` : `WT-${opts.taskId}-${priorTrees + 1}`;
    wt.doc.entries.push({
      worktree_id: worktreeId,
      task_id: opts.taskId,
      path: worktreePath,
      branch: opts.branch,
      base_branch: run.base_branch ?? 'main',
      base_commit: baseCommit,
      status: 'active',
      owner_agent_id: opts.agentId,
      previous_owner_agent_ids: [],
      created_at: now,
    });
    saveState(wt.file, wt.doc, wt.rev);

    // claimed -> working only on the normal entry; the prune-recovery path is already working.
    if (status === 'claimed') {
      const started = startTask(runDir, opts.taskId);
      started.commit();
    }

    appendEvent(runDir, {
      event: 'worktree_created',
      actor: { type: 'agent', id: opts.agentId },
      run_id: runId,
      task_id: opts.taskId,
      payload: { worktree_id: worktreeId, branch: opts.branch, base_commit: baseCommit, ...(status === 'working' ? { reregistered: true } : {}) },
    });
    if (status === 'claimed') {
      appendEvent(runDir, {
        event: 'task_started',
        actor: { type: 'agent', id: opts.agentId },
        run_id: runId,
        task_id: opts.taskId,
        claim_id: found.claim.claim_id,
        payload: {},
      });
    }
    return okEnvelope({
      message: `Worktree ${worktreeId} registered on ${opts.branch}; ${opts.taskId} is working.`,
      data: { worktree_id: worktreeId, task_id: opts.taskId, branch: opts.branch, base_commit: baseCommit },
      nextActions: [
        `Implement only inside the claimed paths; commit with the [${opts.taskId}] prefix.`,
        `Heartbeat at pauses: sigmarun heartbeat ${runId} ${opts.taskId} --agent=${opts.agentId}`,
      ],
      startedAt,
    });
  });
}

export function adoptWorktree(opts: WorktreeAdoptOptions): Envelope {
  const startedAt = Date.now();
  return withRunLock(opts, startedAt, (runDir, runId) => {
    const stores = loadClaims(runDir, runId);
    const found = findActiveClaim(stores, opts.taskId, opts.agentId);
    if (!('claim' in found)) return failEnvelope(found.code, found.message, { startedAt });

    const wt = loadWorktrees(runDir, runId);
    const entry = wt.doc.entries.find((e) => e.task_id === opts.taskId && e.status === 'abandoned');
    if (!entry) {
      return failEnvelope('invalid_transition', `No abandoned worktree to adopt for ${opts.taskId} (docs/16 §3.5).`, {
        nextActions: [`Create a fresh one instead: sigmarun worktree register ${runId} ${opts.taskId} --path=... --branch=...`],
        startedAt,
      });
    }
    const previousOwner = entry.previous_owner_agent_ids[entry.previous_owner_agent_ids.length - 1] ?? null;
    entry.status = 'active';
    entry.owner_agent_id = opts.agentId;
    saveState(wt.file, wt.doc, wt.rev);

    const started = startTask(runDir, opts.taskId);
    started.commit();

    appendEvent(runDir, {
      event: 'worktree_adopted',
      actor: { type: 'agent', id: opts.agentId },
      run_id: runId,
      task_id: opts.taskId,
      payload: { worktree_id: entry.worktree_id, previous_owner: previousOwner },
    });
    appendEvent(runDir, {
      event: 'task_started',
      actor: { type: 'agent', id: opts.agentId },
      run_id: runId,
      task_id: opts.taskId,
      claim_id: found.claim.claim_id,
      payload: { adopted: true },
    });
    return okEnvelope({
      message: `Adopted ${entry.worktree_id} on ${entry.branch}; continue from the previous attempt.`,
      data: { worktree_id: entry.worktree_id, task_id: opts.taskId, branch: entry.branch, path: entry.path, previous_owner: previousOwner },
      nextActions: ['Read previous_attempts in the task brief before continuing.'],
      startedAt,
    });
  });
}

export interface WorktreeListOptions extends ResolveOptions {
  runId: string;
}

/** Read-only worktree inventory (docs/04 primitives; feeds AUD-029 triage). */
export function listWorktrees(opts: WorktreeListOptions): Envelope {
  const startedAt = Date.now();
  const ctx = openRun(opts);
  if (ctx instanceof GatewayError) return failEnvelope(ctx.code, ctx.message, { startedAt });
  const wt = loadWorktrees(ctx.runDir, ctx.runId);
  const entries = wt.doc.entries.map((e) => ({
    worktree_id: e.worktree_id,
    task_id: e.task_id,
    path: e.path,
    branch: e.branch,
    status: e.status,
    owner_agent_id: e.owner_agent_id,
    exists: existsSync(e.path),
  }));
  return okEnvelope({
    message: `${entries.length} worktree entr${entries.length === 1 ? 'y' : 'ies'} on ${ctx.runId} (${entries.filter((e) => e.status === 'active').length} active).`,
    data: { entries },
    startedAt,
  });
}

export interface WorktreePruneOptions extends ResolveOptions {
  runId: string;
  /** report the stale set without mutating (reconcile check). */
  dryRun?: boolean;
}

/**
 * Reconcile the worktree registry against the filesystem (roadmap Phase 1 fault degradation):
 * a worktree deleted out-of-band (git worktree remove, rm -rf, a wiped scratch dir) leaves a live
 * entry pointing at a path that no longer exists. Prune marks those entries `pruned` so `worktree
 * list` and AUD-029 stop counting them as live, and surfaces the tasks whose worktree vanished so
 * the owner can re-register or reclaim. --dry-run reports without touching anything.
 */
export function pruneWorktrees(opts: WorktreePruneOptions): Envelope {
  const startedAt = Date.now();
  return withRunLock(opts, startedAt, (runDir, runId) => {
    const wt = loadWorktrees(runDir, runId);
    const PRUNABLE = new Set(['active', 'abandoned']);
    const live = wt.doc.entries.filter((e) => PRUNABLE.has(e.status));
    const dead = live.filter((e) => !existsSync(e.path));
    const summary = dead.map((e) => ({ worktree_id: e.worktree_id, task_id: e.task_id, path: e.path, was: e.status }));

    if (dead.length === 0) {
      return okEnvelope({
        message: `No stale worktrees on ${runId}; ${live.length} live worktree(s) all present.`,
        data: { pruned: [], live: live.length, dry_run: Boolean(opts.dryRun) },
        startedAt,
      });
    }

    if (opts.dryRun) {
      return okEnvelope({
        message: `${dead.length} stale worktree(s) would be pruned on ${runId} (dry run).`,
        data: { pruned: summary, live: live.length, dry_run: true },
        nextActions: [`Apply: sigmarun worktree prune ${runId}`],
        startedAt,
      });
    }

    for (const e of dead) e.status = 'pruned';
    saveState(wt.file, wt.doc, wt.rev); // detail write precedes the commit-point event
    const tasks = [...new Set(summary.map((s) => s.task_id))];
    appendEvent(runDir, {
      event: 'worktree_pruned',
      actor: { type: 'user', id: 'user' },
      run_id: runId,
      payload: { pruned: summary.map((s) => s.worktree_id), tasks },
    });

    // A task still 'working' whose worktree vanished is stuck — point the operator at recovery.
    const stranded = tasks.filter((taskId) => {
      const f = join(runDir, 'tasks', taskId, 'task.json');
      return existsSync(f) && (readJsonState(f).doc as { status: string }).status === 'working';
    });
    const nextActions = stranded.length
      ? stranded.map((taskId) =>
          `Re-establish ${taskId}: owner registers a fresh worktree (sigmarun worktree register ${runId} ${taskId} --agent=<owner> --path=.. --branch=..), or take it over: sigmarun reclaim ${runId} ${taskId} (--force --agent=user while the lease is live).`)
      : [];

    return okEnvelope({
      message: `Pruned ${dead.length} stale worktree(s) on ${runId}${stranded.length ? ` (${stranded.length} task(s) now need a fresh worktree)` : ''}.`,
      data: { pruned: summary, live: live.length - dead.length, dry_run: false, stranded_tasks: stranded },
      nextActions,
      startedAt,
    });
  });
}
