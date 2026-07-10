import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  GatewayError,
  acquireLock,
  readJsonState,
  resolveTeamRoot,
  writeJsonStateAtomic,
  type ResolveOptions,
} from '@sigmarun/storage';
import { failEnvelope, okEnvelope, type Envelope, type EnvelopeWarning } from './envelope.js';
import { appendEvent } from './events.js';

export interface PublishOptions extends ResolveOptions {
  runId: string;
  taskIds?: string[];
  force?: boolean;
}

/** Conservative glob-overlap: ancestor-prefix rule (docs/10 §8.2); full minimatch tier lands with FEAT-007 (file-vs-glob in_scope). */
function globPrefix(g: string): string {
  const i = g.search(/[*?[]/);
  return i === -1 ? g : g.slice(0, i);
}
export function pathsOverlapConservative(a: string, b: string): boolean {
  const pa = globPrefix(a);
  const pb = globPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

function collectAllowGlobs(runDir: string): string[] {
  const list = JSON.parse(readFileSync(join(runDir, 'team-task-list.json'), 'utf8')) as {
    tasks: Array<{ paths?: { allow?: string[] } }>;
  };
  return list.tasks.flatMap((t) => t.paths?.allow ?? []);
}

interface Overlap { other_run_id: string; globs: string[] }

function findCrossRunOverlaps(runsDir: string, selfRunId: string, selfGlobs: string[]): Overlap[] {
  const out: Overlap[] = [];
  if (!existsSync(runsDir)) return out;
  for (const entry of readdirSync(runsDir)) {
    if (entry === selfRunId) continue;
    const runFile = join(runsDir, entry, 'run.json');
    if (!existsSync(runFile)) continue;
    try {
      const status = (JSON.parse(readFileSync(runFile, 'utf8')) as { status: string }).status;
      if (status !== 'active' && status !== 'integrating') continue;
      const otherGlobs = collectAllowGlobs(join(runsDir, entry));
      const hit = new Set<string>();
      for (const a of selfGlobs) for (const b of otherGlobs) {
        if (pathsOverlapConservative(a, b)) { hit.add(a); hit.add(b); }
      }
      if (hit.size > 0) out.push({ other_run_id: entry, globs: [...hit].sort() });
    } catch { /* unreadable run.json -> audit territory, not a publish blocker */ }
  }
  return out;
}

/**
 * Publish draft tasks (draft -> ready); first publish activates the run.
 * @contract docs/15 §6 publish flow · §2.3 planned->active (run_activated) · §2.4 state gate · D18 cross-run policy (docs/16 §5)
 * @uc UC-002 · @bdd BDD-002-01..04
 */
export function publishTasks(opts: PublishOptions): Envelope {
  const startedAt = Date.now();
  let root;
  try {
    root = resolveTeamRoot(opts);
  } catch (e) {
    if (e instanceof GatewayError) return failEnvelope(e.code, e.message, { startedAt });
    return failEnvelope('io_error', String(e), { startedAt });
  }
  const runDir = join(root.teamRoot, 'runs', opts.runId);
  if (!existsSync(join(runDir, 'run.json'))) {
    return failEnvelope('run_not_found', `Run not found: ${opts.runId}`, { startedAt });
  }

  const release = (() => {
    try {
      return acquireLock(join(runDir, 'locks', 'run.lock'), { timeoutMs: 5000, staleMs: 30_000 });
    } catch (e) { return e as GatewayError; }
  })();
  if (release instanceof GatewayError) return failEnvelope(release.code, release.message, { startedAt });

  try {
    const run = readJsonState(join(runDir, 'run.json'));
    const runStatus = String(run.doc.status);
    if (runStatus !== 'planned' && runStatus !== 'active') {
      return failEnvelope('run_not_active', `Run ${opts.runId} is ${runStatus}; publish is allowed only in planned or active runs.`, {
        startedAt,
        nextActions: runStatus === 'paused' ? [`Resume first: sigmarun run resume ${opts.runId}`] : [`Inspect the run: .team/runs/${opts.runId}/run.json`],
      });
    }

    const listFile = join(runDir, 'team-task-list.json');
    const list = readJsonState(listFile);
    const rows = (list.doc.tasks as Array<Record<string, any>>);
    const known = new Set(rows.map((r) => String(r.task_id)));
    const targets = opts.taskIds ?? rows.map((r) => String(r.task_id));
    const missing = targets.filter((t) => !known.has(t));
    if (missing.length > 0) {
      return failEnvelope('task_not_found', `Unknown task id(s) in ${opts.runId}: ${missing.join(', ')}`, {
        startedAt,
        nextActions: [`List tasks: .team/runs/${opts.runId}/team-task-list.json`],
      });
    }

    const warnings: EnvelopeWarning[] = [];
    const policy = (run.doc.default_policy as Record<string, unknown> | undefined) ?? {};
    const crossPolicy = String(policy.cross_run_path_policy ?? 'warn');
    const selfGlobs = rows
      .filter((r) => targets.includes(String(r.task_id)) || r.status === 'ready')
      .flatMap((r) => (r.paths?.allow as string[] | undefined) ?? []);
    const overlaps = findCrossRunOverlaps(join(root.teamRoot, 'runs'), opts.runId, selfGlobs);
    if (overlaps.length > 0) {
      if (crossPolicy === 'block' && !opts.force) {
        return failEnvelope('cross_run_conflict', `Path scopes overlap with active run(s): ${overlaps.map((o) => o.other_run_id).join(', ')}.`, {
          startedAt,
          data: { overlaps },
          nextActions: ['Narrow this run\'s paths.allow.', 'Wait for the other run to finish.', 'Pass --force to publish anyway.'],
        });
      }
      warnings.push({
        code: 'cross_run_overlap',
        message: `paths overlap with ${overlaps.map((o) => o.other_run_id).join(', ')}; cross-run claims are not hard-checked (D7/D18).`,
      });
    }

    const published: string[] = [];
    for (const row of rows) {
      const id = String(row.task_id);
      if (!targets.includes(id)) continue;
      if (row.status !== 'draft') {
        warnings.push({ code: 'already_ready', message: `${id} is ${row.status}; skipped.` });
        continue;
      }
      const taskFile = join(runDir, 'tasks', id, 'task.json');
      const task = readJsonState(taskFile);
      writeJsonStateAtomic(taskFile, { ...task.doc, status: 'ready' }, { expectedRev: task.rev });
      row.status = 'ready';
      published.push(id);
    }
    if (published.length > 0) {
      writeJsonStateAtomic(listFile, { ...list.doc, tasks: rows }, { expectedRev: list.rev });
    }

    let runStatusAfter = runStatus;
    if (runStatus === 'planned' && published.length > 0) {
      const runNow = readJsonState(join(runDir, 'run.json'));
      writeJsonStateAtomic(join(runDir, 'run.json'), { ...runNow.doc, status: 'active' }, { expectedRev: runNow.rev });
      runStatusAfter = 'active';
    }

    const actor = { type: 'user' as const, id: 'user' };
    for (const o of overlaps) {
      appendEvent(runDir, {
        event: 'cross_run_overlap_detected', actor: { type: 'policy', id: 'policy' }, run_id: opts.runId,
        payload: { other_run_id: o.other_run_id, overlapping_globs: o.globs },
      });
    }
    for (const id of published) {
      appendEvent(runDir, { event: 'task_published', actor, run_id: opts.runId, task_id: id, payload: { rev_after: { task_list: list.rev + 1 } } });
    }
    if (runStatus === 'planned' && published.length > 0) {
      appendEvent(runDir, { event: 'run_activated', actor, run_id: opts.runId, payload: { published_count: published.length } });
    }

    return okEnvelope({
      startedAt,
      message: published.length > 0
        ? `Published ${published.length} task(s) in ${opts.runId}; run is ${runStatusAfter}.`
        : `Nothing to publish in ${opts.runId}.`,
      data: { run_id: opts.runId, published: published.length, task_ids: published, run_status: runStatusAfter },
      warnings,
      nextActions: published.length > 0 ? [`Dispatch an agent: /team-dispatch ${opts.runId}`] : [],
    });
  } catch (e) {
    if (e instanceof GatewayError) return failEnvelope(e.code, e.message, { startedAt });
    return failEnvelope('io_error', String(e), { startedAt });
  } finally {
    release();
  }
}
