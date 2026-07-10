import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonState, writeJsonStateAtomic, type ResolveOptions } from '@sigmarun/storage';
import { appendEvent, failEnvelope, okEnvelope, type Envelope } from '@sigmarun/core';
import { findActiveClaim, loadClaims, readOrDefault, saveState, withRunLock, type TaskRow } from './claim-engine.js';

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
    if (status !== 'claimed') {
      return failEnvelope('invalid_transition', `Task ${opts.taskId} is ${status}; worktree register needs claimed.`, { startedAt });
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
    const baseCommit = (() => {
      try {
        return execFileSync('git', ['-C', opts.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      } catch {
        return 'unknown';
      }
    })();
    const run = readJsonState(join(runDir, 'run.json')).doc as { base_branch?: string };

    const wt = loadWorktrees(runDir, runId);
    const now = new Date().toISOString();
    const worktreeId = `WT-${opts.taskId}`;
    wt.doc.entries.push({
      worktree_id: worktreeId,
      task_id: opts.taskId,
      path: opts.path,
      branch: opts.branch,
      base_branch: run.base_branch ?? 'main',
      base_commit: baseCommit,
      status: 'active',
      owner_agent_id: opts.agentId,
      previous_owner_agent_ids: [],
      created_at: now,
    });
    saveState(wt.file, wt.doc, wt.rev);

    const started = startTask(runDir, opts.taskId);
    started.commit();

    appendEvent(runDir, {
      event: 'worktree_created',
      actor: { type: 'agent', id: opts.agentId },
      run_id: runId,
      task_id: opts.taskId,
      payload: { worktree_id: worktreeId, branch: opts.branch, base_commit: baseCommit },
    });
    appendEvent(runDir, {
      event: 'task_started',
      actor: { type: 'agent', id: opts.agentId },
      run_id: runId,
      task_id: opts.taskId,
      claim_id: found.claim.claim_id,
      payload: {},
    });
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

