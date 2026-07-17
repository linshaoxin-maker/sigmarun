import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GatewayError,
  tryAcquireLock,
  runLockPath,
  readJsonState,
  resolveTeamRoot,
  writeJsonStateAtomic,
  writeBackup,
  type ResolveOptions,
} from '@sigmarun/storage';
import { acquireRunWriteLock, appendEvent, failEnvelope, okEnvelope, readEventsSafe, type Envelope } from '@sigmarun/core';
import { foldLedger } from './replay.js';

export interface RepairOptions extends ResolveOptions {
  runId: string;
}

interface RepairAction {
  target: string;
  field: string;
  from: unknown;
  to: unknown;
}


/**
 * Mechanical crash-residue repair (docs/17 §5.3): meta counter forward-roll, task/list status
 * reconciliation against the event ledger. Backup before writes; state_repaired per action; idempotent.
 */
export function repairRun(opts: RepairOptions): Envelope {
  const startedAt = Date.now();
  let teamRoot: string;
  try {
    teamRoot = resolveTeamRoot(opts).teamRoot;
  } catch (err) {
    const ge = err as GatewayError;
    return failEnvelope(ge.code, ge.message, { startedAt });
  }
  const runDir = join(teamRoot, 'runs', opts.runId);
  if (!existsSync(join(runDir, 'run.json'))) {
    return failEnvelope('run_not_found', `Run ${opts.runId} does not exist under .team/runs/.`, { startedAt });
  }

  const release = acquireRunWriteLock(runDir);
  if (release instanceof GatewayError) return failEnvelope(release.code, release.message, { startedAt });

  try {
    const safe = readEventsSafe(runDir);
    const events = safe.events;

    // ----- plan (dry) -----
    const plan: RepairAction[] = [];
    const findings: string[] = [];
    for (const line of safe.corrupt_lines) {
      findings.push(`events.jsonl line ${line} is unparseable (torn write?) — repair skipped it; restore or truncate manually.`);
    }

    const metaFile = join(runDir, 'events.meta.json');
    const maxSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;
    const meta = existsSync(metaFile) ? (JSON.parse(readFileSync(metaFile, 'utf8')) as { next_seq: number }) : { next_seq: 1 };
    if (events.length > 0 && meta.next_seq !== maxSeq + 1) {
      plan.push({ target: 'events.meta.json', field: 'next_seq', from: meta.next_seq, to: maxSeq + 1 });
    }

    const ledger = foldLedger(events);

    const listFile = join(runDir, 'team-task-list.json');
    const list = readJsonState(listFile);
    const rows = (list.doc as { tasks: Array<{ task_id: string; status: string; owner_agent_id: string | null; claim_id: string | null }> }).tasks;
    let listDirty = false;
    const taskFixes: Array<{ file: string; to: string }> = [];
    for (const [taskId, expect] of ledger) {
      const row = rows.find((r) => r.task_id === taskId);
      if (row && row.status !== expect.status) {
        plan.push({ target: 'team-task-list.json', field: `${taskId}.status`, from: row.status, to: expect.status });
        row.status = expect.status;
        row.owner_agent_id = expect.owner;
        row.claim_id = expect.claim;
        listDirty = true;
      }
      const taskFile = join(runDir, 'tasks', taskId, 'task.json');
      if (existsSync(taskFile)) {
        const detail = readJsonState(taskFile).doc as { status: string };
        if (detail.status !== expect.status) {
          plan.push({ target: `tasks/${taskId}/task.json`, field: 'status', from: detail.status, to: expect.status });
          taskFixes.push({ file: taskFile, to: expect.status });
        }
      } else {
        findings.push(`tasks/${taskId}/ directory missing but the ledger knows the task — manual restore needed.`);
      }
    }

    if (plan.length === 0) {
      return okEnvelope({
        message: `Nothing to repair on ${opts.runId}${findings.length > 0 ? ` (${findings.length} manual finding(s))` : ''}.`,
        data: { repaired: [], findings },
        startedAt,
      });
    }

    // ----- backup, then apply ----- (unified backup store so `restore` works across producers)
    // events.meta.json is DELIBERATELY not backed up. Repair appends state_repaired events to
    // events.jsonl AFTER this snapshot, and events.jsonl is not in the backup set. If meta were
    // snapshotted too, a later `restore` would roll next_seq back below those appended events' seq,
    // and the next append would reuse a live seq → duplicate seq / AUD-033 (this was the bug).
    // Leaving meta out keeps it consistent with on-disk events.jsonl after a restore — the same
    // discipline migrate already follows.
    const backupTargets = [
      ...['team-task-list.json', 'progress.json'].map((rel) => join(runDir, rel)),
      ...taskFixes.map((fix) => fix.file),
    ];
    const backupId = writeBackup(teamRoot, 'repair', backupTargets);

    // meta first — appendEvent must allocate fresh seq numbers after a counter roll-forward.
    if (plan.some((p) => p.target === 'events.meta.json')) {
      writeFileSync(metaFile, JSON.stringify({ next_seq: maxSeq + 1 }), 'utf8');
    }
    for (const fix of taskFixes) {
      const detail = readJsonState(fix.file);
      (detail.doc as { status: string }).status = fix.to;
      writeJsonStateAtomic(fix.file, detail.doc as Record<string, unknown>, { expectedRev: detail.rev });
    }
    if (listDirty) {
      writeJsonStateAtomic(listFile, list.doc as Record<string, unknown>, { expectedRev: list.rev });
    }
    for (const action of plan) {
      appendEvent(runDir, {
        event: 'state_repaired',
        actor: { type: 'user', id: 'repair' },
        run_id: opts.runId,
        payload: { target: action.target, field: action.field, from: action.from, to: action.to },
      });
    }

    return okEnvelope({
      message: `Repaired ${plan.length} residue item(s) on ${opts.runId}; backup ${backupId} (restore with: sigmarun restore ${backupId}).`,
      data: { repaired: plan, findings, backup: backupId },
      startedAt,
    });
  } catch (err) {
    if (err instanceof GatewayError) return failEnvelope(err.code, err.message, { startedAt });
    throw err;
  } finally {
    release();
  }
}
