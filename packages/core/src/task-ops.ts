import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
import { failEnvelope, okEnvelope, type Envelope, type EnvelopeWarning } from './envelope.js';
import { withRunTx } from './tx.js';
import { resolveRunMode } from './mode.js';
import { appendEvent } from './events.js';
import { TASK_TYPES } from './payload.js';

export interface TaskAddOptions extends ResolveOptions {
  runId: string;
  task: {
    title?: string;
    type?: string;
    objective?: string;
    acceptance?: string[];
    depends_on?: string[]; // existing TASK-IDs
    paths?: { allow?: string[]; avoid?: string[]; requires_approval?: string[] };
    required_checks?: string[];
    suggested_role?: string;
    priority?: number;
    weight?: number;
    review?: { required?: boolean; focus?: string[] };
  };
}

export interface TaskCancelOptions extends ResolveOptions {
  runId: string;
  taskId: string;
  reason?: string;
}

export interface TaskDoneOptions extends ResolveOptions {
  runId: string;
  taskId: string;
  agentId: string;
  note?: string;
}

/** Lightweight completion: a claimed/in-progress task the completer holds may go straight to done. */
const DONE_FROM = new Set(['claimed', 'working', 'submitted']);

const id4 = (prefix: string, n: number) => `${prefix}-${String(n).padStart(4, '0')}`;

/** Task states a user may still cancel; integrated/done results are frozen (docs/15 §3.3). */
const CANCELLABLE = new Set(['draft', 'ready', 'claimed', 'working', 'blocked', 'submitted', 'reviewing', 'changes_requested', 'approved', 'verified']);

/** Delegates to the ONE transaction skeleton (core/tx.ts withRunTx; remediation E1). */
function openRunTx(opts: ResolveOptions & { runId: string }, startedAt: number, body: (runDir: string) => Envelope): Envelope {
  return withRunTx(opts, startedAt, (runDir) => body(runDir));
}

/**
 * Add one task to an existing run (docs/04 primitives; same shape as an import task,
 * with depends_on referencing existing TASK-IDs). Lands as draft — publish stays explicit.
 */
export function taskAdd(opts: TaskAddOptions): Envelope {
  const startedAt = Date.now();
  return openRunTx(opts, startedAt, (runDir) => {
    const run = readJsonState(join(runDir, 'run.json')).doc as { status: string };
    if (!['planned', 'active'].includes(run.status)) {
      return failEnvelope('invalid_transition', `Run ${opts.runId} is ${run.status}; task add needs planned or active.`, { startedAt });
    }

    const t = opts.task ?? {};
    const errors: string[] = [];
    if (!t.title || t.title.trim() === '') errors.push('title must not be empty');
    if (!t.objective || t.objective.trim() === '') errors.push('objective must not be empty');
    if (!t.acceptance || t.acceptance.length === 0) errors.push('acceptance needs at least one testable item');
    const type = t.type ?? 'implementation';
    if (!(TASK_TYPES as readonly string[]).includes(type)) errors.push(`type must be one of ${TASK_TYPES.join('/')}`);
    for (const g of [...(t.paths?.allow ?? []), ...(t.paths?.avoid ?? []), ...(t.paths?.requires_approval ?? [])]) {
      if (g.startsWith('/') || g.includes('..')) errors.push(`path glob must be repo-relative without ..: ${g}`);
    }
    const listFile = join(runDir, 'team-task-list.json');
    const list = readJsonState(listFile);
    const rows = (list.doc as { tasks: Array<Record<string, unknown> & { task_id: string }> }).tasks;
    const known = new Set(rows.map((r) => r.task_id));
    for (const dep of t.depends_on ?? []) {
      if (!known.has(dep)) errors.push(`depends_on references unknown task ${dep}`);
    }
    if (errors.length > 0) {
      return failEnvelope('schema_invalid', `Task draft failed ${errors.length} check(s).`, { data: { errors }, startedAt });
    }

    const countersFile = join(runDir, 'counters.json');
    const counters = readJsonState(countersFile);
    const cdoc = counters.doc as Record<string, unknown>;
    const taskNo = Number(cdoc.next_task ?? rows.length + 1);
    const taskId = id4('TASK', taskNo);
    const now = new Date().toISOString();

    const warnings: EnvelopeWarning[] = [];
    if ((t.paths?.allow ?? []).length === 0) warnings.push({ code: 'task_without_paths', message: `${taskId} has no paths.allow; path conflicts cannot protect it.` });
    if ((t.required_checks ?? []).length === 0) warnings.push({ code: 'task_without_checks', message: `${taskId} has no required_checks; its evidence gate will be weaker.` });

    const dir = join(runDir, 'tasks', taskId);
    mkdirSync(dir, { recursive: true });
    writeJsonStateNew(join(dir, 'task.json'), {
      schema_version: 'team.task.v1',
      run_id: opts.runId,
      task_id: taskId,
      client_task_key: null,
      title: t.title,
      type,
      status: 'draft',
      objective: t.objective,
      context: [],
      acceptance: t.acceptance,
      depends_on: t.depends_on ?? [],
      suggested_role: t.suggested_role ?? 'implementer',
      priority: t.priority ?? 50,
      weight: t.weight ?? 1,
      paths: t.paths ?? {},
      required_checks: t.required_checks ?? [],
      review: t.review ?? {},
      metadata: { created_by: 'user', created_at: now },
    });
    writeFileSync(join(dir, 'task.md'), `# ${taskId} ${t.title}\n\n## Objective\n\n${t.objective}\n\n## Acceptance\n\n${t.acceptance!.map((a) => `- ${a}`).join('\n')}\n`);

    rows.push({
      task_id: taskId,
      title: t.title,
      type,
      status: 'draft',
      priority: t.priority ?? 50,
      weight: t.weight ?? 1,
      role: t.suggested_role ?? 'implementer',
      depends_on: t.depends_on ?? [],
      owner_agent_id: null,
      claim_id: null,
      paths: t.paths ?? {},
      required_checks: t.required_checks ?? [],
      progress: 0,
      task_ref: `tasks/${taskId}/task.json`,
    });
    writeJsonStateAtomic(listFile, list.doc as Record<string, unknown>, { expectedRev: list.rev });

    const graphFile = join(runDir, 'task-graph.json');
    const graph = readJsonState(graphFile);
    const gdoc = graph.doc as { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
    gdoc.nodes.push({ task_id: taskId, title: t.title, type });
    let edgeNo = Number(cdoc.next_edge ?? gdoc.edges.length + 1);
    for (const dep of t.depends_on ?? []) {
      gdoc.edges.push({ edge_id: id4('EDGE', edgeNo++), from: dep, to: taskId, kind: 'blocks', required: true });
    }
    writeJsonStateAtomic(graphFile, graph.doc as Record<string, unknown>, { expectedRev: graph.rev });
    writeJsonStateAtomic(countersFile, { ...cdoc, next_task: taskNo + 1, next_edge: edgeNo }, { expectedRev: counters.rev });

    appendEvent(runDir, {
      event: 'task_created',
      actor: { type: 'user', id: 'user' },
      run_id: opts.runId,
      task_id: taskId,
      payload: { via: 'task_add' },
    });
    return okEnvelope({
      message: `${taskId} added as draft ("${t.title}").`,
      data: { task_id: taskId, status: 'draft' },
      warnings,
      nextActions: [`Publish it when ready: sigmarun task publish ${opts.runId} --tasks=${taskId}`],
      startedAt,
    });
  });
}

/** Cancel one task (docs/15 §3.3): live claims cascade to cancelled; integrated/done stay frozen. */
export function taskCancel(opts: TaskCancelOptions): Envelope {
  const startedAt = Date.now();
  return openRunTx(opts, startedAt, (runDir) => {
    const taskFile = join(runDir, 'tasks', opts.taskId, 'task.json');
    if (!existsSync(taskFile)) {
      return failEnvelope('task_not_found', `Task ${opts.taskId} does not exist on ${opts.runId}.`, { startedAt });
    }
    const task = readJsonState(taskFile);
    const status = (task.doc as { status: string }).status;
    if (!CANCELLABLE.has(status)) {
      return failEnvelope('invalid_transition', `Task ${opts.taskId} is ${status}; cancel applies before integration.`, { startedAt });
    }

    (task.doc as { status: string }).status = 'cancelled';
    writeJsonStateAtomic(taskFile, task.doc as Record<string, unknown>, { expectedRev: task.rev });
    const listFile = join(runDir, 'team-task-list.json');
    const list = readJsonState(listFile);
    const row = (list.doc as { tasks: Array<{ task_id: string; status: string; owner_agent_id: string | null; claim_id: string | null }> }).tasks.find(
      (r) => r.task_id === opts.taskId,
    );
    if (row) {
      row.status = 'cancelled';
      row.owner_agent_id = null;
      row.claim_id = null;
    }
    writeJsonStateAtomic(listFile, list.doc as Record<string, unknown>, { expectedRev: list.rev });

    const released: string[] = [];
    const LIVE = new Set(['active', 'submitted']);
    for (const rel of ['claims/task-claims.json', 'claims/path-claims.json', 'claims/review-claims.json']) {
      const file = join(runDir, rel);
      if (!existsSync(file)) continue;
      const state = readJsonState(file);
      let dirty = false;
      for (const c of ((state.doc as { claims?: Array<{ claim_id: string; task_id: string; status: string }> }).claims ?? [])) {
        if (c.task_id === opts.taskId && LIVE.has(c.status)) {
          c.status = 'cancelled';
          released.push(c.claim_id);
          dirty = true;
        }
      }
      if (dirty) writeJsonStateAtomic(file, state.doc as Record<string, unknown>, { expectedRev: state.rev });
    }

    appendEvent(runDir, {
      event: 'task_cancelled',
      actor: { type: 'user', id: 'user' },
      run_id: opts.runId,
      task_id: opts.taskId,
      payload: { released_claim_ids: released, reason: opts.reason ?? null },
    });
    // B6/S6: cancelled never satisfies any deps gate — name the tasks this cancel just orphaned.
    const orphaned = (list.doc as { tasks: Array<{ task_id: string; status: string; depends_on?: string[] }> }).tasks
      .filter((r) => !['done', 'cancelled', 'integrated'].includes(r.status) && (r.depends_on ?? []).includes(opts.taskId))
      .map((r) => r.task_id);
    return okEnvelope({
      message: `${opts.taskId} cancelled (was ${status}${opts.reason ? `; reason: ${opts.reason}` : ''}); ${released.length} claim(s) cascaded.`,
      data: { task_id: opts.taskId, released_claim_ids: released, reason: opts.reason ?? null, orphaned_dependents: orphaned },
      warnings: orphaned.length
        ? [{ code: 'deps_dead', message: `${orphaned.join(', ')} depend(s) on the cancelled task and can never unblock — cancel and re-add them without the dead dependency.` }]
        : [],
      startedAt,
    });
  });
}

/**
 * Lightweight completion (roadmap: lightweight mode). In a lightweight run — no review/verify/
 * integrate — the agent that claimed a task marks it done directly, trusting the completer (no
 * evidence gate). Refused in a full run, where `done` is reached through the report/accept path.
 */
export function taskDone(opts: TaskDoneOptions): Envelope {
  const startedAt = Date.now();
  return openRunTx(opts, startedAt, (runDir) => {
    const run = readJsonState(join(runDir, 'run.json')).doc as { lightweight?: boolean };
    if (!resolveRunMode(run).can.done) {
      return failEnvelope('mode_mismatch', `Run ${opts.runId} is not lightweight; a task reaches done through review/verify/integrate. Use the pipeline, or create the run with --lightweight.`, { startedAt });
    }
    const taskFile = join(runDir, 'tasks', opts.taskId, 'task.json');
    if (!existsSync(taskFile)) {
      return failEnvelope('task_not_found', `Task ${opts.taskId} does not exist on ${opts.runId}.`, { startedAt });
    }
    const task = readJsonState(taskFile);
    const status = (task.doc as { status: string }).status;
    if (!DONE_FROM.has(status)) {
      return failEnvelope('invalid_transition', `Task ${opts.taskId} is ${status}; done applies to a claimed/in-progress task.`, { startedAt });
    }

    // Only the claim holder completes it (the anti-collision guarantee extends to completion).
    const claimsFile = join(runDir, 'claims', 'task-claims.json');
    const held = existsSync(claimsFile)
      ? (readJsonState(claimsFile).doc as { claims: Array<{ task_id: string; agent_id: string; status: string; claim_id: string }> }).claims
          .find((c) => c.task_id === opts.taskId && ['active', 'submitted'].includes(c.status))
      : undefined;
    if (held && held.agent_id !== opts.agentId) {
      return failEnvelope('not_claim_owner', `Task ${opts.taskId} is held by ${held.agent_id}, not ${opts.agentId}.`, { startedAt });
    }

    (task.doc as { status: string }).status = 'done';
    writeJsonStateAtomic(taskFile, task.doc as Record<string, unknown>, { expectedRev: task.rev });
    const listFile = join(runDir, 'team-task-list.json');
    const list = readJsonState(listFile);
    const row = (list.doc as { tasks: Array<{ task_id: string; status: string; owner_agent_id: string | null; claim_id: string | null }> }).tasks.find((r) => r.task_id === opts.taskId);
    if (row) {
      row.status = 'done';
      row.owner_agent_id = null;
      row.claim_id = null;
    }
    writeJsonStateAtomic(listFile, list.doc as Record<string, unknown>, { expectedRev: list.rev });

    // release the claim(s) — the task is finished
    const released: string[] = [];
    for (const rel of ['claims/task-claims.json', 'claims/path-claims.json']) {
      const file = join(runDir, rel);
      if (!existsSync(file)) continue;
      const state = readJsonState(file);
      let dirty = false;
      for (const c of ((state.doc as { claims?: Array<{ claim_id: string; task_id: string; status: string }> }).claims ?? [])) {
        if (c.task_id === opts.taskId && ['active', 'submitted'].includes(c.status)) {
          c.status = rel.includes('task-claims') ? 'completed' : 'released';
          released.push(c.claim_id);
          dirty = true;
        }
      }
      if (dirty) writeJsonStateAtomic(file, state.doc as Record<string, unknown>, { expectedRev: state.rev });
    }

    appendEvent(runDir, {
      event: 'task_done',
      actor: { type: 'agent', id: opts.agentId },
      run_id: opts.runId,
      task_id: opts.taskId,
      payload: { via: 'done_command', ...(opts.note ? { note: opts.note } : {}) },
    });
    // D21: when this was the last open task, hand the closer the terminal command — the run
    // does not close itself (explicit ledger over implicit transitions).
    const rows = (list.doc as { tasks: Array<{ status: string }> }).tasks;
    const open = rows.filter((r) => !['done', 'cancelled'].includes(r.status)).length;
    return okEnvelope({
      message: `${opts.taskId} done (was ${status})${open === 0 ? '; every task is now closed' : ''}.`,
      data: { task_id: opts.taskId, released_claim_ids: released, open_tasks: open },
      nextActions: open === 0 ? [`Close the run: sigmarun report ${opts.runId}`] : [],
      startedAt,
    });
  });
}
