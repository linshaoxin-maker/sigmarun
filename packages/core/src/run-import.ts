import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  GatewayError,
  tryAcquireLock,
  readJsonState,
  resolveTeamRoot,
  writeJsonStateAtomic,
  writeJsonStateNew,
  type ResolveOptions,
} from '@sigmarun/storage';
import { failEnvelope, okEnvelope, type Envelope, type EnvelopeWarning } from './envelope.js';
import { assertGatewayWritable } from './tx.js';
import { appendEvent, type EventActor } from './events.js';
import { payloadHash, validatePayload, type PlanPayload } from './payload.js';

export interface ImportOptions extends ResolveOptions {
  payload: unknown;
  force?: boolean;
  /** lightweight run: tasks immediately claimable, no review/verify/integrate, `done` completes directly */
  lightweight?: boolean;
}

const id4 = (prefix: string, n: number) => `${prefix}-${String(n).padStart(4, '0')}`;

function findDuplicateRun(runsDir: string, hash: string): string | null {
  if (!existsSync(runsDir)) return null;
  for (const entry of readdirSync(runsDir)) {
    const runFile = join(runsDir, entry, 'run.json');
    if (!existsSync(runFile)) continue;
    try {
      const doc = JSON.parse(readFileSync(runFile, 'utf8'));
      if (doc?.source?.payload_hash === hash) return entry;
    } catch { /* unreadable run.json is an audit concern, not a dedup match */ }
  }
  return null;
}

function taskMd(t: { title: string; objective: string; context?: string[]; acceptance: string[]; paths?: { allow?: string[]; avoid?: string[] }; required_checks?: string[] }, taskId: string): string {
  const sec = (name: string, items?: string[]) => (items?.length ? `\n## ${name}\n\n${items.map((i) => `- ${i}`).join('\n')}\n` : '');
  return `# ${taskId} ${t.title}\n\n## Objective\n\n${t.objective}\n${sec('Context', t.context)}${sec('Acceptance', t.acceptance)}${sec('Allow', t.paths?.allow)}${sec('Avoid', t.paths?.avoid)}${sec('Required checks', t.required_checks)}`;
}

/**
 * Import a plan payload: validate, assign ids, persist, then commit via events.
 * @contract docs/09 §6–8 import flow · docs/17 §5.3 write order (events last) · docs/17 §6 id formats · D17 fingerprint dedup
 * @uc UC-001 · @bdd BDD-001-01..05 · @aud AUD-021 inline
 */
export function importRun(opts: ImportOptions): Envelope {
  const startedAt = Date.now();
  let root;
  try {
    root = resolveTeamRoot(opts);
  } catch (e) {
    if (e instanceof GatewayError) return failEnvelope(e.code, e.message, { startedAt });
    return failEnvelope('io_error', String(e), { startedAt });
  }
  if (!existsSync(join(root.teamRoot, 'project.json'))) {
    return failEnvelope('team_root_not_found', 'This repository is not initialized for sigmarun.', { startedAt });
  }
  // The write gate outranks every business answer — an outdated gateway must not even learn
  // whether its payload is a duplicate; the only truthful reply is "upgrade first".
  const tooOld = assertGatewayWritable(root.teamRoot);
  if (tooOld) return failEnvelope(tooOld.code, tooOld.message, { startedAt });

  const { errors, warnings, payload } = validatePayload(opts.payload);
  if (errors.length > 0 || !payload) {
    return failEnvelope('schema_invalid', `Payload failed validation with ${errors.length} error(s).`, {
      startedAt,
      data: { errors },
      nextActions: ['Fix the listed payload fields and re-run `sigmarun run import`.'],
    });
  }

  const hash = payloadHash(opts.payload);
  const runsDir = join(root.teamRoot, 'runs');
  if (!opts.force) {
    const dup = findDuplicateRun(runsDir, hash);
    if (dup) {
      return failEnvelope('duplicate_payload', `Identical payload already imported as ${dup}.`, {
        startedAt,
        nextActions: [`Inspect the existing run: .team/runs/${dup}/plan.md`, 'Pass --force to import a duplicate run on purpose.'],
      });
    }
  }

  const release = tryAcquireLock(join(root.teamRoot, 'locks', 'project.lock'));
  if (release instanceof GatewayError) return failEnvelope(release.code, release.message, { startedAt });

  let runDir = '';
  const lightweight = Boolean(opts.lightweight);
  try {
    // Re-check dedup INSIDE the lock: two identical concurrent imports both passed the pre-lock
    // check, so without this they would each create a run (concurrency review Finding 3).
    if (!opts.force) {
      const dup = findDuplicateRun(runsDir, hash);
      if (dup) {
        release();
        return failEnvelope('duplicate_payload', `Identical payload already imported as ${dup}.`, {
          startedAt,
          nextActions: [`Inspect the existing run: .team/runs/${dup}/plan.md`, 'Pass --force to import a duplicate run on purpose.'],
        });
      }
    }
    const countersFile = join(root.teamRoot, 'counters.json');
    const counters = readJsonState(countersFile);
    const runNo = Number(counters.doc.next_run ?? 1);
    const runId = id4('RUN', runNo);
    runDir = join(runsDir, runId);
    mkdirSync(join(runDir, 'tasks'), { recursive: true });
    mkdirSync(join(runDir, 'context'), { recursive: true });
    mkdirSync(join(runDir, 'locks'), { recursive: true });

    const project = readJsonState(join(root.teamRoot, 'project.json')).doc as Record<string, any>;
    const publication = payload.publication ?? {};
    // Lightweight runs have no verification, so "no required_checks; verification will be unclear"
    // is noise — drop it. Path warnings still matter (claims use paths).
    const moreWarnings: EnvelopeWarning[] = (lightweight ? warnings.filter((w) => w.code !== 'task_without_checks') : warnings).slice();
    if (publication.initial_status === 'ready') {
      moreWarnings.push({ code: 'publication_downgraded', message: 'initial_status "ready" downgraded to "draft"; publishing is an explicit user action: sigmarun task publish <RUN-ID>.' });
    }

    const keyToId = new Map<string, string>();
    payload.tasks.forEach((t, i) => keyToId.set(t.client_task_key, id4('TASK', i + 1)));
    const mapDeps = (deps?: string[]) => (deps ?? []).map((d) => keyToId.get(d)!);

    const now = new Date().toISOString();
    const actor: EventActor = payload.source.agent_id
      ? { type: 'agent', id: payload.source.agent_id }
      : { type: 'user', id: 'user' };

    for (const t of payload.tasks) {
      const taskId = keyToId.get(t.client_task_key)!;
      const dir = join(runDir, 'tasks', taskId);
      mkdirSync(dir, { recursive: true });
      writeJsonStateNew(join(dir, 'task.json'), {
        schema_version: 'team.task.v1',
        run_id: runId,
        task_id: taskId,
        client_task_key: t.client_task_key,
        title: t.title,
        type: t.type,
        status: lightweight ? 'ready' : 'draft',
        objective: t.objective,
        context: t.context ?? [],
        acceptance: t.acceptance,
        depends_on: mapDeps(t.depends_on),
        suggested_role: t.suggested_role ?? 'implementer',
        priority: t.priority ?? 50,
        weight: t.weight ?? 1,
        paths: t.paths ?? {},
        required_checks: t.required_checks ?? [],
        review: t.review ?? {}, // absent = inherit run policy; explicit true overrides run-level false (docs/15 §9)
        metadata: { created_by: actor.id, created_at: now },
      });
      writeFileSync(join(dir, 'task.md'), taskMd(t, taskId));
    }

    writeJsonStateNew(join(runDir, 'team-task-list.json'), {
      schema_version: 'team.task_list.v1',
      run_id: runId,
      tasks: payload.tasks.map((t) => ({
        task_id: keyToId.get(t.client_task_key)!,
        title: t.title,
        type: t.type,
        status: lightweight ? 'ready' : 'draft',
        priority: t.priority ?? 50,
        weight: t.weight ?? 1,
        role: t.suggested_role ?? 'implementer',
        depends_on: mapDeps(t.depends_on),
        owner_agent_id: null,
        claim_id: null,
        paths: t.paths ?? {},
        required_checks: t.required_checks ?? [],
        progress: 0,
        task_ref: `tasks/${keyToId.get(t.client_task_key)!}/task.json`,
      })),
    });

    const edges: Array<Record<string, unknown>> = [];
    let edgeNo = 1;
    payload.tasks.forEach((t) => mapDeps(t.depends_on).forEach((dep) => {
      edges.push({ edge_id: id4('EDGE', edgeNo++), from: dep, to: keyToId.get(t.client_task_key)!, kind: 'blocks', required: true });
    }));
    (payload.task_graph ?? []).filter((e) => e.kind !== 'blocks').forEach((e) => {
      edges.push({ edge_id: id4('EDGE', edgeNo++), from: keyToId.get(e.from)!, to: keyToId.get(e.to)!, kind: e.kind, required: false });
    });
    writeJsonStateNew(join(runDir, 'task-graph.json'), {
      schema_version: 'team.task_graph.v1',
      run_id: runId,
      nodes: payload.tasks.map((t) => ({ task_id: keyToId.get(t.client_task_key)!, title: t.title, type: t.type })),
      edges,
    });

    writeJsonStateNew(join(runDir, 'run.json'), {
      schema_version: 'team.run.v1',
      run_id: runId,
      title: payload.run.title,
      mode: payload.run.mode,
      status: lightweight ? 'active' : 'planned',
      lightweight,
      goal: payload.run.goal,
      created_at: now,
      created_by: { tool: payload.source.tool, agent_id: payload.source.agent_id ?? null },
      source: { tool: payload.source.tool, command: payload.source.command, prompt: payload.source.prompt, payload_hash: hash },
      base_branch: payload.run.base_branch ?? project.default_base_branch ?? 'main',
      worktree_root: `${project.default_worktree_root ?? `../.team-worktrees/${basename(root.repoRoot)}`}/${runId}`,
      default_policy: {
        claim_ttl_minutes: 30,
        max_parallel_tasks: 4,
        require_review: !lightweight,
        require_verification: !lightweight,
        path_conflict_policy: 'block',
        reclaim_policy: { auto_after_ttl_multiple: 3 },
        path_release_on_submit: 'hold',
        max_active_claims_per_agent: 1,
        cross_run_path_policy: 'warn',
        ...(payload.run.policy ?? {}),
      },
    });

    const plan = payload.plan as Record<string, any>;
    const planSec = (name: string, items?: string[]) => (items?.length ? `\n## ${name}\n\n${items.map((i: string) => `- ${i}`).join('\n')}\n` : '');
    writeFileSync(join(runDir, 'plan.md'),
      `# ${runId} ${payload.run.title}\n\n${plan.summary}\n${planSec('Assumptions', plan.assumptions)}${planSec('Non-goals', plan.non_goals)}${planSec('Risks', plan.risks)}`);
    writeFileSync(join(runDir, 'context', 'run-memory.md'),
      `# ${runId} memory\n\n## Goal\n\n${payload.run.goal}\n\n## Recently completed\n\n(none yet)\n\n## Open questions\n\n(none yet)\n`);

    writeJsonStateNew(join(runDir, 'counters.json'), {
      schema_version: 'team.counters.v1',
      next_task: payload.tasks.length + 1,
      next_claim: 1,
      next_msg: 1,
      next_edge: edgeNo,
      next_review: 1,
      next_verify: 1,
    });

    writeJsonStateAtomic(countersFile, { ...counters.doc, next_run: runNo + 1 }, { expectedRev: counters.rev });

    appendEvent(runDir, {
      event: 'run_created', actor, run_id: runId,
      payload: { mode: payload.run.mode, task_count: payload.tasks.length, rev_after: { project_counters: counters.rev + 1, task_list: 1, run: 1 } },
    });
    for (const t of payload.tasks) {
      appendEvent(runDir, { event: 'task_created', actor, run_id: runId, task_id: keyToId.get(t.client_task_key)!, payload: {} });
    }
    if (lightweight) {
      // tasks are born claimable and the run is active — mirror publish's events so the fold matches
      for (const t of payload.tasks) {
        appendEvent(runDir, { event: 'task_published', actor, run_id: runId, task_id: keyToId.get(t.client_task_key)!, payload: { via: 'lightweight_import' } });
      }
      appendEvent(runDir, { event: 'run_activated', actor, run_id: runId, payload: { via: 'lightweight_import', published_count: payload.tasks.length } });
    }

    return okEnvelope({
      startedAt,
      message: lightweight
        ? `Imported ${runId} with ${payload.tasks.length} task(s), claimable now (lightweight).`
        : `Imported ${runId} with ${payload.tasks.length} task(s) in draft.`,
      data: {
        run_id: runId,
        status: lightweight ? 'active' : 'draft',
        lightweight,
        task_count: payload.tasks.length,
        task_id_map: payload.tasks.map((t) => ({ client_task_key: t.client_task_key, task_id: keyToId.get(t.client_task_key)!, title: t.title })),
      },
      warnings: moreWarnings,
      nextActions: lightweight
        ? [`Any tool claims a task: sigmarun claim-next ${runId} --agent=<name>`]
        : [`Review .team/runs/${runId}/plan.md`, `Publish when ready: sigmarun task publish ${runId}`],
    });
  } catch (e) {
    if (runDir) rmSync(runDir, { recursive: true, force: true });
    if (e instanceof GatewayError) return failEnvelope(e.code, e.message, { startedAt });
    return failEnvelope('io_error', `Import failed and was rolled back: ${String(e)}`, { startedAt });
  } finally {
    release();
  }
}
