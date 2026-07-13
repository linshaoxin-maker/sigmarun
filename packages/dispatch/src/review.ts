import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonState, writeJsonStateAtomic, writeJsonStateNew, type ResolveOptions } from '@sigmarun/storage';
import { appendEvent, failEnvelope, okEnvelope, type Envelope } from '@sigmarun/core';
import { findActiveClaim, loadClaims, readOrDefault, saveState, withRunLock, type ClaimStores, type TaskRow } from './claim-engine.js';

export interface ReviewClaimOptions extends ResolveOptions {
  runId: string;
  taskId: string;
  agentId: string;
}

export interface ReviewDecideOptions extends ReviewClaimOptions {
  decision: 'approve' | 'request_changes' | 'block';
  review: {
    checklist?: Array<{ item: string; status: string }>;
    findings?: Array<Record<string, unknown> & { must_fix?: boolean; message?: string }>;
    scope_check?: Record<string, unknown>;
    acceptance_opinion?: Array<Record<string, unknown>>;
  };
}

export interface ResumeOptions extends ReviewClaimOptions {}

interface ReviewClaim {
  claim_id: string;
  task_id: string;
  reviewer_agent_id: string;
  round: number;
  status: string;
  acquired_at: string;
  lease_until: string;
  /** absent = review (pre-verify-claim ledgers); D15 leases verify work through the same file. */
  kind?: 'review' | 'verify';
}

const claimKind = (c: ReviewClaim): 'review' | 'verify' => c.kind ?? 'review';

function loadReviewClaims(runDir: string, runId: string) {
  const file = join(runDir, 'claims', 'review-claims.json');
  mkdirSync(join(runDir, 'claims'), { recursive: true });
  const state = readOrDefault(file, { schema_version: 'team.review_claims.v1', run_id: runId, claims: [] });
  return { file, doc: state.doc as { claims: ReviewClaim[] } & Record<string, unknown>, rev: state.rev };
}

/** All agents that ever owned the task: current/former claims + previous_attempts (INV-008 surface). */
export function historicalOwners(runDir: string, taskId: string, stores: ClaimStores): Set<string> {
  const owners = new Set<string>();
  for (const c of stores.taskClaims.doc.claims.filter((c) => c.task_id === taskId)) owners.add(c.agent_id);
  const taskFile = join(runDir, 'tasks', taskId, 'task.json');
  if (existsSync(taskFile)) {
    const attempts = (readJsonState(taskFile).doc as { previous_attempts?: Array<{ agent_id: string }> }).previous_attempts ?? [];
    for (const a of attempts) owners.add(a.agent_id);
  }
  return owners;
}

function evidenceRevision(runDir: string, taskId: string): number {
  const f = join(runDir, 'evidence', taskId, 'evidence.json');
  return existsSync(f) ? Number((readJsonState(f).doc as { revision?: number }).revision ?? 1) : 1;
}

/**
 * Lazy sweep for expired review leases: claim released, task back to submitted (BDD-006-05).
 * Persists review-claims.json ITSELF and appends events only after that write — a caller's
 * guard-failure return must never leave the release half-committed (review finding #3).
 */
function sweepReviewClaims(runDir: string, runId: string, rc: ReturnType<typeof loadReviewClaims>): number {
  const now = Date.now();
  const released: ReviewClaim[] = [];
  for (const claim of rc.doc.claims.filter((c) => c.status === 'active')) {
    const taskFile = join(runDir, 'tasks', claim.task_id, 'task.json');
    const taskStatus = existsSync(taskFile) ? (readJsonState(taskFile).doc as { status: string }).status : 'unknown';
    const leaseExpired = now > Date.parse(claim.lease_until);
    // An active review claim should always sit on a 'reviewing' task. If the task has moved on
    // (crash between the sweep's task-flip and its claim persist — concurrency review Finding 4),
    // the claim is orphaned: release it immediately instead of waiting out the lease TTL.
    const orphaned = claimKind(claim) === 'review' && taskStatus !== 'reviewing';
    const verifyOrphaned = claimKind(claim) === 'verify' && !['approved'].includes(taskStatus) && taskStatus !== 'unknown';
    if (!leaseExpired && !orphaned && !verifyOrphaned) continue;
    claim.status = 'released';
    if (existsSync(taskFile)) {
      const task = readJsonState(taskFile);
      if ((task.doc as { status: string }).status === 'reviewing') {
        (task.doc as { status: string }).status = 'submitted';
        writeJsonStateAtomic(taskFile, task.doc as Record<string, unknown>, { expectedRev: task.rev });
        const listFile = join(runDir, 'team-task-list.json');
        const list = readJsonState(listFile);
        const row = (list.doc as { tasks: TaskRow[] }).tasks.find((r) => r.task_id === claim.task_id);
        if (row) {
          row.status = 'submitted';
          writeJsonStateAtomic(listFile, list.doc as Record<string, unknown>, { expectedRev: list.rev });
        }
      }
    }
    released.push(claim);
  }
  if (released.length > 0) {
    saveState(rc.file, rc.doc, rc.rev);
    rc.rev = (rc.rev ?? 0) + 1;
    for (const claim of released) {
      appendEvent(runDir, {
        event: claimKind(claim) === 'verify' ? 'verify_released' : 'review_released',
        actor: { type: 'sweep', id: 'sweep' },
        run_id: runId,
        task_id: claim.task_id,
        claim_id: claim.claim_id,
        payload: {},
      });
    }
  }
  return released.length;
}

interface GrantResult {
  claim: ReviewClaim;
  round: number;
}

/** Shared guard+grant used by the explicit command and the D15 synthesis. */
function grantReviewClaim(
  runDir: string,
  runId: string,
  taskId: string,
  agentId: string,
): GrantResult | { code: 'self_approval_forbidden' | 'task_already_claimed' | 'no_claimable_task' | 'task_not_found'; message: string } {
  if (!existsSync(join(runDir, 'tasks', taskId, 'task.json'))) {
    return { code: 'task_not_found', message: `Task ${taskId} does not exist on ${runId}.` };
  }
  const stores = loadClaims(runDir, runId);
  const rc = loadReviewClaims(runDir, runId);
  sweepReviewClaims(runDir, runId, rc);

  if (rc.doc.claims.some((c) => c.task_id === taskId && c.status === 'active')) {
    return { code: 'task_already_claimed', message: `Task ${taskId} already has an active review claim.` };
  }
  const task = readJsonState(join(runDir, 'tasks', taskId, 'task.json'));
  const status = (task.doc as { status: string }).status;
  if (status !== 'submitted') {
    return { code: 'no_claimable_task', message: `Task ${taskId} is ${status}; review claims need submitted.` };
  }
  if (historicalOwners(runDir, taskId, stores).has(agentId)) {
    return {
      code: 'self_approval_forbidden',
      message: `Agent ${agentId} owned ${taskId} at some point; INV-008 forbids reviewing your own work.`,
    };
  }

  const run = readJsonState(join(runDir, 'run.json')).doc as { default_policy?: { review_ttl_minutes?: number } };
  const ttlMin = run.default_policy?.review_ttl_minutes ?? 20;
  const countersFile = join(runDir, 'counters.json');
  const counters = readJsonState(countersFile);
  const cdoc = counters.doc as Record<string, unknown>;
  const n = Number(cdoc.next_claim ?? 1);
  const round = evidenceRevision(runDir, taskId);
  const now = new Date();
  const claim: ReviewClaim = {
    claim_id: `CLAIM-review-${String(n).padStart(4, '0')}`,
    task_id: taskId,
    reviewer_agent_id: agentId,
    round,
    status: 'active',
    acquired_at: now.toISOString(),
    lease_until: new Date(now.getTime() + ttlMin * 60_000).toISOString(),
  };
  rc.doc.claims.push(claim);
  saveState(rc.file, rc.doc, rc.rev);
  writeJsonStateAtomic(countersFile, { ...cdoc, next_claim: n + 1 }, { expectedRev: counters.rev });

  (task.doc as { status: string }).status = 'reviewing';
  writeJsonStateAtomic(join(runDir, 'tasks', taskId, 'task.json'), task.doc as Record<string, unknown>, { expectedRev: task.rev });
  const listFile = join(runDir, 'team-task-list.json');
  const list = readJsonState(listFile);
  const row = (list.doc as { tasks: TaskRow[] }).tasks.find((r) => r.task_id === taskId);
  if (row) row.status = 'reviewing';
  writeJsonStateAtomic(listFile, list.doc as Record<string, unknown>, { expectedRev: list.rev });

  appendEvent(runDir, {
    event: 'review_claimed',
    actor: { type: 'agent', id: agentId },
    run_id: runId,
    task_id: taskId,
    claim_id: claim.claim_id,
    payload: { round },
  });
  return { claim, round };
}

export function reviewClaim(opts: ReviewClaimOptions): Envelope {
  const startedAt = Date.now();
  return withRunLock(opts, startedAt, (runDir, runId) => {
    if (!existsSync(join(runDir, 'agents', `${opts.agentId}.json`))) {
      return failEnvelope('agent_not_registered', `Agent ${opts.agentId} is not registered on ${runId}.`, { startedAt });
    }
    const result = grantReviewClaim(runDir, runId, opts.taskId, opts.agentId);
    if (!('claim' in result)) return failEnvelope(result.code, result.message, { startedAt });
    return okEnvelope({
      message: `Review claim ${result.claim.claim_id} on ${opts.taskId} (round ${result.round}) until ${result.claim.lease_until}.`,
      data: {
        kind: 'review_work',
        task_id: opts.taskId,
        claim_id: result.claim.claim_id,
        round: result.round,
        lease_until: result.claim.lease_until,
        evidence_ref: `evidence/${opts.taskId}/evidence.json`,
        checklist_source: 'task.review.focus, else: scope respected / acceptance items hold / tests real and passing / evidence complete',
      },
      nextActions: [
        `Read the evidence: .team/runs/${runId}/evidence/${opts.taskId}/evidence.json`,
        `Decide: sigmarun review approve|request-changes ${runId} ${opts.taskId} --agent=${opts.agentId} --review=<file>`,
      ],
      startedAt,
    });
  });
}

/** D15: synthesize a review work item for `claim-next --role reviewer`; called inside the claim-next lock. */
export function synthesizeReview(runDir: string, runId: string, agentId: string, startedAt: number): Envelope {
  const listFile = join(runDir, 'team-task-list.json');
  const rows = (readJsonState(listFile).doc as { tasks: TaskRow[] }).tasks;
  const rc = loadReviewClaims(runDir, runId);
  sweepReviewClaims(runDir, runId, rc);
  const stores = loadClaims(runDir, runId);
  // One pass over claims instead of rows x claims scans (review round: efficiency candidate).
  const claimOwners = new Map<string, Set<string>>();
  for (const c of stores.taskClaims.doc.claims) {
    if (!claimOwners.has(c.task_id)) claimOwners.set(c.task_id, new Set());
    claimOwners.get(c.task_id)!.add(c.agent_id);
  }
  const activeReview = new Set(rc.doc.claims.filter((c) => c.status === 'active').map((c) => c.task_id));
  const ownedByAgent = (taskId: string): boolean => {
    if (claimOwners.get(taskId)?.has(agentId)) return true;
    const f = join(runDir, 'tasks', taskId, 'task.json');
    if (!existsSync(f)) return false;
    const attempts = (readJsonState(f).doc as { previous_attempts?: Array<{ agent_id: string }> }).previous_attempts ?? [];
    return attempts.some((a) => a.agent_id === agentId);
  };
  const candidates = rows
    .filter((r) => r.status === 'submitted')
    .filter((r) => !activeReview.has(r.task_id))
    .filter((r) => !ownedByAgent(r.task_id))
    .map((r) => ({ row: r, submittedAt: evidenceSubmittedAt(runDir, r.task_id) }))
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.row.task_id.localeCompare(b.row.task_id));
  const picked = candidates[0];
  if (!picked) {
    return failEnvelope('no_claimable_task', `No task is waiting for review on ${runId}.`, {
      nextActions: [`Check the queue: sigmarun status ${runId}`],
      startedAt,
    });
  }
  const result = grantReviewClaim(runDir, runId, picked.row.task_id, agentId);
  if (!('claim' in result)) return failEnvelope(result.code, result.message, { startedAt });
  return okEnvelope({
    message: `Synthesized review work: ${picked.row.task_id} (round ${result.round}).`,
    data: {
      kind: 'review_work',
      task_id: picked.row.task_id,
      claim_id: result.claim.claim_id,
      round: result.round,
      lease_until: result.claim.lease_until,
      evidence_ref: `evidence/${picked.row.task_id}/evidence.json`,
      checklist_source: 'task.review.focus, else: scope respected / acceptance items hold / tests real and passing / evidence complete',
    },
    nextActions: [
      `Read the evidence, then decide: sigmarun review approve|request-changes ${runId} ${picked.row.task_id} --agent=${agentId} --review=<file>`,
    ],
    startedAt,
  });
}

function evidenceSubmittedAt(runDir: string, taskId: string): string {
  const f = join(runDir, 'evidence', taskId, 'evidence.json');
  return existsSync(f) ? String((readJsonState(f).doc as { submitted_at?: string }).submitted_at ?? '') : '';
}

export function reviewDecide(opts: ReviewDecideOptions): Envelope {
  const startedAt = Date.now();
  return withRunLock(opts, startedAt, (runDir, runId) => {
    const rc = loadReviewClaims(runDir, runId);
    const claim = rc.doc.claims.find((c) => c.task_id === opts.taskId && c.status === 'active');
    if (!claim) {
      return failEnvelope('claim_not_found', `No active review claim on ${opts.taskId}.`, { startedAt });
    }
    if (claim.reviewer_agent_id !== opts.agentId) {
      return failEnvelope('not_claim_owner', `Review claim ${claim.claim_id} belongs to ${claim.reviewer_agent_id}.`, { startedAt });
    }
    // AUD-015 inline recheck at the record boundary (defense in depth over the claim guard).
    const stores = loadClaims(runDir, runId);
    if (historicalOwners(runDir, opts.taskId, stores).has(opts.agentId)) {
      return failEnvelope('self_approval_forbidden', `Agent ${opts.agentId} owned ${opts.taskId}; the review is void (INV-008).`, { startedAt });
    }

    const findings = opts.review.findings ?? [];
    const mustFix = findings.filter((f) => f.must_fix === true);
    if (opts.decision === 'request_changes' && mustFix.length === 0) {
      return failEnvelope('schema_invalid', 'request_changes requires at least one must_fix finding (docs/14 §3.2).', { startedAt });
    }

    // Mirror must_fix findings into the message pool first so records can back-link message_ref (docs/12 §6).
    // A block decision mirrors a blocker message too — AUD-024 requires every blocked task to carry one.
    const mirroredIds: string[] = [];
    if (opts.decision === 'block') {
      const countersFile = join(runDir, 'counters.json');
      const counters = readJsonState(countersFile);
      const cdoc = counters.doc as Record<string, unknown>;
      const n = Number(cdoc.next_msg ?? 1);
      const messageId = `MSG-${String(n).padStart(4, '0')}`;
      mkdirSync(join(runDir, 'context'), { recursive: true });
      appendFileSync(
        join(runDir, 'context', 'messages.jsonl'),
        JSON.stringify({
          message_id: messageId,
          run_id: runId,
          task_id: opts.taskId,
          from_agent_id: opts.agentId,
          to: 'run',
          type: 'blocker',
          visibility: 'run',
          body: String(findings[0]?.message ?? 'Review blocked: a human decision is needed before work continues.'),
          created_at: new Date().toISOString(),
          status: 'open',
          refs: [`reviews/${opts.taskId}`],
        }) + '\n',
        'utf8',
      );
      writeJsonStateAtomic(countersFile, { ...cdoc, next_msg: n + 1 }, { expectedRev: counters.rev });
      mirroredIds.push(messageId);
    }
    if (mustFix.length > 0) {
      const countersFile = join(runDir, 'counters.json');
      const counters = readJsonState(countersFile);
      const cdoc = counters.doc as Record<string, unknown>;
      let n = Number(cdoc.next_msg ?? 1);
      mkdirSync(join(runDir, 'context'), { recursive: true });
      for (const f of mustFix) {
        const messageId = `MSG-${String(n++).padStart(4, '0')}`;
        appendFileSync(
          join(runDir, 'context', 'messages.jsonl'),
          JSON.stringify({
            message_id: messageId,
            run_id: runId,
            task_id: opts.taskId,
            from_agent_id: opts.agentId,
            to: `task:${opts.taskId}`,
            type: 'request_changes',
            visibility: 'run',
            body: String(f.message ?? 'must_fix finding'),
            created_at: new Date().toISOString(),
            status: 'open',
            refs: [`reviews/${opts.taskId}`],
          }) + '\n',
          'utf8',
        );
        f.message_ref = messageId;
        mirroredIds.push(messageId);
      }
      writeJsonStateAtomic(countersFile, { ...cdoc, next_msg: n }, { expectedRev: counters.rev });
    }

    const reviewId = `REVIEW-${opts.taskId}-${String(claim.round).padStart(2, '0')}`;
    const reviewsDir = join(runDir, 'reviews', opts.taskId);
    mkdirSync(reviewsDir, { recursive: true });
    writeJsonStateNew(join(reviewsDir, `${reviewId}.json`), {
      schema_version: 'team.review.v1',
      review_id: reviewId,
      run_id: runId,
      task_id: opts.taskId,
      round: claim.round,
      reviewer_agent_id: opts.agentId,
      evidence_revision: claim.round,
      started_at: claim.acquired_at,
      completed_at: new Date().toISOString(),
      decision: opts.decision,
      checklist: opts.review.checklist ?? [],
      findings,
      scope_check: opts.review.scope_check ?? { out_of_scope_files: [], verdict: 'pass' },
      acceptance_opinion: opts.review.acceptance_opinion ?? [],
    });

    // docs/17 §5.3 order: detail -> index -> claims -> event (the append below is the commit point).
    const NEXT_STATUS: Record<string, string> = { approve: 'approved', request_changes: 'changes_requested', block: 'blocked' };
    const nextStatus = NEXT_STATUS[opts.decision]!;
    const taskFile = join(runDir, 'tasks', opts.taskId, 'task.json');
    const task = readJsonState(taskFile);
    (task.doc as { status: string }).status = nextStatus;
    writeJsonStateAtomic(taskFile, task.doc as Record<string, unknown>, { expectedRev: task.rev });
    const listFile = join(runDir, 'team-task-list.json');
    const list = readJsonState(listFile);
    const row = (list.doc as { tasks: TaskRow[] }).tasks.find((r) => r.task_id === opts.taskId);
    if (row) row.status = nextStatus;
    writeJsonStateAtomic(listFile, list.doc as Record<string, unknown>, { expectedRev: list.rev });

    claim.status = 'completed';
    saveState(rc.file, rc.doc, rc.rev);

    if (opts.decision === 'request_changes') {
      // Revive the owner's claim in place: same claim, fresh lease; path claims were never released (15 §4.4).
      const owner = stores.taskClaims.doc.claims.find((c) => c.task_id === opts.taskId && c.status === 'submitted');
      if (owner) {
        const run = readJsonState(join(runDir, 'run.json')).doc as { default_policy?: { claim_ttl_minutes?: number } };
        const ttl = (run.default_policy?.claim_ttl_minutes ?? 30) * 60_000;
        owner.status = 'active';
        owner.lease_until = new Date(Date.now() + ttl).toISOString();
        saveState(stores.taskClaims.file, stores.taskClaims.doc, stores.taskClaims.rev);
      }
    }

    const EVENT_BY_DECISION: Record<string, string> = {
      approve: 'review_approved',
      request_changes: 'changes_requested',
      block: 'review_blocked',
    };
    appendEvent(runDir, {
      event: EVENT_BY_DECISION[opts.decision]!,
      actor: { type: 'agent', id: opts.agentId },
      run_id: runId,
      task_id: opts.taskId,
      claim_id: claim.claim_id,
      payload:
        opts.decision === 'request_changes'
          ? { review_id: reviewId, must_fix_count: mustFix.length, mirrored: mirroredIds }
          : { review_id: reviewId, round: claim.round },
    });

    const MESSAGE_BY_DECISION: Record<string, string> = {
      approve: `${reviewId}: approved; ${opts.taskId} moves on.`,
      request_changes: `${reviewId}: changes requested (${mustFix.length} must-fix); owner claim revived.`,
      block: `${reviewId}: blocked; ${opts.taskId} needs a human decision before work continues.`,
    };
    const NEXT_BY_DECISION: Record<string, string[]> = {
      approve: ['Verification/integration continue per run policy (FEAT-010).'],
      request_changes: [`Owner resumes: sigmarun resume ${runId} ${opts.taskId} --agent=<owner>`],
      block: [`Resolve the blocker, then: sigmarun unblock ${runId} ${opts.taskId} --agent=<owner>`],
    };
    return okEnvelope({
      message: MESSAGE_BY_DECISION[opts.decision]!,
      data: { review_id: reviewId, task_id: opts.taskId, round: claim.round, decision: opts.decision, mirrored: mirroredIds },
      nextActions: NEXT_BY_DECISION[opts.decision]!,
      startedAt,
    });
  });
}

/** 15 §3.3 blocked -> working (unblock; owner or user; event #15). */
export function unblockTask(opts: ResumeOptions & { reason?: string }): Envelope {
  const startedAt = Date.now();
  return withRunLock(opts, startedAt, (runDir, runId) => {
    const taskFile = join(runDir, 'tasks', opts.taskId, 'task.json');
    if (!existsSync(taskFile)) {
      return failEnvelope('task_not_found', `Task ${opts.taskId} does not exist on ${runId}.`, { startedAt });
    }
    const task = readJsonState(taskFile);
    const status = (task.doc as { status: string }).status;
    if (status !== 'blocked') {
      return failEnvelope('invalid_transition', `Task ${opts.taskId} is ${status}; unblock applies to blocked.`, { startedAt });
    }
    // 15 §3.3: unblock is an owner-or-user action. A block means "needs a human decision",
    // so an arbitrary agent must not be able to lift it (security review: no check existed).
    if (opts.agentId !== 'user') {
      if (!existsSync(join(runDir, 'agents', `${opts.agentId}.json`))) {
        return failEnvelope('agent_not_registered', `Agent ${opts.agentId} is not registered on ${runId}.`, { startedAt });
      }
      const owners = historicalOwners(runDir, opts.taskId, loadClaims(runDir, runId));
      if (!owners.has(opts.agentId)) {
        return failEnvelope('not_claim_owner', `Only a task owner or the user may unblock ${opts.taskId}; pass --agent=user for a human override.`, { startedAt });
      }
    }
    (task.doc as { status: string }).status = 'working';
    writeJsonStateAtomic(taskFile, task.doc as Record<string, unknown>, { expectedRev: task.rev });
    const listFile = join(runDir, 'team-task-list.json');
    const list = readJsonState(listFile);
    const row = (list.doc as { tasks: TaskRow[] }).tasks.find((r) => r.task_id === opts.taskId);
    if (row) row.status = 'working';
    writeJsonStateAtomic(listFile, list.doc as Record<string, unknown>, { expectedRev: list.rev });
    // docs/15 line 199 + §5.1 line 223: a working task holds exactly one ACTIVE claim, and the
    // lease is reset on blocked -> working. review-block inherited a 'submitted' owner claim and
    // never revived it, so without this the task became permanently unclaimable (state-machine
    // review Finding 1: submit/resume/release/reclaim all fail; only `task cancel` escaped).
    const stores = loadClaims(runDir, runId);
    const owner = stores.taskClaims.doc.claims.find(
      (c) => c.task_id === opts.taskId && ['submitted', 'completed', 'active'].includes(c.status),
    );
    if (owner) {
      const run = readJsonState(join(runDir, 'run.json')).doc as { default_policy?: { claim_ttl_minutes?: number } };
      const ttl = (run.default_policy?.claim_ttl_minutes ?? 30) * 60_000;
      owner.status = 'active';
      owner.lease_until = new Date(Date.now() + ttl).toISOString();
      saveState(stores.taskClaims.file, stores.taskClaims.doc, stores.taskClaims.rev);
    }
    appendEvent(runDir, {
      event: 'task_unblocked',
      actor: { type: 'agent', id: opts.agentId },
      run_id: runId,
      task_id: opts.taskId,
      claim_id: owner?.claim_id,
      payload: { reason: opts.reason ?? null, claim_revived: Boolean(owner) },
    });
    return okEnvelope({
      message: `${opts.taskId} unblocked; back to working.`,
      data: { task_id: opts.taskId },
      startedAt,
    });
  });
}

/** 15 §3.3 changes_requested -> working (owner resumes; same claim, worktree already registered). */
export function resumeTask(opts: ResumeOptions): Envelope {
  const startedAt = Date.now();
  return withRunLock(opts, startedAt, (runDir, runId) => {
    const stores = loadClaims(runDir, runId);
    const found = findActiveClaim(stores, opts.taskId, opts.agentId);
    if (!('claim' in found)) return failEnvelope(found.code, found.message, { startedAt });
    const taskFile = join(runDir, 'tasks', opts.taskId, 'task.json');
    const task = readJsonState(taskFile);
    const status = (task.doc as { status: string }).status;
    if (status !== 'changes_requested') {
      return failEnvelope('invalid_transition', `Task ${opts.taskId} is ${status}; resume applies to changes_requested.`, { startedAt });
    }
    (task.doc as { status: string }).status = 'working';
    writeJsonStateAtomic(taskFile, task.doc as Record<string, unknown>, { expectedRev: task.rev });
    const listFile = join(runDir, 'team-task-list.json');
    const list = readJsonState(listFile);
    const row = (list.doc as { tasks: TaskRow[] }).tasks.find((r) => r.task_id === opts.taskId);
    if (row) row.status = 'working';
    writeJsonStateAtomic(listFile, list.doc as Record<string, unknown>, { expectedRev: list.rev });
    appendEvent(runDir, {
      event: 'task_started',
      actor: { type: 'agent', id: opts.agentId },
      run_id: runId,
      task_id: opts.taskId,
      claim_id: found.claim.claim_id,
      payload: { resumed: true },
    });
    return okEnvelope({
      message: `${opts.taskId} back to working; address the must_fix findings, then re-submit.`,
      data: { task_id: opts.taskId, claim_id: found.claim.claim_id },
      startedAt,
    });
  });
}

// ---------- verify work leases (15 §7 D15: reviewer OR verifier synthesis drops a claim) ----------

/** The active verify claim on a task, if any (smoke-test L13: verify work must be leased + mutually exclusive). */
export function activeVerifyClaim(runDir: string, runId: string, taskId: string): { claim_id: string; reviewer_agent_id: string; lease_until: string } | null {
  const rc = loadReviewClaims(runDir, runId);
  sweepReviewClaims(runDir, runId, rc);
  const hit = rc.doc.claims.find((c) => c.task_id === taskId && c.status === 'active' && claimKind(c) === 'verify');
  return hit ? { claim_id: hit.claim_id, reviewer_agent_id: hit.reviewer_agent_id, lease_until: hit.lease_until } : null;
}

/**
 * Lease verify work to an agent. Idempotent for the same agent; refuses when another
 * agent holds the lease. Emits `verify_claimed` after the claims file persists.
 */
export function grantVerifyClaim(
  runDir: string,
  runId: string,
  taskId: string,
  agentId: string,
): { claim_id: string; lease_until: string } | { code: string; message: string } {
  const rc = loadReviewClaims(runDir, runId);
  sweepReviewClaims(runDir, runId, rc);
  const existing = rc.doc.claims.find((c) => c.task_id === taskId && c.status === 'active' && claimKind(c) === 'verify');
  if (existing) {
    if (existing.reviewer_agent_id === agentId) {
      return { claim_id: existing.claim_id, lease_until: existing.lease_until };
    }
    return { code: 'task_already_claimed', message: `Verify work on ${taskId} is already leased to ${existing.reviewer_agent_id} (${existing.claim_id}).` };
  }
  const run = readJsonState(join(runDir, 'run.json')).doc as { default_policy?: { review_ttl_minutes?: number } };
  const ttlMin = run.default_policy?.review_ttl_minutes ?? 20;
  const countersFile = join(runDir, 'counters.json');
  const counters = readJsonState(countersFile);
  const cdoc = counters.doc as Record<string, unknown>;
  const n = Number(cdoc.next_claim ?? 1);
  const now = new Date();
  const claim: ReviewClaim = {
    claim_id: `CLAIM-verify-${String(n).padStart(4, '0')}`,
    task_id: taskId,
    reviewer_agent_id: agentId,
    round: evidenceRevision(runDir, taskId),
    status: 'active',
    acquired_at: now.toISOString(),
    lease_until: new Date(now.getTime() + ttlMin * 60_000).toISOString(),
    kind: 'verify',
  };
  rc.doc.claims.push(claim);
  saveState(rc.file, rc.doc, rc.rev);
  writeJsonStateAtomic(countersFile, { ...cdoc, next_claim: n + 1 }, { expectedRev: counters.rev });
  appendEvent(runDir, {
    event: 'verify_claimed',
    actor: { type: 'agent', id: agentId },
    run_id: runId,
    task_id: taskId,
    claim_id: claim.claim_id,
    payload: { round: claim.round },
  });
  return { claim_id: claim.claim_id, lease_until: claim.lease_until };
}

/** Close the agent's verify lease once the verification record lands (either verdict). */
export function completeVerifyClaim(runDir: string, runId: string, taskId: string, agentId: string): void {
  const rc = loadReviewClaims(runDir, runId);
  const hit = rc.doc.claims.find(
    (c) => c.task_id === taskId && c.status === 'active' && claimKind(c) === 'verify' && c.reviewer_agent_id === agentId,
  );
  if (!hit) return;
  hit.status = 'completed';
  saveState(rc.file, rc.doc, rc.rev);
}

/**
 * Heartbeat fallback for gate work (smoke-test L9: RULE 7 was unsatisfiable for reviewers/verifiers):
 * extend the agent's active review/verify lease on the task by the review TTL.
 */
export function extendGateLease(
  runDir: string,
  runId: string,
  taskId: string,
  agentId: string,
): { claim_id: string; lease_until: string; kind: 'review' | 'verify' } | null {
  const rc = loadReviewClaims(runDir, runId);
  const hit = rc.doc.claims.find((c) => c.task_id === taskId && c.status === 'active' && c.reviewer_agent_id === agentId);
  if (!hit) return null;
  const run = readJsonState(join(runDir, 'run.json')).doc as { default_policy?: { review_ttl_minutes?: number } };
  const ttlMin = run.default_policy?.review_ttl_minutes ?? 20;
  const now = new Date();
  hit.lease_until = new Date(now.getTime() + ttlMin * 60_000).toISOString();
  saveState(rc.file, rc.doc, rc.rev);
  return { claim_id: hit.claim_id, lease_until: hit.lease_until, kind: claimKind(hit) };
}
