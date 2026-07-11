import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GatewayError,
  tryAcquireLock,
  runLockPath,
  readJsonState,
  resolveTeamRoot,
  writeJsonStateAtomic,
  writeJsonStateNew,
  type ResolveOptions,
} from '@sigmarun/storage';
import { failEnvelope, okEnvelope, type Envelope } from './envelope.js';
import { appendEvent, readEventsSafe } from './events.js';

export interface IntegrateStartOptions extends ResolveOptions {
  runId: string;
}

export interface IntegrateRecordOptions extends ResolveOptions {
  runId: string;
  taskId: string;
  mergeCommit?: string;
  failed?: boolean;
  reason?: string;
}

interface Row {
  task_id: string;
  status: string;
  priority: number;
  depends_on: string[];
}

function withLock(opts: ResolveOptions & { runId: string }, startedAt: number, body: (runDir: string) => Envelope): Envelope {
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
  const release = tryAcquireLock(runLockPath(runDir));
  if (release instanceof GatewayError) return failEnvelope(release.code, release.message, { startedAt });
  try {
    return body(runDir);
  } catch (err) {
    if (err instanceof GatewayError) return failEnvelope(err.code, err.message, { startedAt });
    throw err;
  } finally {
    release();
  }
}

/** Deterministic merge order: topo over blocks edges within the verified set, then priority desc, task_id asc (16 §4.2). */
function mergeOrder(runDir: string, verified: Row[]): string[] {
  const inSet = new Set(verified.map((r) => r.task_id));
  const graph = readJsonState(join(runDir, 'task-graph.json')).doc as { edges?: Array<{ from: string; to: string; kind: string }> };
  const indeg = new Map<string, number>(verified.map((r) => [r.task_id, 0]));
  const adj = new Map<string, string[]>();
  for (const e of (graph.edges ?? []).filter((e) => e.kind === 'blocks' && inSet.has(e.from) && inSet.has(e.to))) {
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
  }
  const byId = new Map(verified.map((r) => [r.task_id, r]));
  const ready = () =>
    [...indeg.entries()]
      .filter(([, d]) => d === 0)
      .map(([id]) => byId.get(id)!)
      .sort((a, b) => b.priority - a.priority || a.task_id.localeCompare(b.task_id));
  const order: string[] = [];
  while (indeg.size > 0) {
    const next = ready()[0];
    if (!next) break; // cycle would have been rejected at import; safety valve
    order.push(next.task_id);
    indeg.delete(next.task_id);
    for (const to of adj.get(next.task_id) ?? []) indeg.set(to, (indeg.get(to) ?? 1) - 1);
  }
  return order;
}

export function integrateStart(opts: IntegrateStartOptions): Envelope {
  const startedAt = Date.now();
  return withLock(opts, startedAt, (runDir) => {
    const runFile = join(runDir, 'run.json');
    const run = readJsonState(runFile);
    const rdoc = run.doc as { status: string; base_branch?: string };
    if (rdoc.status !== 'active' && rdoc.status !== 'integrating') {
      return failEnvelope('invalid_transition', `Run ${opts.runId} is ${rdoc.status}; integrate starts from active.`, { startedAt });
    }
    const rows = (readJsonState(join(runDir, 'team-task-list.json')).doc as { tasks: Row[] }).tasks;
    const verified = rows.filter((r) => r.status === 'verified');
    if (verified.length === 0) {
      return failEnvelope('invalid_transition', `Run ${opts.runId} has no verified task to integrate.`, {
        nextActions: [`Check the pipeline: sigmarun status ${opts.runId}`],
        startedAt,
      });
    }
    const order = mergeOrder(runDir, verified);
    const worktrees = existsSync(join(runDir, 'worktrees.json'))
      ? (readJsonState(join(runDir, 'worktrees.json')).doc as { entries: Array<{ task_id: string; branch: string }> }).entries
      : [];
    const branchOf = (t: string) => worktrees.find((w) => w.task_id === t)?.branch ?? `team/${opts.runId}/${t}`;

    if (rdoc.status !== 'integrating') {
      rdoc.status = 'integrating';
      writeJsonStateAtomic(runFile, run.doc as Record<string, unknown>, { expectedRev: run.rev });
      appendEvent(runDir, {
        event: 'integration_started',
        actor: { type: 'user', id: 'integrator' },
        run_id: opts.runId,
        payload: {},
      });
    }
    const branch = `team/${opts.runId}/integration`;
    return okEnvelope({
      message: `Integration order for ${opts.runId}: ${order.join(' -> ')} onto ${branch}.`,
      data: {
        branch,
        base_branch: rdoc.base_branch ?? 'main',
        merge_order: order.map((t) => ({
          task_id: t,
          branch: branchOf(t),
          command: `git merge --no-ff ${branchOf(t)}`,
        })),
      },
      nextActions: [
        `Create the branch: git checkout -b ${branch} ${rdoc.base_branch ?? 'main'}`,
        `Merge in order; after each: sigmarun integrate record ${opts.runId} <TASK-ID> --merge-commit=<sha> (or --failed --reason=...)`,
      ],
      startedAt,
    });
  });
}

export function integrateRecord(opts: IntegrateRecordOptions): Envelope {
  const startedAt = Date.now();
  return withLock(opts, startedAt, (runDir) => {
    const run = readJsonState(join(runDir, 'run.json')).doc as { status: string };
    if (run.status !== 'integrating') {
      return failEnvelope('invalid_transition', `Run ${opts.runId} is ${run.status}; start integration first.`, { startedAt });
    }
    const taskFile = join(runDir, 'tasks', opts.taskId, 'task.json');
    if (!existsSync(taskFile)) {
      return failEnvelope('task_not_found', `Task ${opts.taskId} does not exist on ${opts.runId}.`, { startedAt });
    }
    const task = readJsonState(taskFile);
    const status = (task.doc as { status: string }).status;
    if (status !== 'verified') {
      return failEnvelope('invalid_transition', `Task ${opts.taskId} is ${status}; integrate record targets verified tasks.`, { startedAt });
    }

    const listFile = join(runDir, 'team-task-list.json');
    const list = readJsonState(listFile);
    const row = (list.doc as { tasks: Array<{ task_id: string; status: string }> }).tasks.find((r) => r.task_id === opts.taskId);

    if (opts.failed) {
      // Minimal VERIFY record keeps event #38's verify_id contract honest.
      const countersFile = join(runDir, 'counters.json');
      const counters = readJsonState(countersFile);
      const cdoc = counters.doc as Record<string, unknown>;
      const n = Number(cdoc.next_verify ?? 1);
      const verifyId = `VERIFY-${String(n).padStart(4, '0')}`;
      writeJsonStateNew(join(runDir, 'verification', `${verifyId}.json`), {
        schema_version: 'team.verification.v1',
        verify_id: verifyId,
        run_id: opts.runId,
        target: { kind: 'task', task_id: opts.taskId },
        verifier_agent_id: 'integrator',
        executed_at: new Date().toISOString(),
        checks: [],
        gates: {
          build: 'skipped',
          focused_tests: 'fail',
          regression_tests: 'skipped',
          scope_check: 'skipped',
          evidence_complete: 'skipped',
        },
        skip_reasons: {
          build: 'integration merge check',
          regression_tests: 'integration merge check',
          scope_check: 'integration merge check',
          evidence_complete: 'integration merge check',
        },
        verdict: 'fail',
        failures_mapped: [opts.taskId],
        reason: opts.reason ?? 'merge checks failed',
      });
      writeJsonStateAtomic(countersFile, { ...cdoc, next_verify: n + 1 }, { expectedRev: counters.rev });

      (task.doc as { status: string }).status = 'changes_requested';
      writeJsonStateAtomic(taskFile, task.doc as Record<string, unknown>, { expectedRev: task.rev });
      if (row) row.status = 'changes_requested';
      writeJsonStateAtomic(listFile, list.doc as Record<string, unknown>, { expectedRev: list.rev });
      const claimsFile = join(runDir, 'claims', 'task-claims.json');
      if (existsSync(claimsFile)) {
        const claims = readJsonState(claimsFile);
        const owner = (claims.doc as { claims: Array<{ task_id: string; status: string; lease_until: string }> }).claims.find(
          (c) => c.task_id === opts.taskId && c.status === 'submitted',
        );
        if (owner) {
          const runPolicy = readJsonState(join(runDir, 'run.json')).doc as { default_policy?: { claim_ttl_minutes?: number } };
          owner.status = 'active';
          owner.lease_until = new Date(Date.now() + (runPolicy.default_policy?.claim_ttl_minutes ?? 30) * 60_000).toISOString();
          writeJsonStateAtomic(claimsFile, claims.doc as Record<string, unknown>, { expectedRev: claims.rev });
        }
      }
      appendEvent(runDir, {
        event: 'verification_failed',
        actor: { type: 'agent', id: 'integrator' },
        run_id: opts.runId,
        task_id: opts.taskId,
        payload: { verify_id: verifyId, failures_mapped: [opts.taskId], reason: opts.reason ?? 'merge checks failed' },
      });
      return okEnvelope({
        message: `${opts.taskId} reverted out of the integration; back to changes_requested (integration continues).`,
        data: { task_id: opts.taskId, verify_id: verifyId },
        startedAt,
      });
    }

    if (!opts.mergeCommit) {
      return failEnvelope('usage_error', 'integrate record needs --merge-commit=<sha> (or --failed --reason=...).', { startedAt });
    }
    (task.doc as { status: string }).status = 'integrated';
    writeJsonStateAtomic(taskFile, task.doc as Record<string, unknown>, { expectedRev: task.rev });
    if (row) row.status = 'integrated';
    writeJsonStateAtomic(listFile, list.doc as Record<string, unknown>, { expectedRev: list.rev });

    // 15 §4.2: hold ends at integrated — release the task's path claims AND close the
    // owner's task claim (an integrated task with a live claim is AUD-009 residue).
    const releasedIds: string[] = [];
    const pathFile = join(runDir, 'claims', 'path-claims.json');
    if (existsSync(pathFile)) {
      const pc = readJsonState(pathFile);
      for (const c of (pc.doc as { claims: Array<{ task_id: string; status: string; claim_id: string }> }).claims) {
        if (c.task_id === opts.taskId && c.status === 'active') {
          c.status = 'released';
          releasedIds.push(c.claim_id);
        }
      }
      writeJsonStateAtomic(pathFile, pc.doc as Record<string, unknown>, { expectedRev: pc.rev });
    }
    const taskClaimsFile = join(runDir, 'claims', 'task-claims.json');
    if (existsSync(taskClaimsFile)) {
      const tc = readJsonState(taskClaimsFile);
      let dirty = false;
      for (const c of (tc.doc as { claims: Array<{ task_id: string; status: string; claim_id: string }> }).claims) {
        if (c.task_id === opts.taskId && ['active', 'submitted'].includes(c.status)) {
          c.status = 'completed';
          releasedIds.push(c.claim_id);
          dirty = true;
        }
      }
      if (dirty) writeJsonStateAtomic(taskClaimsFile, tc.doc as Record<string, unknown>, { expectedRev: tc.rev });
    }
    appendEvent(runDir, {
      event: 'task_integrated',
      actor: { type: 'agent', id: 'integrator' },
      run_id: opts.runId,
      task_id: opts.taskId,
      payload: { merge_commit: opts.mergeCommit, released_claim_ids: releasedIds },
    });
    return okEnvelope({
      message: `${opts.taskId} integrated at ${opts.mergeCommit}; ${releasedIds.length} path claim(s) released.`,
      data: { task_id: opts.taskId, merge_commit: opts.mergeCommit, released_claim_ids: releasedIds },
      startedAt,
    });
  });
}

export function reportRun(opts: IntegrateStartOptions): Envelope {
  const startedAt = Date.now();
  return withLock(opts, startedAt, (runDir) => {
    const runFile = join(runDir, 'run.json');
    const run = readJsonState(runFile);
    const rdoc = run.doc as { status: string; title?: string; goal?: string };
    if (rdoc.status !== 'integrating') {
      return failEnvelope('invalid_transition', `Run ${opts.runId} is ${rdoc.status}; report follows integration.`, { startedAt });
    }
    const rows = (readJsonState(join(runDir, 'team-task-list.json')).doc as { tasks: Array<{ task_id: string; title: string; status: string }> }).tasks;
    const remaining = rows.filter((r) => r.status === 'verified');
    if (remaining.length > 0) {
      return failEnvelope('invalid_transition', `${remaining.length} verified task(s) still await integrate record: ${remaining.map((r) => r.task_id).join(', ')}.`, { startedAt });
    }

    const events = readEventsSafe(runDir).events;
    const integrated = events.filter((e) => e.event === 'task_integrated');
    const reverted = events.filter((e) => e.event === 'verification_failed' && e.payload?.reason);
    const integrationMd = [
      `# Integration — ${opts.runId}`,
      '',
      '## Merged',
      ...integrated.map((e) => `- ${e.task_id} @ ${e.payload?.merge_commit as string}`),
      '',
      '## Reverted / not merged',
      ...(reverted.length > 0 ? reverted.map((e) => `- ${e.task_id}: ${e.payload?.reason as string}`) : ['- (none)']),
      '',
      `> Integration branch: team/${opts.runId}/integration — merge to main via your normal PR flow (the gateway never touches git).`,
      '',
    ].join('\n');
    writeFileSync(join(runDir, 'integration.md'), integrationMd, 'utf8');

    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const reportMd = [
      `# Run report — ${opts.runId}`,
      '',
      `Goal: ${rdoc.goal ?? rdoc.title ?? ''}`,
      '',
      `Tasks: ${rows.length} — ${Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ')}`,
      `Integrated: ${integrated.length} · Reverted: ${reverted.length}`,
      '',
      '## Task outcomes',
      ...rows.map((r) => `- ${r.task_id} ${r.title}: ${r.status}`),
      '',
      'See integration.md for merge details and evidence/ for per-task records.',
      '',
    ].join('\n');
    writeFileSync(join(runDir, 'report.md'), reportMd, 'utf8');

    rdoc.status = 'reported';
    writeJsonStateAtomic(runFile, run.doc as Record<string, unknown>, { expectedRev: run.rev });
    appendEvent(runDir, {
      event: 'run_reported',
      actor: { type: 'user', id: 'integrator' },
      run_id: opts.runId,
      payload: { report_ref: 'report.md' },
    });
    return okEnvelope({
      message: `Run ${opts.runId} reported: ${integrated.length} integrated, ${reverted.length} reverted. Report at .team/runs/${opts.runId}/report.md.`,
      data: { report_ref: 'report.md', integrated: integrated.length, reverted: reverted.length },
      nextActions: [`Archive the artifacts: sigmarun export ${opts.runId}`],
      startedAt,
    });
  });
}
