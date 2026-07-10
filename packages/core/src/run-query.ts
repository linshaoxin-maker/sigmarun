import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GatewayError, readJsonState, resolveTeamRoot, type ResolveOptions } from '@sigmarun/storage';
import { failEnvelope, okEnvelope, type Envelope } from './envelope.js';

export interface RunShowOptions extends ResolveOptions {
  runId: string;
}

/** Read-only run summary — dispatch flow step 1 (docs/19 §3.2); no lock, no event. */
export function runShow(opts: RunShowOptions): Envelope {
  const startedAt = Date.now();
  try {
    const resolved = resolveTeamRoot(opts);
    const runDir = join(resolved.teamRoot, 'runs', opts.runId);
    if (!existsSync(join(runDir, 'run.json'))) {
      return failEnvelope('run_not_found', `Run ${opts.runId} does not exist under .team/runs/.`, {
        nextActions: ['List runs by checking .team/runs/, or import one: sigmarun run import <payload.json>'],
        startedAt,
      });
    }
    const run = readJsonState(join(runDir, 'run.json')).doc as Record<string, unknown>;
    const list = readJsonState(join(runDir, 'team-task-list.json')).doc as {
      tasks: Array<{ task_id: string; title: string; status: string; owner_agent_id: string | null; claim_id: string | null; depends_on: string[] }>;
    };
    const counts: Record<string, number> = {};
    for (const t of list.tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
    return okEnvelope({
      message: `${opts.runId} is ${run.status as string}: ${list.tasks.length} task(s) — ${Object.entries(counts)
        .map(([s, n]) => `${n} ${s}`)
        .join(', ')}.`,
      data: {
        run: {
          run_id: run.run_id,
          status: run.status,
          title: run.title,
          mode: run.mode,
          goal: run.goal,
          base_branch: run.base_branch,
          policy: run.policy,
        },
        tasks: list.tasks.map((t) => ({
          task_id: t.task_id,
          title: t.title,
          status: t.status,
          owner_agent_id: t.owner_agent_id,
          claim_id: t.claim_id,
          depends_on: t.depends_on,
        })),
        counts,
      },
      startedAt,
    });
  } catch (err) {
    if (err instanceof GatewayError) return failEnvelope(err.code, err.message, { startedAt });
    throw err;
  }
}
