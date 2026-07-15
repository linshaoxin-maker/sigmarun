import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GatewayError, readJsonState, resolveTeamRoot, type ResolveOptions } from '@sigmarun/storage';
import { failEnvelope, okEnvelope, readEventsSafe, type Envelope } from '@sigmarun/core';
import { EVENT_STATUS } from '@sigmarun/audit';
import { openRun } from '@sigmarun/dispatch';

export interface StatusOptions extends ResolveOptions {
  runId: string;
}

export interface TaskShowOptions extends ResolveOptions {
  runId: string;
  taskId: string;
}

interface Row {
  task_id: string;
  title: string;
  status: string;
  weight: number;
  owner_agent_id: string | null;
  claim_id: string | null;
  paths?: { requires_approval?: string[] };
}

interface Msg {
  message_id: string;
  type: string;
  task_id: string | null;
  in_reply_to?: string;
  body: string;
}

function readMessages(runDir: string): Msg[] {
  const file = join(runDir, 'context', 'messages.jsonl');
  if (!existsSync(file)) return [];
  // Tolerate a torn tail (non-atomic append) — a corrupt last line must not crash status/watch.
  const out: Msg[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Msg);
    } catch {
      // skip
    }
  }
  return out;
}

/** docs/03 §9 — per-status progress fractions; blocked keeps the pre-block value, cancelled leaves the denominator. */
const PROGRESS_BY_STATUS: Record<string, number> = {
  draft: 0,
  ready: 0,
  claimed: 0.05,
  working: 0.35,
  submitted: 0.6,
  reviewing: 0.7,
  changes_requested: 0.45,
  approved: 0.8,
  verified: 0.9,
  integrated: 0.95,
  done: 1,
};

/**
 * Derive the run progress snapshot (docs/03 §9 weights · docs/15 §5.1 blocked exemption · M32 Needs-user).
 * Pure read; the caller decides whether to persist progress.json.
 */
export function computeProgress(runDir: string): Record<string, unknown> {
  const run = readJsonState(join(runDir, 'run.json')).doc as {
    run_id: string;
    status: string;
    default_policy?: { claim_ttl_minutes?: number; reclaim_policy?: { auto_after_ttl_multiple?: number } };
  };
  const rows = (readJsonState(join(runDir, 'team-task-list.json')).doc as { tasks: Row[] }).tasks;
  const counts: Record<string, number> = {};
  let weightTotal = 0;
  let weightDone = 0;
  let progressWeighted = 0;
  let ledger: ReturnType<typeof readEventsSafe>['events'] | null = null;
  const blockedPrev = (taskId: string): number => {
    // docs/03 §9: blocked keeps the last pre-block fraction — replay the ledger backwards for it.
    const events = (ledger ??= readEventsSafe(runDir).events);
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.task_id !== taskId) continue;
      const st = EVENT_STATUS[e.event];
      if (st && st !== 'blocked' && st in PROGRESS_BY_STATUS) return PROGRESS_BY_STATUS[st]!;
    }
    return 0;
  };
  for (const r of rows) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    if (r.status === 'cancelled') continue; // §9: out of the denominator
    const w = r.weight ?? 1;
    weightTotal += w;
    if (r.status === 'done') weightDone += w;
    progressWeighted += (r.status === 'blocked' ? blockedPrev(r.task_id) : (PROGRESS_BY_STATUS[r.status] ?? 0)) * w;
  }

  const ttlMs = (run.default_policy?.claim_ttl_minutes ?? 30) * 60_000;
  const multiple = run.default_policy?.reclaim_policy?.auto_after_ttl_multiple ?? 3;
  const now = Date.now();
  const risks: Array<Record<string, unknown>> = [];
  const needsUser: Array<{ kind: string; task_id?: string; detail: string; command: string }> = [];

  const claimsFile = join(runDir, 'claims', 'task-claims.json');
  const taskClaims = existsSync(claimsFile)
    ? (readJsonState(claimsFile).doc as { claims: Array<{ task_id: string; agent_id: string; status: string; lease_until: string }> }).claims
    : [];
  const detailStatus = (taskId: string): string => {
    const f = join(runDir, 'tasks', taskId, 'task.json');
    return existsSync(f) ? (readJsonState(f).doc as { status: string }).status : 'unknown';
  };
  for (const c of taskClaims.filter((c) => c.status === 'active')) {
    const overdueMs = now - Date.parse(c.lease_until);
    if (overdueMs <= 0) continue;
    if (detailStatus(c.task_id) === 'blocked') continue; // docs/15 §5.1 — task.json is the exemption authority (AUD-003)
    const minutes = Math.round(overdueMs / 60_000);
    risks.push({ kind: 'stale_lease', task_id: c.task_id, agent_id: c.agent_id, minutes_overdue: minutes });
    if (overdueMs > (multiple - 1) * ttlMs) {
      needsUser.push({
        kind: 'reclaim_confirm',
        task_id: c.task_id,
        detail: `Lease on ${c.task_id} is ${minutes} min overdue (past ${multiple}x TTL); confirm the takeover.`,
        command: `sigmarun reclaim ${run.run_id} ${c.task_id}`,
      });
    }
  }

  const messages = readMessages(runDir);
  const answered = new Set(messages.filter((m) => m.type === 'answer' && m.in_reply_to).map((m) => m.in_reply_to as string));
  for (const b of messages.filter((m) => m.type === 'blocker' && !answered.has(m.message_id))) {
    risks.push({ kind: 'unresolved_blocker', task_id: b.task_id, message_id: b.message_id, body: b.body.slice(0, 120) });
    needsUser.push({
      kind: 'blocker',
      task_id: b.task_id ?? undefined,
      detail: `${b.message_id}: ${b.body.slice(0, 120)}`,
      command: `sigmarun msg list ${run.run_id} --type=blocker`,
    });
  }
  const openQuestions = messages.filter((m) => m.type === 'question' && !answered.has(m.message_id)).length;

  const approvalsFile = join(runDir, 'claims', 'path-approvals.json');
  const approvals = existsSync(approvalsFile)
    ? (readJsonState(approvalsFile).doc as { approvals: Array<{ task_id: string; paths: string[]; status: string }> }).approvals
    : [];
  for (const r of rows) {
    const needed = r.paths?.requires_approval ?? [];
    if (needed.length === 0 || ['done', 'cancelled', 'integrated'].includes(r.status)) continue;
    const granted = approvals.filter((a) => a.task_id === r.task_id && a.status === 'granted').flatMap((a) => a.paths);
    const missing = needed.filter((g) => !granted.includes(g));
    if (missing.length > 0) {
      needsUser.push({
        kind: 'approval_pending',
        task_id: r.task_id,
        detail: `${r.task_id} needs approval for: ${missing.join(', ')}`,
        command: `sigmarun approve-paths ${run.run_id} ${r.task_id} --paths=${missing.join(',')}`,
      });
    }
  }

  // BDD-009-05: oversize project memory is a run risk (warn, never blocking).
  const projectFile = join(runDir, '..', '..', 'project.json');
  if (existsSync(projectFile)) {
    const rel = ((readJsonState(projectFile).doc as { project_memory_path?: string }).project_memory_path) ?? 'docs/team/MEMORY.md';
    const memPath = join(runDir, '..', '..', '..', rel);
    if (existsSync(memPath)) {
      const text = readFileSync(memPath, 'utf8');
      const memLines = text.split('\n').length;
      const kb = Buffer.byteLength(text, 'utf8') / 1024;
      if (memLines > 200 || kb > 25) {
        risks.push({ kind: 'memory_oversize', detail: `${rel}: ${memLines} lines / ${kb.toFixed(1)}KB (limits 200/25KB)` });
      }
    }
  }

  return {
    schema_version: 'team.progress.v1',
    run_id: run.run_id,
    run_status: run.status,
    computed_at: new Date().toISOString(),
    counts,
    weight_total: weightTotal,
    weight_done: weightDone,
    progress_pct: weightTotal === 0 ? 0 : Math.round((progressWeighted / weightTotal) * 100),
    risks,
    needs_user: needsUser,
    open_questions: openQuestions,
  };
}

/** Persist the derived snapshot (no rev — progress.json is delete-and-recompute, docs/02 §Derived). */
export function writeProgress(runDir: string, snapshot: Record<string, unknown>): void {
  const target = join(runDir, 'progress.json');
  // pid-unique tmp: two windows running status/watch concurrently must not race on one tmp name
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
  renameSync(tmp, target);
}

export function statusRun(opts: StatusOptions): Envelope {
  const startedAt = Date.now();
  const ctx = openRun(opts);
  if (ctx instanceof GatewayError) return failEnvelope(ctx.code, ctx.message, { startedAt });
  try {
    const snapshot = computeProgress(ctx.runDir);
    writeProgress(ctx.runDir, snapshot);
    const needs = snapshot.needs_user as unknown[];
    return okEnvelope({
      message: `${opts.runId} ${snapshot.run_status as string}: ${snapshot.progress_pct as number}% by weight; ${(snapshot.risks as unknown[]).length} risk(s), ${needs.length} item(s) need you.`,
      data: snapshot,
      nextActions: needs.length > 0 ? [(needs[0] as { command: string }).command] : [],
      startedAt,
    });
  } catch (err) {
    // computeProgress reads several state files; a corrupt one (merge conflict, torn write)
    // throws a GatewayError that must surface as a clean envelope, not escape to the bin net.
    if (err instanceof GatewayError) return failEnvelope(err.code, err.message, { startedAt });
    throw err;
  }
}

export function runList(opts: ResolveOptions): Envelope {
  const startedAt = Date.now();
  try {
    const { teamRoot } = resolveTeamRoot(opts);
    const runsDir = join(teamRoot, 'runs');
    const runs: Array<Record<string, unknown>> = [];
    if (existsSync(runsDir)) {
      for (const entry of readdirSync(runsDir).sort()) {
        const runFile = join(runsDir, entry, 'run.json');
        if (!existsSync(runFile)) continue;
        const run = readJsonState(runFile).doc as Record<string, unknown>;
        runs.push({ run_id: run.run_id, status: run.status, title: run.title, mode: run.mode });
      }
    }
    return okEnvelope({
      message: `${runs.length} run(s) under .team/runs/.`,
      data: { runs },
      startedAt,
    });
  } catch (err) {
    if (err instanceof GatewayError) return failEnvelope(err.code, err.message, { startedAt });
    throw err;
  }
}

export function taskShow(opts: TaskShowOptions): Envelope {
  const startedAt = Date.now();
  const ctx = openRun(opts);
  if (ctx instanceof GatewayError) return failEnvelope(ctx.code, ctx.message, { startedAt });
  const taskFile = join(ctx.runDir, 'tasks', opts.taskId, 'task.json');
  if (!existsSync(taskFile)) {
    return failEnvelope('task_not_found', `Task ${opts.taskId} does not exist on ${opts.runId}.`, { startedAt });
  }
  const task = readJsonState(taskFile).doc as Record<string, unknown>;
  const claimsFile = join(ctx.runDir, 'claims', 'task-claims.json');
  const claims = existsSync(claimsFile)
    ? (readJsonState(claimsFile).doc as { claims: Array<{ task_id: string }> }).claims.filter((c) => c.task_id === opts.taskId)
    : [];
  const evFile = join(ctx.runDir, 'evidence', opts.taskId, 'evidence.json');
  const evidence = existsSync(evFile)
    ? (() => {
        const ev = readJsonState(evFile).doc as { revision: number; required_checks_results: Array<{ status: string }> };
        return { revision: ev.revision, checks_pass_count: ev.required_checks_results.filter((r) => r.status === 'pass').length };
      })()
    : null;
  const wtFile = join(ctx.runDir, 'worktrees.json');
  const worktree = existsSync(wtFile)
    ? ((readJsonState(wtFile).doc as { entries: Array<{ task_id: string }> }).entries.find((e) => e.task_id === opts.taskId) ?? null)
    : null;
  return okEnvelope({
    message: `${opts.taskId} is ${task.status as string} (${claims.length} claim record(s)${evidence ? `, evidence rev ${evidence.revision}` : ''}).`,
    data: { task, claims, evidence, worktree },
    startedAt,
  });
}

export function evidenceShow(opts: TaskShowOptions): Envelope {
  const startedAt = Date.now();
  const ctx = openRun(opts);
  if (ctx instanceof GatewayError) return failEnvelope(ctx.code, ctx.message, { startedAt });
  if (!existsSync(join(ctx.runDir, 'tasks', opts.taskId, 'task.json'))) {
    return failEnvelope('task_not_found', `Task ${opts.taskId} does not exist on ${opts.runId}.`, { startedAt });
  }
  const evDir = join(ctx.runDir, 'evidence', opts.taskId);
  const evFile = join(evDir, 'evidence.json');
  if (!existsSync(evFile)) {
    return okEnvelope({
      message: `${opts.taskId} has no evidence yet.`,
      data: { evidence: null, outputs: [], history: [] },
      startedAt,
    });
  }
  const evidence = readJsonState(evFile).doc as Record<string, unknown>;
  const outputsDir = join(evDir, 'outputs');
  const outputs = existsSync(outputsDir) ? readdirSync(outputsDir).sort().map((f) => `outputs/${f}`) : [];
  const historyDir = join(evDir, 'history');
  const history = existsSync(historyDir) ? readdirSync(historyDir).sort() : [];
  return okEnvelope({
    message: `Evidence rev ${evidence.revision as number} for ${opts.taskId}: ${outputs.length} output file(s), ${history.length} archived revision(s).`,
    data: { evidence, outputs, history },
    startedAt,
  });
}
