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
    const corruptTaskFiles: string[] = [];
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
      if (!existsSync(taskFile)) {
        findings.push(`tasks/${taskId}/ directory missing but the ledger knows the task — manual restore needed.`);
        continue;
      }
      let detail: { status: string };
      try {
        detail = readJsonState(taskFile).doc as { status: string };
      } catch (err) {
        // P0-6: one unparseable task.json must NOT abort the whole repair (readJsonState throws
        // io_error on bad JSON). Report it, back it up, and keep repairing the rest. The ledger says
        // this task should be `${expect.status}`, so a human (or a restore) has a concrete target;
        // we can't rev-check an unreadable file, so we deliberately don't auto-rewrite it.
        if (err instanceof GatewayError && err.code === 'io_error') {
          corruptTaskFiles.push(taskFile);
          findings.push(
            `tasks/${taskId}/task.json is not valid JSON — repair backed it up but left it as-is (the ledger expects status "${expect.status}"): restore it from the backup or fix the JSON by hand, then re-run repair.`,
          );
          continue;
        }
        throw err; // unrelated failures (e.g. unsupported_schema_version) still surface as before
      }
      if (detail.status !== expect.status) {
        plan.push({ target: `tasks/${taskId}/task.json`, field: 'status', from: detail.status, to: expect.status });
        taskFixes.push({ file: taskFile, to: expect.status });
      }
    }

    // ----- claims reconciliation (P1-9): ghost task/path claims a crash left ACTIVE -----------------
    // claim-engine writes claims/*.json BEFORE the task's own commit event (claim-engine.ts finishClaim),
    // and a torn claim-deactivation on release can strand an ACTIVE task-claim on a task the ledger has
    // since moved OFF (ready/draft/terminal). Such a ghost is still counted by the run-wide parallel-slot
    // and per-agent limits (claim-engine.ts:604,690), so it wedges claim-next with parallel_limit_reached /
    // agent_claim_limit until the ~3xTTL sweep. repair never read claims/ before P1-9, so it could not
    // clear what `audit run` already flags (AUD-005/006/009/010). It now reconciles claims against the
    // SAME event ledger it trusts for every other repair.
    //
    // RED LINE: a claim the ledger still names as the holder of an OCCUPIED task is LIVE — never
    // deactivate it. Double-claiming is the single failure mode this whole system exists to prevent, so
    // repair only ever cleans an UNAMBIGUOUS residue; every borderline case is a finding, not a mutation.
    // Statuses in which an ACTIVE owner task-claim is legitimate: claimed/working/blocked, plus
    // changes_requested — request_changes revives the owner's claim in place for rework (review.ts:465).
    const OCCUPANCY = new Set(['claimed', 'working', 'blocked', 'changes_requested']);
    const CLEANABLE = new Set(['ready', 'draft', 'done', 'integrated', 'verified', 'cancelled']); // no live task-claim can exist
    const nowIso = new Date().toISOString();
    const MISSING = '<<missing>>';
    const claimPlan: RepairAction[] = [];
    const ghostTaskIds = new Set<string>();

    // Authoritative status of a task: the event ledger is the commit point (docs/17 §5.3), so it wins;
    // fall back to task.json only when the ledger has NO state-bearing event for the task. Returns null
    // when task.json exists but is unreadable — the caller then leaves the claim untouched (can't verify).
    const authoritativeStatus = (taskId: string): string | null => {
      const exp = ledger.get(taskId);
      if (exp) return exp.status;
      const tf = join(runDir, 'tasks', taskId, 'task.json');
      if (!existsSync(tf)) return MISSING;
      try {
        return String((readJsonState(tf).doc as { status: string }).status);
      } catch {
        return null;
      }
    };

    type ClaimLite = { claim_id: string; task_id: string; agent_id: string; status: string; [k: string]: unknown };
    const readClaimsSafe = (file: string, label: string): { doc: { claims: ClaimLite[] } & Record<string, unknown>; rev: number } | null => {
      if (!existsSync(file)) return null;
      try {
        const s = readJsonState(file);
        return { doc: s.doc as { claims: ClaimLite[] } & Record<string, unknown>, rev: s.rev };
      } catch (err) {
        if (err instanceof GatewayError && err.code === 'io_error') {
          findings.push(`claims/${label} is not valid JSON — repair left the claims ledger untouched; fix the JSON by hand, then re-run repair.`);
          return null;
        }
        throw err;
      }
    };

    const taskClaimsFile = join(runDir, 'claims', 'task-claims.json');
    const pathClaimsFile = join(runDir, 'claims', 'path-claims.json');
    const taskClaimsState = readClaimsSafe(taskClaimsFile, 'task-claims.json');
    const pathClaimsState = readClaimsSafe(pathClaimsFile, 'path-claims.json');
    let taskClaimsDirty = false;
    let pathClaimsDirty = false;

    if (taskClaimsState) {
      for (const c of taskClaimsState.doc.claims) {
        if (c.status !== 'active') continue; // only ACTIVE claims occupy a slot / a quota
        const exp = ledger.get(c.task_id);
        const status = authoritativeStatus(c.task_id);
        if (status === null) {
          findings.push(`claims/task-claims.json: ${c.claim_id} is ACTIVE on ${c.task_id} but its task.json is unreadable — repair could not verify it and left it untouched.`);
          continue;
        }
        // RED LINE: the ledger names this exact claim as the holder of an occupied task -> LIVE. Untouchable.
        if (exp && exp.claim === c.claim_id && OCCUPANCY.has(status)) continue;
        if (OCCUPANCY.has(status)) {
          // The task IS occupied, but the ledger does not name THIS claim as the holder — a rival/second
          // ACTIVE claim. repair must not guess which one is real (that is `reclaim`'s job); report only.
          findings.push(
            `claims/task-claims.json: ${c.claim_id} is ACTIVE on ${c.task_id}, but the ledger shows ${c.task_id} is ${status}${exp?.claim ? ` under ${exp.claim}` : ''} — a rival active claim repair will NOT adjudicate. Resolve the double-claim with: sigmarun reclaim ${opts.runId} ${c.task_id}.`,
          );
          continue;
        }
        if (status === MISSING || CLEANABLE.has(status)) {
          // Unambiguous ghost: no agent can be holding a ready/draft/terminal/missing task.
          claimPlan.push({ target: 'claims/task-claims.json', field: `${c.claim_id}.status`, from: 'active', to: 'reclaimed' });
          c.status = 'reclaimed';
          c.released_at = nowIso;
          c.release_reason = 'ghost_claim_repaired';
          taskClaimsDirty = true;
          ghostTaskIds.add(c.task_id);
          findings.push(
            `claims/task-claims.json: deactivated ghost claim ${c.claim_id} on ${c.task_id} (task is ${status === MISSING ? 'gone' : status}; no agent can be holding it) — it was occupying a parallel slot / ${c.agent_id}'s claim quota until the 3xTTL sweep. Restore from the backup if this was wrong.`,
          );
        } else {
          // submitted / reviewing / approved: a gate state that expects a SUBMITTED (not active) claim.
          // Delicate; repair reports rather than mutates (AUD-007 territory), never guesses.
          findings.push(
            `claims/task-claims.json: ${c.claim_id} is ACTIVE on ${c.task_id} which is ${status} — a gate/review state expects a submitted claim, not an active one; repair left it untouched. Inspect the submit/review transaction.`,
          );
        }
      }
    }

    if (pathClaimsState) {
      for (const c of pathClaimsState.doc.claims) {
        if (c.status !== 'active') continue;
        const status = authoritativeStatus(c.task_id);
        if (status === null) continue; // unreadable task -> leave the path hold alone
        if (OCCUPANCY.has(status)) continue; // a live path hold on an occupied task -> never touch
        // Clean a path hold only when its task-claim was just cleaned as a ghost, or the task is plainly
        // unheld (ready/draft/missing). submitted/reviewing/approved path holds are legitimate (docs/15 §4.2).
        const unheld = ghostTaskIds.has(c.task_id) || status === MISSING || status === 'ready' || status === 'draft';
        if (!unheld) continue;
        claimPlan.push({ target: 'claims/path-claims.json', field: `${c.claim_id}.status`, from: 'active', to: 'reclaimed' });
        c.status = 'reclaimed';
        pathClaimsDirty = true;
        if (!ghostTaskIds.has(c.task_id)) {
          findings.push(
            `claims/path-claims.json: deactivated dangling path claim ${c.claim_id} on ${c.task_id} (task is ${status === MISSING ? 'gone' : status}) — it was reserving overlapping paths against live tasks. Restore from the backup if this was wrong.`,
          );
        }
      }
    }

    plan.push(...claimPlan);

    if (plan.length === 0) {
      // Nothing mechanical to fix, but a corrupt task.json still gets snapshotted so the human has a
      // copy to restore — a recovery exit, not a silent no-op (P0-6).
      const backup = corruptTaskFiles.length > 0 ? writeBackup(teamRoot, 'repair', corruptTaskFiles) : undefined;
      return okEnvelope({
        message: `Nothing to repair on ${opts.runId}${findings.length > 0 ? ` (${findings.length} manual finding(s))` : ''}${backup ? `; backup ${backup} (restore with: sigmarun restore ${backup})` : ''}.`,
        data: { repaired: [], findings, ...(backup ? { backup } : {}) },
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
      ...corruptTaskFiles, // P0-6: snapshot unreadable task.json files too, before we report them
      ...(taskClaimsDirty ? [taskClaimsFile] : []), // P1-9: snapshot the claims ledger before deactivating ghosts
      ...(pathClaimsDirty ? [pathClaimsFile] : []),
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
    // P1-9: persist the reconciled claims ledger. Written AFTER the task/list roll-forward and BEFORE the
    // state_repaired events below, keeping "events.jsonl last = commit point" true (docs/17 §5.3).
    if (taskClaimsDirty && taskClaimsState) {
      writeJsonStateAtomic(taskClaimsFile, taskClaimsState.doc as Record<string, unknown>, { expectedRev: taskClaimsState.rev });
    }
    if (pathClaimsDirty && pathClaimsState) {
      writeJsonStateAtomic(pathClaimsFile, pathClaimsState.doc as Record<string, unknown>, { expectedRev: pathClaimsState.rev });
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
