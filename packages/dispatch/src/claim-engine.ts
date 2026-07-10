import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GatewayError,
  acquireLock,
  readJsonState,
  resolveTeamRoot,
  writeJsonStateAtomic,
  writeJsonStateNew,
  type ReasonCode,
  type ResolveOptions,
} from '@sigmarun/storage';
import {
  appendEvent,
  failEnvelope,
  okEnvelope,
  pathsOverlapConservative,
  type Envelope,
  type EventActor,
} from '@sigmarun/core';

export interface RegisterOptions extends ResolveOptions {
  runId: string;
  tool: string;
  role?: string;
  label?: string;
  capabilities?: string[];
}

export interface ClaimOptions extends ResolveOptions {
  runId: string;
  agentId: string;
  role?: string;
  taskId?: string;
  dryRun?: boolean;
}

export interface HeartbeatOptions extends ResolveOptions {
  runId: string;
  taskId: string;
  agentId: string;
}

export interface ReleaseOptions extends HeartbeatOptions {
  reason?: string;
}

export interface ReclaimOptions extends ResolveOptions {
  runId: string;
  taskId: string;
}

export interface ApproveOptions extends ResolveOptions {
  runId: string;
  taskId: string;
  paths: string[];
  grantedBy?: string;
}

// ---------- shared run plumbing ----------

interface RunCtx {
  runDir: string;
  runId: string;
}

interface TaskRow {
  task_id: string;
  title: string;
  type: string;
  status: string;
  priority: number;
  weight: number;
  role: string;
  depends_on: string[];
  owner_agent_id: string | null;
  claim_id: string | null;
  paths: { allow?: string[]; avoid?: string[]; requires_approval?: string[] };
}

interface TaskClaim {
  claim_id: string;
  task_id: string;
  agent_id: string;
  status: string;
  acquired_at: string;
  lease_until: string;
  last_heartbeat_at: string;
  released_at: string | null;
  release_reason: string | null;
  attempt: number;
}

interface PathClaim {
  claim_id: string;
  task_id: string;
  agent_id: string;
  status: string;
  paths: { allow?: string[]; avoid?: string[]; requires_approval?: string[] };
  policy: string;
  acquired_at: string;
  lease_until: string;
}

interface RunPolicy {
  claim_ttl_minutes: number;
  max_parallel_tasks: number;
  path_conflict_policy: string;
  max_active_claims_per_agent: number;
  reclaim_policy?: { auto_after_ttl_multiple?: number };
}

function openRun(opts: ResolveOptions & { runId: string }): RunCtx | GatewayError {
  const resolved = (() => {
    try {
      return resolveTeamRoot(opts);
    } catch (err) {
      return err as GatewayError;
    }
  })();
  if (resolved instanceof GatewayError) return resolved;
  const runDir = join(resolved.teamRoot, 'runs', opts.runId);
  if (!existsSync(join(runDir, 'run.json'))) {
    return new GatewayError('run_not_found', `Run ${opts.runId} does not exist under .team/runs/.`);
  }
  return { runDir, runId: opts.runId };
}

/** Read a mutable JSON state file, falling back to a default doc when absent (first write creates it). */
function readOrDefault(file: string, def: Record<string, unknown>): { doc: Record<string, unknown>; rev: number | null } {
  if (!existsSync(file)) return { doc: def, rev: null };
  const { doc, rev } = readJsonState(file);
  return { doc: doc as Record<string, unknown>, rev };
}

function saveState(file: string, doc: Record<string, unknown>, rev: number | null): void {
  if (rev === null) writeJsonStateNew(file, doc);
  else writeJsonStateAtomic(file, doc, { expectedRev: rev });
}

const ACTIVE = (c: { status: string }) => c.status === 'active';

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
}

// ---------- register (D17 label-idempotent) ----------

export function registerAgent(opts: RegisterOptions): Envelope {
  const startedAt = Date.now();
  const ctx = openRun(opts);
  if (ctx instanceof GatewayError) return failEnvelope(ctx.code, ctx.message, { startedAt });
  const { runDir, runId } = ctx;
  const agentsDir = join(runDir, 'agents');
  mkdirSync(agentsDir, { recursive: true });

  const release = (() => {
    try {
      return acquireLock(join(runDir, 'run.lock'));
    } catch (err) {
      return err as GatewayError;
    }
  })();
  if (release instanceof GatewayError) return failEnvelope(release.code, release.message, { startedAt });

  try {
    const now = new Date().toISOString();
    if (opts.label) {
      for (const f of readdirSync(agentsDir).filter((f) => f.endsWith('.json'))) {
        const file = join(agentsDir, f);
        const { doc, rev } = readJsonState(file);
        const agent = doc as Record<string, unknown>;
        if (agent.label === opts.label && agent.tool === opts.tool) {
          agent.last_heartbeat_at = now;
          agent.status = 'active';
          if (opts.role) agent.role = opts.role;
          writeJsonStateAtomic(file, agent, { expectedRev: rev });
          appendEvent(runDir, {
            event: 'agent_registered',
            actor: { type: 'agent', id: agent.agent_id as string },
            run_id: runId,
            payload: { tool: opts.tool, label: opts.label, reused: true },
          });
          return okEnvelope({
            message: `Reused registration ${agent.agent_id} for label "${opts.label}".`,
            data: { agent_id: agent.agent_id, reused: true },
            nextActions: [`Claim work: sigmarun claim-next ${runId} --agent=${agent.agent_id}`],
            startedAt,
          });
        }
      }
    }

    const countersFile = join(runDir, 'counters.json');
    const counters = readJsonState(countersFile);
    const cdoc = counters.doc as Record<string, unknown>;
    const n = Number(cdoc.next_agent ?? 1);
    const agentId = `AGENT-${opts.tool}-${String(n).padStart(3, '0')}`;
    const now2 = new Date().toISOString();
    writeJsonStateNew(join(agentsDir, `${agentId}.json`), {
      schema_version: 'team.agent.v1',
      agent_id: agentId,
      tool: opts.tool,
      role: opts.role ?? 'implementer',
      label: opts.label ?? null,
      status: 'active',
      registered_at: now2,
      last_heartbeat_at: now2,
      capabilities: opts.capabilities ?? [],
      current_task_id: null,
    });
    writeJsonStateAtomic(countersFile, { ...cdoc, next_agent: n + 1 }, { expectedRev: counters.rev });
    appendEvent(runDir, {
      event: 'agent_registered',
      actor: { type: 'agent', id: agentId },
      run_id: runId,
      payload: { tool: opts.tool, capabilities: opts.capabilities ?? [], label: opts.label ?? null },
    });
    return okEnvelope({
      message: `Registered ${agentId}${opts.label ? ` for label "${opts.label}"` : ''}.`,
      data: { agent_id: agentId, reused: false },
      nextActions: [`Claim work: sigmarun claim-next ${runId} --agent=${agentId}`],
      startedAt,
    });
  } catch (err) {
    if (err instanceof GatewayError) return failEnvelope(err.code, err.message, { startedAt });
    throw err;
  } finally {
    release();
  }
}

// ---------- claim-next (BR-001 guards, docs/10) ----------

interface ClaimStores {
  taskClaims: { doc: { claims: TaskClaim[] } & Record<string, unknown>; rev: number | null; file: string };
  pathClaims: { doc: { claims: PathClaim[] } & Record<string, unknown>; rev: number | null; file: string };
}

function loadClaims(runDir: string, runId: string): ClaimStores {
  const claimsDir = join(runDir, 'claims');
  mkdirSync(claimsDir, { recursive: true });
  const tf = join(claimsDir, 'task-claims.json');
  const pf = join(claimsDir, 'path-claims.json');
  const t = readOrDefault(tf, { schema_version: 'team.task_claims.v1', run_id: runId, claims: [] });
  const p = readOrDefault(pf, { schema_version: 'team.path_claims.v1', run_id: runId, claims: [] });
  return {
    taskClaims: { doc: t.doc as ClaimStores['taskClaims']['doc'], rev: t.rev, file: tf },
    pathClaims: { doc: p.doc as ClaimStores['pathClaims']['doc'], rev: p.rev, file: pf },
  };
}

interface SweepResult {
  reclaimed: Array<{ task_id: string; claim_id: string; agent_id: string }>;
}

/** Lazy 3xTTL sweep (D9/BR-004): runs inside the claim transaction; blocked tasks are exempt (AUD-003). */
function sweepExpired(
  runDir: string,
  runId: string,
  stores: ClaimStores,
  taskRows: TaskRow[],
  policy: RunPolicy,
  triggeredBy: string,
): SweepResult {
  const ttlMs = policy.claim_ttl_minutes * 60_000;
  const multiple = policy.reclaim_policy?.auto_after_ttl_multiple ?? 3;
  const now = Date.now();
  const result: SweepResult = { reclaimed: [] };
  for (const claim of stores.taskClaims.doc.claims.filter(ACTIVE)) {
    const deadline = Date.parse(claim.lease_until) + (multiple - 1) * ttlMs;
    if (now <= deadline) continue;
    const row = taskRows.find((r) => r.task_id === claim.task_id);
    const taskFile = join(runDir, 'tasks', claim.task_id, 'task.json');
    const task = readJsonState(taskFile);
    if ((task.doc as { status: string }).status === 'blocked') continue;
    applyReclaim(runDir, runId, stores, row, claim, task, {
      reason: 'stale_lease_auto',
      actor: { type: 'sweep', id: 'sweep' },
      triggeredBy,
    });
    result.reclaimed.push({ task_id: claim.task_id, claim_id: claim.claim_id, agent_id: claim.agent_id });
  }
  return result;
}

/** Shared release/reclaim state flip: claim terminal status + task back to ready + previous_attempts. */
function applyReclaim(
  runDir: string,
  runId: string,
  stores: ClaimStores,
  row: TaskRow | undefined,
  claim: TaskClaim,
  task: { doc: unknown; rev: number },
  how: { reason: string; actor: EventActor; triggeredBy?: string; terminal?: string },
): void {
  const now = new Date().toISOString();
  const terminal = how.terminal ?? 'reclaimed';
  claim.status = terminal;
  claim.released_at = now;
  claim.release_reason = how.reason;
  const releasedPathIds: string[] = [];
  for (const pc of stores.pathClaims.doc.claims.filter((c) => c.task_id === claim.task_id && ACTIVE(c))) {
    pc.status = terminal;
    releasedPathIds.push(pc.claim_id);
  }
  const tdoc = task.doc as Record<string, unknown>;
  tdoc.status = 'ready';
  const attempts = (tdoc.previous_attempts as Array<Record<string, unknown>> | undefined) ?? [];
  attempts.push({
    attempt: claim.attempt,
    agent_id: claim.agent_id,
    claim_id: claim.claim_id,
    last_heartbeat_at: claim.last_heartbeat_at,
    ended_at: now,
    reclaim_reason: how.reason,
  });
  tdoc.previous_attempts = attempts;
  writeJsonStateAtomic(join(runDir, 'tasks', claim.task_id, 'task.json'), tdoc, { expectedRev: task.rev });
  if (row) {
    row.status = 'ready';
    row.owner_agent_id = null;
    row.claim_id = null;
  }
  const eventName = terminal === 'released' ? 'task_released' : 'task_reclaimed';
  appendEvent(runDir, {
    event: eventName,
    actor: how.actor,
    run_id: runId,
    task_id: claim.task_id,
    claim_id: claim.claim_id,
    payload:
      terminal === 'released'
        ? { attempt: claim.attempt, released_claim_ids: [claim.claim_id, ...releasedPathIds], reason: how.reason }
        : { reclaim_reason: how.reason, triggered_by: how.triggeredBy ?? null },
  });
}

/** Dependency depth for ordering: longest depends_on ancestor chain (docs/10 §7). */
function depthOf(taskId: string, rows: Map<string, TaskRow>, memo = new Map<string, number>()): number {
  if (memo.has(taskId)) return memo.get(taskId)!;
  const row = rows.get(taskId);
  const deps = row?.depends_on ?? [];
  const d = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => depthOf(dep, rows, memo)));
  memo.set(taskId, d);
  return d;
}

type GuardFailure = { code: ReasonCode; message: string; data?: Record<string, unknown> };

/** Per-candidate BR-001 guards #5..#8; returns null when claimable. */
function candidateGuard(
  row: TaskRow,
  rowsById: Map<string, TaskRow>,
  role: string,
  stores: ClaimStores,
  approvals: Array<{ task_id: string; paths: string[]; status: string }>,
): GuardFailure | null {
  const unmet = row.depends_on.filter((dep) => rowsById.get(dep)?.status !== 'done');
  if (unmet.length > 0) {
    return { code: 'deps_blocked', message: `Task ${row.task_id} waits on ${unmet.join(', ')}.`, data: { unmet } };
  }
  if (row.role !== role) {
    return {
      code: 'capability_mismatch',
      message: `Task ${row.task_id} wants role "${row.role}" but the claim asked for "${role}".`,
    };
  }
  const held = stores.taskClaims.doc.claims.find((c) => c.task_id === row.task_id && ACTIVE(c));
  if (held) {
    return {
      code: 'task_already_claimed',
      message: `Task ${row.task_id} is already held by ${held.agent_id} (${held.claim_id}).`,
      data: { holder: { agent_id: held.agent_id, claim_id: held.claim_id } },
    };
  }
  const allow = row.paths.allow ?? [];
  const blockedBy = stores.pathClaims.doc.claims.filter(
    (pc) =>
      ACTIVE(pc) &&
      pc.task_id !== row.task_id &&
      (pc.paths.allow ?? []).some((b) => allow.some((a) => pathsOverlapConservative(a, b))),
  );
  if (blockedBy.length > 0) {
    return {
      code: 'path_conflict',
      message: `Task ${row.task_id} paths overlap active claims of ${blockedBy.map((b) => b.task_id).join(', ')}.`,
      data: {
        blocked_by: blockedBy.map((b) => ({
          task_id: b.task_id,
          agent_id: b.agent_id,
          claim_id: b.claim_id,
          paths: b.paths.allow ?? [],
        })),
      },
    };
  }
  const needsApproval = row.paths.requires_approval ?? [];
  const granted = approvals.filter((a) => a.task_id === row.task_id && a.status === 'granted').flatMap((a) => a.paths);
  const missing = needsApproval.filter((g) => !granted.includes(g));
  if (missing.length > 0) {
    return {
      code: 'requires_approval',
      message: `Task ${row.task_id} touches approval-gated paths: ${missing.join(', ')}.`,
      data: { requires_approval: missing },
    };
  }
  return null;
}

export function claimNext(opts: ClaimOptions): Envelope {
  const startedAt = Date.now();
  const ctx = openRun(opts);
  if (ctx instanceof GatewayError) return failEnvelope(ctx.code, ctx.message, { startedAt });
  const { runDir, runId } = ctx;

  const release = (() => {
    try {
      return acquireLock(join(runDir, 'run.lock'));
    } catch (err) {
      return err as GatewayError;
    }
  })();
  if (release instanceof GatewayError) return failEnvelope(release.code, release.message, { startedAt });

  try {
    // Guard #1: run state.
    const run = readJsonState(join(runDir, 'run.json'));
    const rdoc = run.doc as { status: string; policy?: Partial<RunPolicy> };
    if (rdoc.status === 'paused') {
      return failEnvelope('run_paused', `Run ${runId} is paused.`, { startedAt });
    }
    const integrating = rdoc.status === 'integrating';
    if (rdoc.status !== 'active' && !integrating) {
      return failEnvelope('run_not_active', `Run ${runId} is ${rdoc.status}; tasks must be published first.`, {
        nextActions: [`Publish tasks: sigmarun task publish ${runId}`],
        startedAt,
      });
    }
    const policy: RunPolicy = {
      claim_ttl_minutes: 30,
      max_parallel_tasks: 4,
      path_conflict_policy: 'block',
      max_active_claims_per_agent: 1,
      reclaim_policy: { auto_after_ttl_multiple: 3 },
      ...(rdoc.policy ?? {}),
    };

    // Guard #2: agent registered and active.
    const agentFile = join(runDir, 'agents', `${opts.agentId}.json`);
    if (!existsSync(agentFile)) {
      return failEnvelope('agent_not_registered', `Agent ${opts.agentId} is not registered on ${runId}.`, {
        nextActions: [`Register first: sigmarun agent register ${runId} --tool=<tool> --label=<window>`],
        startedAt,
      });
    }
    const agentState = readJsonState(agentFile);
    const agent = agentState.doc as Record<string, unknown>;

    const listFile = join(runDir, 'team-task-list.json');
    const list = readJsonState(listFile);
    const rows = (list.doc as { tasks: TaskRow[] }).tasks;
    const rowsById = new Map(rows.map((r) => [r.task_id, r]));
    const stores = loadClaims(runDir, runId);

    // Lazy sweep before limits so a dead claim does not wedge the queue (D9).
    const swept = sweepExpired(runDir, runId, stores, rows, policy, opts.agentId);

    // Guard #3: per-agent cap (M36/D17).
    const mine = stores.taskClaims.doc.claims.filter((c) => c.agent_id === opts.agentId && ACTIVE(c));
    if (mine.length >= policy.max_active_claims_per_agent) {
      return failEnvelope(
        'agent_claim_limit',
        `Agent ${opts.agentId} already holds ${mine.length} active claim(s) (limit ${policy.max_active_claims_per_agent}).`,
        { data: { held: mine.map((c) => c.task_id) }, nextActions: ['Submit or release the current task first.'], startedAt },
      );
    }

    const approvalsFile = join(runDir, 'claims', 'path-approvals.json');
    const approvals = existsSync(approvalsFile)
      ? ((readJsonState(approvalsFile).doc as { approvals: Array<{ task_id: string; paths: string[]; status: string }> })
          .approvals ?? [])
      : [];

    const role = opts.role ?? (agent.role as string) ?? 'implementer';

    // Guard #4: candidates. Directed claims answer with the specific guard code (D17).
    if (opts.taskId) {
      const row = rowsById.get(opts.taskId);
      if (!row) {
        return failEnvelope('task_not_found', `Task ${opts.taskId} does not exist on ${runId}.`, { startedAt });
      }
      if (row.status !== 'ready') {
        const held = stores.taskClaims.doc.claims.find((c) => c.task_id === row.task_id && ACTIVE(c));
        if (held) {
          return failEnvelope(
            'task_already_claimed',
            `Task ${row.task_id} is already held by ${held.agent_id} (${held.claim_id}).`,
            { data: { holder: { agent_id: held.agent_id, claim_id: held.claim_id } }, startedAt },
          );
        }
        return failEnvelope('no_claimable_task', `Task ${row.task_id} is ${row.status}, not ready.`, { startedAt });
      }
      const failure = candidateGuard(row, rowsById, role, stores, approvals);
      if (failure) {
        return failEnvelope(failure.code, failure.message, {
          data: { candidate_task_id: row.task_id, ...(failure.data ?? {}) },
          startedAt,
        });
      }
      return finishClaim(row);
    }

    const typeFilter = (r: TaskRow) => !integrating || ['review', 'verify', 'integration'].includes(r.type);
    const excluded: Array<{ task_id: string; reason: string }> = [];
    const claimable: TaskRow[] = [];
    for (const row of rows.filter((r) => r.status === 'ready' && typeFilter(r))) {
      const failure = candidateGuard(row, rowsById, role, stores, approvals);
      if (failure) excluded.push({ task_id: row.task_id, reason: failure.code });
      else claimable.push(row);
    }
    if (claimable.length === 0) {
      return failEnvelope('no_claimable_task', `No claimable task on ${runId} for role "${role}".`, {
        data: { excluded, swept: swept.reclaimed },
        nextActions: [`Check the queue: sigmarun status ${runId}`, 'Wait for blocking tasks to finish.'],
        startedAt,
      });
    }

    // Guard #9: run-wide parallel cap.
    const activeCount = stores.taskClaims.doc.claims.filter(ACTIVE).length;
    if (activeCount >= policy.max_parallel_tasks) {
      return failEnvelope(
        'parallel_limit_reached',
        `Run ${runId} already has ${activeCount} active claims (limit ${policy.max_parallel_tasks}).`,
        { startedAt },
      );
    }

    // docs/10 §7 ordering: priority desc, depth asc, weight desc, task_id asc.
    const depthMemo = new Map<string, number>();
    claimable.sort(
      (a, b) =>
        b.priority - a.priority ||
        depthOf(a.task_id, rowsById, depthMemo) - depthOf(b.task_id, rowsById, depthMemo) ||
        b.weight - a.weight ||
        a.task_id.localeCompare(b.task_id),
    );
    const picked = claimable[0];
    if (!picked) {
      return failEnvelope('no_claimable_task', `No claimable task on ${runId} for role "${role}".`, { startedAt });
    }
    return finishClaim(picked);

    function finishClaim(row: TaskRow): Envelope {
      const slug = slugify(row.title);
      if (opts.dryRun) {
        return okEnvelope({
          message: `Dry run: would claim ${row.task_id} ("${row.title}").`,
          data: { would_claim: row.task_id, role, swept: swept.reclaimed },
          startedAt,
        });
      }
      const countersFile = join(runDir, 'counters.json');
      const counters = readJsonState(countersFile);
      const cdoc = counters.doc as Record<string, unknown>;
      let claimNo = Number(cdoc.next_claim ?? 1);
      const now = new Date();
      const lease = new Date(now.getTime() + policy.claim_ttl_minutes * 60_000).toISOString();
      const taskClaimId = `CLAIM-task-${String(claimNo++).padStart(4, '0')}`;
      const attempt =
        stores.taskClaims.doc.claims.filter((c) => c.task_id === row.task_id).length + 1;
      stores.taskClaims.doc.claims.push({
        claim_id: taskClaimId,
        task_id: row.task_id,
        agent_id: opts.agentId,
        status: 'active',
        acquired_at: now.toISOString(),
        lease_until: lease,
        last_heartbeat_at: now.toISOString(),
        released_at: null,
        release_reason: null,
        attempt,
      });
      const pathClaimIds: string[] = [];
      if ((row.paths.allow ?? []).length > 0) {
        const pathClaimId = `CLAIM-path-${String(claimNo++).padStart(4, '0')}`;
        pathClaimIds.push(pathClaimId);
        stores.pathClaims.doc.claims.push({
          claim_id: pathClaimId,
          task_id: row.task_id,
          agent_id: opts.agentId,
          status: 'active',
          paths: row.paths,
          policy: policy.path_conflict_policy,
          acquired_at: now.toISOString(),
          lease_until: lease,
        });
      }

      saveState(stores.taskClaims.file, stores.taskClaims.doc, stores.taskClaims.rev);
      saveState(stores.pathClaims.file, stores.pathClaims.doc, stores.pathClaims.rev);

      const taskFile = join(runDir, 'tasks', row.task_id, 'task.json');
      const task = readJsonState(taskFile);
      const tdoc = task.doc as Record<string, unknown>;
      tdoc.status = 'claimed';
      writeJsonStateAtomic(taskFile, tdoc, { expectedRev: task.rev });

      row.status = 'claimed';
      row.owner_agent_id = opts.agentId;
      row.claim_id = taskClaimId;
      writeJsonStateAtomic(listFile, list.doc as Record<string, unknown>, { expectedRev: list.rev });

      agent.current_task_id = row.task_id;
      agent.last_heartbeat_at = now.toISOString();
      writeJsonStateAtomic(agentFile, agent, { expectedRev: agentState.rev });

      writeJsonStateAtomic(countersFile, { ...cdoc, next_claim: claimNo }, { expectedRev: counters.rev });

      const actor: EventActor = { type: 'agent', id: opts.agentId };
      appendEvent(runDir, {
        event: 'task_claimed',
        actor,
        run_id: runId,
        task_id: row.task_id,
        claim_id: taskClaimId,
        payload: { lease_until: lease },
      });
      for (const pid of pathClaimIds) {
        appendEvent(runDir, {
          event: 'path_claimed',
          actor,
          run_id: runId,
          task_id: row.task_id,
          claim_id: pid,
          payload: { paths: row.paths },
        });
      }

      return okEnvelope({
        message: `Claimed ${row.task_id} ("${row.title}") until ${lease}.`,
        data: {
          task_id: row.task_id,
          claim_id: taskClaimId,
          path_claim_ids: pathClaimIds,
          agent_id: opts.agentId,
          lease_until: lease,
          worktree: {
            suggested_branch: `team/${runId}/${row.task_id}-${slug}`,
            suggested_path: `../.team-worktrees/${runId}/${row.task_id}`,
          },
          swept: swept.reclaimed,
        },
        nextActions: [
          `Read the brief: .team/runs/${runId}/tasks/${row.task_id}/task.md`,
          `Send heartbeats: sigmarun heartbeat ${runId} ${row.task_id} --agent=${opts.agentId}`,
        ],
        startedAt,
      });
    }
  } catch (err) {
    if (err instanceof GatewayError) return failEnvelope(err.code, err.message, { startedAt });
    throw err;
  } finally {
    release();
  }
}

// ---------- heartbeat / release / reclaim ----------

/** Locate the active claim for (task, agent-optional); shared guard for lease commands. */
function findActiveClaim(
  stores: ClaimStores,
  taskId: string,
  agentId?: string,
): { claim: TaskClaim } | GuardFailure {
  const claim = stores.taskClaims.doc.claims.find((c) => c.task_id === taskId && ACTIVE(c));
  if (!claim) {
    return { code: 'claim_not_found', message: `No active claim on ${taskId}.` };
  }
  if (agentId && claim.agent_id !== agentId) {
    return {
      code: 'not_claim_owner',
      message: `Claim ${claim.claim_id} on ${taskId} belongs to ${claim.agent_id}, not ${agentId}.`,
    };
  }
  return { claim };
}

function withRunLock(
  opts: ResolveOptions & { runId: string },
  startedAt: number,
  body: (runDir: string, runId: string) => Envelope,
): Envelope {
  const ctx = openRun(opts);
  if (ctx instanceof GatewayError) return failEnvelope(ctx.code, ctx.message, { startedAt });
  const release = (() => {
    try {
      return acquireLock(join(ctx.runDir, 'run.lock'));
    } catch (err) {
      return err as GatewayError;
    }
  })();
  if (release instanceof GatewayError) return failEnvelope(release.code, release.message, { startedAt });
  try {
    return body(ctx.runDir, ctx.runId);
  } catch (err) {
    if (err instanceof GatewayError) return failEnvelope(err.code, err.message, { startedAt });
    throw err;
  } finally {
    release();
  }
}

export function heartbeat(opts: HeartbeatOptions): Envelope {
  const startedAt = Date.now();
  return withRunLock(opts, startedAt, (runDir, runId) => {
    const stores = loadClaims(runDir, runId);
    const found = findActiveClaim(stores, opts.taskId, opts.agentId);
    if (!('claim' in found)) return failEnvelope(found.code, found.message, { startedAt });
    const run = readJsonState(join(runDir, 'run.json'));
    const ttl = ((run.doc as { policy?: { claim_ttl_minutes?: number } }).policy?.claim_ttl_minutes ?? 30) * 60_000;
    const now = new Date();
    const lease = new Date(now.getTime() + ttl).toISOString();
    found.claim.lease_until = lease;
    found.claim.last_heartbeat_at = now.toISOString();
    for (const pc of stores.pathClaims.doc.claims.filter((c) => c.task_id === opts.taskId && ACTIVE(c))) {
      pc.lease_until = lease;
    }
    saveState(stores.taskClaims.file, stores.taskClaims.doc, stores.taskClaims.rev);
    saveState(stores.pathClaims.file, stores.pathClaims.doc, stores.pathClaims.rev);
    const agentFile = join(runDir, 'agents', `${opts.agentId}.json`);
    if (existsSync(agentFile)) {
      const agent = readJsonState(agentFile);
      (agent.doc as Record<string, unknown>).last_heartbeat_at = now.toISOString();
      writeJsonStateAtomic(agentFile, agent.doc as Record<string, unknown>, { expectedRev: agent.rev });
    }
    appendEvent(runDir, {
      event: 'heartbeat',
      actor: { type: 'agent', id: opts.agentId },
      run_id: runId,
      task_id: opts.taskId,
      claim_id: found.claim.claim_id,
      payload: { lease_until: lease },
    });
    return okEnvelope({
      message: `Lease on ${opts.taskId} extended to ${lease}.`,
      data: { task_id: opts.taskId, claim_id: found.claim.claim_id, lease_until: lease },
      startedAt,
    });
  });
}

export function releaseTask(opts: ReleaseOptions): Envelope {
  const startedAt = Date.now();
  return withRunLock(opts, startedAt, (runDir, runId) => {
    const stores = loadClaims(runDir, runId);
    const found = findActiveClaim(stores, opts.taskId, opts.agentId);
    if (!('claim' in found)) return failEnvelope(found.code, found.message, { startedAt });
    const listFile = join(runDir, 'team-task-list.json');
    const list = readJsonState(listFile);
    const row = (list.doc as { tasks: TaskRow[] }).tasks.find((r) => r.task_id === opts.taskId);
    const task = readJsonState(join(runDir, 'tasks', opts.taskId, 'task.json'));
    applyReclaim(runDir, runId, stores, row, found.claim, task, {
      reason: opts.reason ?? 'released_by_owner',
      actor: { type: 'agent', id: opts.agentId },
      terminal: 'released',
    });
    saveState(stores.taskClaims.file, stores.taskClaims.doc, stores.taskClaims.rev);
    saveState(stores.pathClaims.file, stores.pathClaims.doc, stores.pathClaims.rev);
    writeJsonStateAtomic(listFile, list.doc as Record<string, unknown>, { expectedRev: list.rev });
    const agentFile = join(runDir, 'agents', `${opts.agentId}.json`);
    if (existsSync(agentFile)) {
      const agent = readJsonState(agentFile);
      (agent.doc as Record<string, unknown>).current_task_id = null;
      writeJsonStateAtomic(agentFile, agent.doc as Record<string, unknown>, { expectedRev: agent.rev });
    }
    return okEnvelope({
      message: `Released ${opts.taskId}; it is claimable again.`,
      data: { task_id: opts.taskId, claim_id: found.claim.claim_id },
      startedAt,
    });
  });
}

export function reclaimTask(opts: ReclaimOptions): Envelope {
  const startedAt = Date.now();
  return withRunLock(opts, startedAt, (runDir, runId) => {
    const stores = loadClaims(runDir, runId);
    const found = findActiveClaim(stores, opts.taskId);
    if (!('claim' in found)) return failEnvelope(found.code, found.message, { startedAt });
    if (Date.parse(found.claim.lease_until) > Date.now()) {
      return failEnvelope(
        'invalid_transition',
        `Claim ${found.claim.claim_id} on ${opts.taskId} is still leased until ${found.claim.lease_until}.`,
        { nextActions: ['Wait for the lease to expire, or ask the owner to release.'], startedAt },
      );
    }
    const listFile = join(runDir, 'team-task-list.json');
    const list = readJsonState(listFile);
    const row = (list.doc as { tasks: TaskRow[] }).tasks.find((r) => r.task_id === opts.taskId);
    const task = readJsonState(join(runDir, 'tasks', opts.taskId, 'task.json'));
    applyReclaim(runDir, runId, stores, row, found.claim, task, {
      reason: 'stale_lease_manual',
      actor: { type: 'user', id: 'user' },
    });
    saveState(stores.taskClaims.file, stores.taskClaims.doc, stores.taskClaims.rev);
    saveState(stores.pathClaims.file, stores.pathClaims.doc, stores.pathClaims.rev);
    writeJsonStateAtomic(listFile, list.doc as Record<string, unknown>, { expectedRev: list.rev });
    return okEnvelope({
      message: `Reclaimed ${opts.taskId} from ${found.claim.agent_id}; progress kept in previous_attempts.`,
      data: { task_id: opts.taskId, claim_id: found.claim.claim_id, previous_agent: found.claim.agent_id },
      startedAt,
    });
  });
}

// ---------- approve-paths (BR-001 row 8 grant half; AUD-004) ----------

export function approvePaths(opts: ApproveOptions): Envelope {
  const startedAt = Date.now();
  return withRunLock(opts, startedAt, (runDir, runId) => {
    if (!existsSync(join(runDir, 'tasks', opts.taskId, 'task.json'))) {
      return failEnvelope('task_not_found', `Task ${opts.taskId} does not exist on ${runId}.`, { startedAt });
    }
    if (!opts.paths || opts.paths.length === 0) {
      return failEnvelope('usage_error', 'approve-paths needs at least one glob via --paths.', { startedAt });
    }
    mkdirSync(join(runDir, 'claims'), { recursive: true });
    const file = join(runDir, 'claims', 'path-approvals.json');
    const state = readOrDefault(file, { schema_version: 'team.path_approvals.v1', run_id: runId, approvals: [] });
    const countersFile = join(runDir, 'counters.json');
    const counters = readJsonState(countersFile);
    const cdoc = counters.doc as Record<string, unknown>;
    const n = Number(cdoc.next_approval ?? 1);
    const approvalId = `APPR-${String(n).padStart(4, '0')}`;
    const grantedBy = opts.grantedBy ?? 'user';
    (state.doc.approvals as Array<Record<string, unknown>>).push({
      approval_id: approvalId,
      task_id: opts.taskId,
      paths: opts.paths,
      granted_by: grantedBy,
      granted_at: new Date().toISOString(),
      status: 'granted',
    });
    saveState(file, state.doc, state.rev);
    writeJsonStateAtomic(countersFile, { ...cdoc, next_approval: n + 1 }, { expectedRev: counters.rev });
    appendEvent(runDir, {
      event: 'path_approval_granted',
      actor: { type: 'user', id: grantedBy },
      run_id: runId,
      task_id: opts.taskId,
      payload: { approval_id: approvalId, paths: opts.paths, granted_by: grantedBy },
    });
    return okEnvelope({
      message: `Approved ${opts.paths.length} path glob(s) for ${opts.taskId}.`,
      data: { approval_id: approvalId, task_id: opts.taskId, paths: opts.paths },
      startedAt,
    });
  });
}
