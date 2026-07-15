import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  GatewayError,
  tryAcquireLock,
  runLockPath,
  readJsonState,
  resolveTeamRoot,
  writeJsonStateAtomic,
  type ResolveOptions,
} from '@sigmarun/storage';
import { failEnvelope, okEnvelope, type Envelope } from './envelope.js';
import { withRunTx } from './tx.js';
import { appendEvent } from './events.js';

export interface RunOpOptions extends ResolveOptions {
  runId: string;
}

const TASK_TERMINAL = new Set(['done', 'cancelled', 'integrated']);

/** Delegates to the ONE transaction skeleton (core/tx.ts withRunTx; remediation E1). */
function withRunTransaction(
  opts: RunOpOptions,
  startedAt: number,
  body: (runDir: string) => Envelope,
): Envelope {
  return withRunTx(opts, startedAt, (runDir) => body(runDir));
}

function flipRun(runDir: string, from: string[], to: string): { ok: true; was: string } | { ok: false; was: string } {
  const runFile = join(runDir, 'run.json');
  const run = readJsonState(runFile);
  const was = (run.doc as { status: string }).status;
  if (!from.includes(was)) return { ok: false, was };
  (run.doc as { status: string }).status = to;
  writeJsonStateAtomic(runFile, run.doc as Record<string, unknown>, { expectedRev: run.rev });
  return { ok: true, was };
}

/** active -> paused: dispatch freezes, in-flight work may still heartbeat/message/submit (docs/15 §2.1). */
export function runPause(opts: RunOpOptions): Envelope {
  const startedAt = Date.now();
  return withRunTransaction(opts, startedAt, (runDir) => {
    const flip = flipRun(runDir, ['active'], 'paused');
    if (!flip.ok) {
      return failEnvelope('invalid_transition', `Run ${opts.runId} is ${flip.was}; pause applies to active runs.`, { startedAt });
    }
    appendEvent(runDir, { event: 'run_paused', actor: { type: 'user', id: 'user' }, run_id: opts.runId, payload: {} });
    return okEnvelope({
      message: `Run ${opts.runId} paused: no new claims; in-flight tasks may still heartbeat and submit.`,
      data: { run_status: 'paused' },
      nextActions: [`Resume later: sigmarun run resume ${opts.runId}`],
      startedAt,
    });
  });
}

export function runResume(opts: RunOpOptions): Envelope {
  const startedAt = Date.now();
  return withRunTransaction(opts, startedAt, (runDir) => {
    const flip = flipRun(runDir, ['paused'], 'active');
    if (!flip.ok) {
      return failEnvelope('invalid_transition', `Run ${opts.runId} is ${flip.was}; resume applies to paused runs.`, { startedAt });
    }
    appendEvent(runDir, { event: 'run_resumed', actor: { type: 'user', id: 'user' }, run_id: opts.runId, payload: {} });
    return okEnvelope({
      message: `Run ${opts.runId} resumed; the claim queue is open again.`,
      data: { run_status: 'active' },
      startedAt,
    });
  });
}

/**
 * integrating -> active (docs/15 §2.2 integration_reopened — spec'd from day one, unbuilt until
 * remediation S7). Mid-integration you discover a missing piece: without this edge the run was a
 * one-way street — task add wanted planned/active, publish wanted active, pause refused — and the
 * only exits were cancelling the whole run or reporting around the hole. Reopen returns the run
 * to active so tasks can be added/published/claimed; integrate start re-enters when ready
 * (already-integrated tasks keep their status, the merge order simply recomputes).
 */
export function runReopen(opts: RunOpOptions): Envelope {
  const startedAt = Date.now();
  return withRunTransaction(opts, startedAt, (runDir) => {
    const flip = flipRun(runDir, ['integrating'], 'active');
    if (!flip.ok) {
      return failEnvelope('invalid_transition', `Run ${opts.runId} is ${flip.was}; reopen applies to integrating runs.`, { startedAt });
    }
    appendEvent(runDir, { event: 'integration_reopened', actor: { type: 'user', id: 'user' }, run_id: opts.runId, payload: {} });
    return okEnvelope({
      message: `Run ${opts.runId} reopened: back to active. Add/publish the missing work, then integrate start again.`,
      data: { run_status: 'active' },
      nextActions: [
        `Add the missing task: sigmarun task add ${opts.runId} --file=<task.json>`,
        `Re-enter integration when ready: sigmarun integrate start ${opts.runId}`,
      ],
      startedAt,
    });
  });
}

/**
 * Cancel a run (docs/15 §2.3): planned/active/paused/integrating only — reported results are frozen
 * and can only be archived (2026-07-10 adjudication). Cascades every live claim and non-terminal task
 * (BDD-007-09); the integration branch, if any, is left for manual handling.
 */
export function runCancel(opts: RunOpOptions): Envelope {
  const startedAt = Date.now();
  return withRunTransaction(opts, startedAt, (runDir) => {
    const flip = flipRun(runDir, ['planned', 'active', 'paused', 'integrating'], 'cancelled');
    if (!flip.ok) {
      const hint = flip.was === 'reported' ? ' Reported results are frozen; archive instead.' : '';
      return failEnvelope('invalid_transition', `Run ${opts.runId} is ${flip.was}; cancel is not allowed.${hint}`, {
        nextActions: flip.was === 'reported' ? [`Archive it: sigmarun run archive ${opts.runId}`] : [],
        startedAt,
      });
    }

    const cascaded: string[] = [];
    // detail -> index -> claims -> events (docs/17 §5.3)
    const listFile = join(runDir, 'team-task-list.json');
    const list = readJsonState(listFile);
    const rows = (list.doc as { tasks: Array<{ task_id: string; status: string; owner_agent_id: string | null; claim_id: string | null }> }).tasks;
    const cancelledTasks: Array<{ task_id: string; released: string[] }> = [];
    for (const row of rows) {
      if (TASK_TERMINAL.has(row.status)) continue;
      const taskFile = join(runDir, 'tasks', row.task_id, 'task.json');
      if (existsSync(taskFile)) {
        const task = readJsonState(taskFile);
        (task.doc as { status: string }).status = 'cancelled';
        writeJsonStateAtomic(taskFile, task.doc as Record<string, unknown>, { expectedRev: task.rev });
      }
      row.status = 'cancelled';
      row.owner_agent_id = null;
      row.claim_id = null;
      cancelledTasks.push({ task_id: row.task_id, released: [] });
    }
    writeJsonStateAtomic(listFile, list.doc as Record<string, unknown>, { expectedRev: list.rev });

    const LIVE = new Set(['active', 'submitted']);
    for (const rel of ['claims/task-claims.json', 'claims/path-claims.json', 'claims/review-claims.json']) {
      const file = join(runDir, rel);
      if (!existsSync(file)) continue;
      const state = readJsonState(file);
      let dirty = false;
      for (const c of ((state.doc as { claims?: Array<{ claim_id: string; task_id: string; status: string }> }).claims ?? [])) {
        if (LIVE.has(c.status)) {
          c.status = 'cancelled';
          cascaded.push(c.claim_id);
          cancelledTasks.find((t) => t.task_id === c.task_id)?.released.push(c.claim_id);
          dirty = true;
        }
      }
      if (dirty) writeJsonStateAtomic(file, state.doc as Record<string, unknown>, { expectedRev: state.rev });
    }

    for (const t of cancelledTasks) {
      appendEvent(runDir, {
        event: 'task_cancelled',
        actor: { type: 'user', id: 'user' },
        run_id: opts.runId,
        task_id: t.task_id,
        payload: { released_claim_ids: t.released, reason: 'run_cancelled' },
      });
    }
    appendEvent(runDir, {
      event: 'run_cancelled',
      actor: { type: 'user', id: 'user' },
      run_id: opts.runId,
      payload: { cascaded_claim_ids: cascaded },
    });
    return okEnvelope({
      message: `Run ${opts.runId} cancelled (was ${flip.was}): ${cancelledTasks.length} task(s) and ${cascaded.length} claim(s) cascaded.${flip.was === 'integrating' ? ' The integration branch is preserved for manual handling.' : ''}`,
      data: { run_status: 'cancelled', cancelled_tasks: cancelledTasks.map((t) => t.task_id), cascaded_claim_ids: cascaded },
      startedAt,
    });
  });
}

/** reported -> archived: the read-only terminal shelf (docs/15 §2.3). */
export function runArchive(opts: RunOpOptions): Envelope {
  const startedAt = Date.now();
  return withRunTransaction(opts, startedAt, (runDir) => {
    const flip = flipRun(runDir, ['reported'], 'archived');
    if (!flip.ok) {
      return failEnvelope('invalid_transition', `Run ${opts.runId} is ${flip.was}; archive applies to reported runs.`, { startedAt });
    }
    appendEvent(runDir, { event: 'run_archived', actor: { type: 'user', id: 'user' }, run_id: opts.runId, payload: {} });
    return okEnvelope({
      message: `Run ${opts.runId} archived (read-only).`,
      data: { run_status: 'archived' },
      nextActions: [`Keep the exported archive under version control: sigmarun export ${opts.runId}`],
      startedAt,
    });
  });
}
