import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GatewayError, readJsonState, resolveTeamRoot, type ResolveOptions } from '@sigmarun/storage';
import { failEnvelope, okEnvelope, type Envelope } from './envelope.js';
import { readEventsSafe, type LedgerEvent } from './events.js';

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
          policy: run.default_policy,
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

export interface EventsReadOptions extends ResolveOptions {
  runId: string;
  /** filter to one task's events */
  task?: string;
  /** filter to one event kind */
  type?: string;
  /** only events with seq strictly greater than this (incremental tail/poll) */
  since?: number;
  /** most-recent N events to return (0 = all); default 50 */
  limit?: number;
}

/**
 * Read-only ledger reader — the events.jsonl append-only log is the run's source of truth, and this
 * makes it observable without cat-ing raw JSONL. No lock, no event (a query never mutates). Tolerates
 * a torn tail via readEventsSafe and surfaces it as corrupt_lines + a warning (ledger health is
 * itself a signal). --json carries the complete events (incl. payload); the human timeline is compact.
 */
export function readEvents(opts: EventsReadOptions): Envelope {
  const startedAt = Date.now();
  try {
    const resolved = resolveTeamRoot(opts);
    const runDir = join(resolved.teamRoot, 'runs', opts.runId);
    if (!existsSync(join(runDir, 'run.json'))) {
      return failEnvelope('run_not_found', `Run ${opts.runId} does not exist under .team/runs/.`, {
        nextActions: ['List runs: sigmarun run list'],
        startedAt,
      });
    }
    const { events, corrupt_lines } = readEventsSafe(runDir);
    let matched = events;
    if (opts.task) matched = matched.filter((e) => e.task_id === opts.task);
    if (opts.type) matched = matched.filter((e) => e.event === opts.type);
    if (typeof opts.since === 'number') matched = matched.filter((e) => typeof e.seq === 'number' && e.seq > opts.since!);

    const total = matched.length;
    const limit = opts.limit ?? 50;
    const shown = limit > 0 ? matched.slice(-limit) : matched; // most-recent window, still ascending by seq
    const view = shown.map((e: LedgerEvent) => ({
      seq: e.seq,
      ts: typeof e.ts === 'string' ? e.ts : null,
      event: e.event,
      actor: e.actor ?? { type: 'unknown', id: 'unknown' },
      task_id: e.task_id ?? null,
      claim_id: e.claim_id ?? null,
      payload: e.payload ?? {},
    }));

    const filterBits = [
      opts.task ? `task=${opts.task}` : null,
      opts.type ? `type=${opts.type}` : null,
      typeof opts.since === 'number' ? `since=${opts.since}` : null,
    ].filter(Boolean);
    const filterDesc = filterBits.length ? ` matching ${filterBits.join(', ')}` : '';
    const truncated = view.length < total;

    const warnings = corrupt_lines.length
      ? [{
          code: 'ledger_torn_tail',
          message: `${corrupt_lines.length} unparseable line(s) in events.jsonl (line ${corrupt_lines.join(', ')}) — likely a torn tail from an interrupted write; the parseable events are shown.`,
        }]
      : [];

    return okEnvelope({
      message: `${opts.runId}: ${total} event(s)${filterDesc}${truncated ? ` (showing last ${view.length})` : ''}.`,
      data: {
        run_id: opts.runId,
        total,
        shown: view.length,
        corrupt_lines,
        filters: { task: opts.task ?? null, type: opts.type ?? null, since: opts.since ?? null, limit },
        events: view,
      },
      warnings,
      nextActions: truncated ? [`Widen the window: sigmarun events ${opts.runId} --limit=0 (all) or --since=<seq>`] : [],
      startedAt,
    });
  } catch (err) {
    if (err instanceof GatewayError) return failEnvelope(err.code, err.message, { startedAt });
    throw err;
  }
}
