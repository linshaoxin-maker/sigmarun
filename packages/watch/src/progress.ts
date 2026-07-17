import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GatewayError, readJsonState, resolveTeamRoot, type ResolveOptions } from '@sigmarun/storage';
import { EVENT_STATUS, failEnvelope, okEnvelope, readEventsSafe, type Envelope } from '@sigmarun/core';
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
  depends_on?: string[];
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
    lightweight?: boolean;
    default_policy?: {
      claim_ttl_minutes?: number;
      reclaim_policy?: { auto_after_ttl_multiple?: number };
      require_review?: boolean;
      require_verification?: boolean;
    };
  };
  const rows = (readJsonState(join(runDir, 'team-task-list.json')).doc as { tasks: Row[] }).tasks;
  const counts: Record<string, number> = {};
  let weightTotal = 0;
  let weightDone = 0;
  let progressWeighted = 0;
  const safeLedger = readEventsSafe(runDir); // {events, corrupt_lines} — reused for the integrity check below
  const blockedPrev = (taskId: string): number => {
    // docs/03 §9: blocked keeps the last pre-block fraction — replay the ledger backwards for it.
    const events = safeLedger.events;
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
    ? (readJsonState(claimsFile).doc as { claims: Array<{ task_id: string; agent_id: string; status: string; lease_until: string; last_heartbeat_at?: string }> }).claims
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
      // S11: the command must be the one that CLEARS the item — the old read-only `msg list`
      // left "1 item needs you" standing forever and trained users to ignore the panel.
      command: `sigmarun msg post ${run.run_id} --from=user --type=answer --reply-to=${b.message_id} --body="<answer>"`,
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

  // ——— pipeline waits (remediation C1): every waiting state answers "what now". ———
  // The old taxonomy had three kinds; submitted/approved/changes_requested/verified/integrating
  // all read "0 items need you" — the exact silence that dressed S1/S5-class hangs as idle.
  const gateFile = join(runDir, 'claims', 'review-claims.json');
  const gateClaims = existsSync(gateFile)
    ? (readJsonState(gateFile).doc as { claims: Array<{ task_id: string; status: string; kind?: string }> }).claims
    : [];
  const activeGate = (taskId: string, kind: 'review' | 'verify'): boolean =>
    gateClaims.some((c) => c.task_id === taskId && c.status === 'active' && (c.kind ?? 'review') === kind);
  const lightweight = run.lightweight === true;
  if (lightweight) {
    // docs/26 §5: the run does not close itself — hand the closer the terminal command.
    const open = rows.filter((r) => !['done', 'cancelled'].includes(r.status)).length;
    if (run.status === 'active' && rows.length > 0 && open === 0) {
      needsUser.push({ kind: 'ready_to_report', detail: 'Every task is closed.', command: `sigmarun report ${run.run_id}` });
    }
  } else {
    const reviewOn = run.default_policy?.require_review !== false;
    const verifyOn = run.default_policy?.require_verification !== false;
    for (const r of rows) {
      if (r.status === 'submitted' && reviewOn && !activeGate(r.task_id, 'review')) {
        needsUser.push({
          kind: 'awaiting_review',
          task_id: r.task_id,
          detail: `${r.task_id} awaits an independent review.`,
          command: `sigmarun claim-next ${run.run_id} --agent=<other-window> --role=reviewer`,
        });
      }
      if (r.status === 'approved' && verifyOn && !activeGate(r.task_id, 'verify')) {
        needsUser.push({
          kind: 'awaiting_verify',
          task_id: r.task_id,
          detail: `${r.task_id} awaits independent verification.`,
          command: `sigmarun claim-next ${run.run_id} --agent=<other-window> --role=verifier`,
        });
      }
      if (r.status === 'changes_requested') {
        const owner = taskClaims.find((c) => c.task_id === r.task_id && c.status === 'active');
        if (!owner) continue; // no live claim: the stale-lease path already covers the takeover
        const hbAge = now - Date.parse(owner.last_heartbeat_at ?? owner.lease_until);
        if (hbAge > ttlMs) {
          // B4/S4: request-changes hands a dead owner a FULL fresh lease — the heartbeat age is
          // the tell. Point the human at the override instead of at the corpse.
          needsUser.push({
            kind: 'stale_owner',
            task_id: r.task_id,
            detail: `${r.task_id} needs rework but owner ${owner.agent_id} has been silent ${Math.round(hbAge / 60_000)} min (lease still live).`,
            command: `sigmarun reclaim ${run.run_id} ${r.task_id} --force --agent=user`,
          });
        } else {
          needsUser.push({
            kind: 'awaiting_rework',
            task_id: r.task_id,
            detail: `${r.task_id} has review findings to address.`,
            command: `sigmarun resume ${run.run_id} ${r.task_id} --agent=${owner.agent_id}`,
          });
        }
      }
      // B6/S6: a ready task depending on a CANCELLED upstream waits forever — no status value
      // ever satisfies the gate. Surface the rebuild path instead of silence.
      if (r.status === 'ready') {
        const deps = (r as { depends_on?: string[] }).depends_on ?? [];
        const dead = deps.filter((d) => rows.some((x) => x.task_id === d && x.status === 'cancelled'));
        if (dead.length > 0) {
          needsUser.push({
            kind: 'deps_dead',
            task_id: r.task_id,
            detail: `${r.task_id} depends on cancelled ${dead.join(', ')} and can never unblock.`,
            command: `sigmarun task cancel ${run.run_id} ${r.task_id} --reason="upstream cancelled" (then task add a replacement without the dead dependency)`,
          });
        }
      }
    }
    const integrableSet = run.default_policy?.require_verification === false ? ['verified', 'approved'] : ['verified'];
    const integrable = rows.filter((r) => integrableSet.includes(r.status)).length;
    const inFlight = rows.filter((r) => !['done', 'cancelled', 'integrated', ...integrableSet].includes(r.status)).length;
    if (run.status === 'active' && integrable > 0 && inFlight === 0) {
      needsUser.push({
        kind: 'ready_to_integrate',
        detail: `${integrable} task(s) passed the gates and nothing else is in flight.`,
        command: `sigmarun integrate start ${run.run_id}`,
      });
    }
    if (run.status === 'integrating' && integrable === 0) {
      needsUser.push({ kind: 'ready_to_report', detail: 'The integration queue is empty.', command: `sigmarun report ${run.run_id}` });
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

  // C2: "who is doing what" — the first question of any multi-window session had no data plane.
  const agentsDir = join(runDir, 'agents');
  const agentFiles = existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith('.json')) : [];
  let agentsStale = 0;
  let agentsWithWork = 0;
  for (const f of agentFiles) {
    const a = readJsonState(join(agentsDir, f)).doc as { agent_id: string; last_heartbeat_at?: string; registered_at?: string };
    const hb = Date.parse(a.last_heartbeat_at ?? a.registered_at ?? '') || 0;
    if (now - hb > ttlMs) agentsStale += 1;
    if (taskClaims.some((c) => c.agent_id === a.agent_id && c.status === 'active')) agentsWithWork += 1;
  }

  // Ledger integrity → human handoff. Torn lines or duplicate seq are damage the gateway CANNOT
  // self-heal: `repair` rolls next_seq forward but can neither reconstruct a torn tail nor de-dup a
  // seq collision (corner cases #3/#4). Previously this only surfaced if a human ran `audit`; make
  // it an explicit needs_user so a damaged ledger reaches a person instead of silently degrading.
  const dupSeq = safeLedger.events.length !== new Set(safeLedger.events.map((e) => e.seq)).size;
  if (safeLedger.corrupt_lines.length > 0 || dupSeq) {
    const parts = [
      safeLedger.corrupt_lines.length > 0 ? `${safeLedger.corrupt_lines.length} unreadable line(s)` : '',
      dupSeq ? 'duplicate seq numbers' : '',
    ].filter(Boolean).join(' + ');
    needsUser.unshift({
      kind: 'ledger_broken',
      detail: `events.jsonl is damaged (${parts}) — the audit ledger can't self-heal; restore .team from a backup or truncate the torn tail, then repair.`,
      command: `sigmarun audit run ${run.run_id}`,
    });
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
    agents: { total: agentFiles.length, with_claims: agentsWithWork, stale: agentsStale },
  };
}

/**
 * The EXTERNAL state machine — the requirement (run) as the USER sees it. The internal machine
 * (core/state-machine.ts) tracks fine-grained task/claim states for correctness; this fold maps
 * that plus the needs_user channel onto ONE user-facing state with ONE suggested next step, so
 * every surface (run list, status, /team-runs) can proactively guide instead of dumping raw
 * states. This is the single place the internal→external map lives.
 * Priority: closed > paused > awaiting_publish > needs_you/gates/finish (needs_user order) >
 * in_progress > ready_to_work.
 */
export function deriveUserState(
  runStatus: string,
  runId: string,
  snapshot: {
    counts?: Record<string, number>;
    needs_user?: Array<{ kind: string; detail: string; command: string }>;
    agents?: { with_claims?: number };
  } | null,
): { state: string; detail: string; command: string | null } {
  if (runStatus === 'reported' || runStatus === 'archived') {
    return { state: 'closed', detail: 'requirement closed — hand the changes back to git (commit / open the PR), then plan the next one', command: null };
  }
  if (runStatus === 'cancelled') {
    return { state: 'closed', detail: 'requirement cancelled — plan the next one', command: null };
  }
  if (runStatus === 'paused') {
    return { state: 'paused', detail: 'on hold — nothing new can be claimed until resumed', command: `sigmarun run resume ${runId}` };
  }
  const counts = snapshot?.counts ?? {};
  if (runStatus === 'planned' || (counts.draft ?? 0) > 0) {
    return { state: 'awaiting_publish', detail: `${counts.draft ?? 0} draft task(s) not claimable yet`, command: `sigmarun task publish ${runId}` };
  }
  const needs = snapshot?.needs_user ?? [];
  const first = needs[0];
  if (first) {
    const state =
      first.kind === 'awaiting_review' || first.kind === 'awaiting_verify' ? 'awaiting_gates'
      : first.kind === 'ready_to_integrate' || first.kind === 'ready_to_report' ? first.kind
      : 'needs_you';
    return { state, detail: first.detail, command: first.command };
  }
  const working = snapshot?.agents?.with_claims ?? 0;
  if (working > 0) {
    return { state: 'in_progress', detail: `${working} window(s) working; ${counts.ready ?? 0} piece(s) still claimable`, command: null };
  }
  if ((counts.ready ?? 0) > 0) {
    return { state: 'ready_to_work', detail: `${counts.ready} piece(s) claimable — grab one`, command: null };
  }
  return { state: 'in_progress', detail: 'work is moving through the pipeline', command: null };
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
    const userState = deriveUserState(
      snapshot.run_status as string,
      opts.runId,
      snapshot as Parameters<typeof deriveUserState>[2],
    );
    return okEnvelope({
      message: `${opts.runId} ${snapshot.run_status as string}: ${snapshot.progress_pct as number}% by weight; ${(snapshot.risks as unknown[]).length} risk(s), ${needs.length} item(s) need you.`,
      data: { ...snapshot, user_state: userState },
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
        // lightweight + progress let front ends (/team-do run selection) pick the right run —
        // 'mode' stays the payload work mode (feature/bugfix/...), not the run mode kind.
        const snap = (() => {
          try { return computeProgress(join(runsDir, entry)); } catch { return null; }
        })();
        runs.push({
          run_id: run.run_id, status: run.status, title: run.title, mode: run.mode,
          lightweight: run.lightweight === true,
          progress_pct: (snap?.progress_pct as number | undefined) ?? null,
          // the requirement's user-facing state — /team-runs leads each row with it
          user_state: deriveUserState(run.status as string, run.run_id as string, snap as Parameters<typeof deriveUserState>[2]),
        });
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

export interface AgentListOptions extends ResolveOptions {
  runId: string;
}

/**
 * Who is doing what (remediation C2; the docs/04 §6 "Agents: N active | M stale" view, unbuilt
 * until now). Joins agents/*.json with live task claims and gate leases; staleness is heartbeat
 * age past 1x TTL — the same signal the sweep and stale_owner detection use.
 */
export function agentList(opts: AgentListOptions): Envelope {
  const startedAt = Date.now();
  const ctx = openRun(opts);
  if (ctx instanceof GatewayError) return failEnvelope(ctx.code, ctx.message, { startedAt });
  const { runDir, runId } = ctx;
  const run = readJsonState(join(runDir, 'run.json')).doc as { default_policy?: { claim_ttl_minutes?: number } };
  const ttlMs = (run.default_policy?.claim_ttl_minutes ?? 30) * 60_000;
  const now = Date.now();
  const claimsFile = join(runDir, 'claims', 'task-claims.json');
  const taskClaims = existsSync(claimsFile)
    ? (readJsonState(claimsFile).doc as { claims: Array<{ task_id: string; agent_id: string; status: string }> }).claims
    : [];
  const gateFile = join(runDir, 'claims', 'review-claims.json');
  const gateClaims = existsSync(gateFile)
    ? (readJsonState(gateFile).doc as { claims: Array<{ task_id: string; reviewer_agent_id: string; status: string; kind?: string }> }).claims
    : [];
  const agentsDir = join(runDir, 'agents');
  const agents = (existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith('.json')) : [])
    .map((f) => {
      const a = readJsonState(join(agentsDir, f)).doc as {
        agent_id: string; label?: string | null; tool?: string; role?: string;
        last_heartbeat_at?: string; registered_at?: string;
      };
      const work = taskClaims.filter((c) => c.agent_id === a.agent_id && c.status === 'active');
      const gates = gateClaims.filter((c) => c.reviewer_agent_id === a.agent_id && c.status === 'active');
      const hb = Date.parse(a.last_heartbeat_at ?? a.registered_at ?? '') || 0;
      const hbMin = Math.round((now - hb) / 60_000);
      return {
        agent_id: a.agent_id,
        label: a.label ?? null,
        tool: a.tool ?? 'unknown',
        role: a.role ?? 'implementer',
        current_task: work[0]?.task_id ?? gates[0]?.task_id ?? null,
        gate_kind: gates[0] ? (gates[0].kind ?? 'review') : null,
        active_claims: work.length + gates.length,
        last_heartbeat_min: hbMin,
        stale: now - hb > ttlMs,
      };
    })
    .sort((a, b) => a.agent_id.localeCompare(b.agent_id));
  const staleCount = agents.filter((a) => a.stale).length;
  const busy = agents.filter((a) => a.active_claims > 0).length;
  return okEnvelope({
    message: `${agents.length} agent(s) on ${runId}: ${busy} holding work, ${staleCount} stale.`,
    data: { agents },
    startedAt,
  });
}

export interface TaskListOptions extends ResolveOptions {
  runId: string;
  status?: string;
  owner?: string;
  type?: string;
}

/** Filterable task index (docs/17 §1 `team task list`, promised MVP — implemented in R4). */
export function taskList(opts: TaskListOptions): Envelope {
  const startedAt = Date.now();
  const ctx = openRun(opts);
  if (ctx instanceof GatewayError) return failEnvelope(ctx.code, ctx.message, { startedAt });
  const rows = (readJsonState(join(ctx.runDir, 'team-task-list.json')).doc as { tasks: Array<Row & { type?: string }> }).tasks;
  const tasks = rows
    .filter((r) => !opts.status || r.status === opts.status)
    .filter((r) => !opts.owner || r.owner_agent_id === opts.owner)
    .filter((r) => !opts.type || (r as { type?: string }).type === opts.type)
    .map((r) => ({
      task_id: r.task_id,
      title: r.title,
      type: (r as { type?: string }).type,
      status: r.status,
      owner_agent_id: r.owner_agent_id,
      depends_on: r.depends_on ?? [],
    }));
  const filters = [opts.status && `status=${opts.status}`, opts.owner && `owner=${opts.owner}`, opts.type && `type=${opts.type}`]
    .filter(Boolean)
    .join(', ');
  return okEnvelope({
    message: `${tasks.length} task(s) on ${ctx.runId}${filters ? ` (${filters})` : ''}.`,
    data: { tasks },
    startedAt,
  });
}
