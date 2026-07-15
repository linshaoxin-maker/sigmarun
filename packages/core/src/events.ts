import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentStateGeneration, vlog } from '@sigmarun/storage';

export interface EventActor {
  type: 'agent' | 'user' | 'policy' | 'sweep' | 'system';
  id: string;
}

export interface EventInput {
  event: string;
  actor: EventActor;
  run_id: string;
  task_id?: string;
  claim_id?: string;
  payload?: Record<string, unknown>;
}

export type RevAfter = Record<string, number>;

/**
 * Snapshot mutable JSON state revs under one run — ALWAYS reads fresh from disk. Consumers that
 * compare against the current on-disk state (AUD-032) must see writes made by OTHER processes,
 * so this must never be memoized across the process's own generation.
 */
export function collectStateRevs(runDir: string): RevAfter {
  const out: RevAfter = {};
  const walk = (dir: string, prefix = ''): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'locks') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const doc = JSON.parse(readFileSync(abs, 'utf8')) as { rev?: unknown };
        if (typeof doc.rev === 'number') out[rel] = doc.rev;
      } catch {
        // Corrupt JSON is reported by audit rules that read the specific state plane.
      }
    }
  };
  walk(runDir);
  return out;
}

/**
 * The snapshot stamped into an event's rev_after. Memoized on (runDir, state-write generation):
 * appendEvent only runs inside the run lock, so while THIS process appends events no other process
 * can mutate on-disk state, and the generation counter fully reflects this process's own writes.
 * A transaction writes all state before appending its events (docs/17 §5.3), so a cancel/report/
 * import that appends N events walks the tree once, not N times (concurrency review Finding 2).
 * NOT safe for current-state reads outside the lock — those call collectStateRevs directly.
 */
let revMemo: { key: string; value: RevAfter } | null = null;
function collectStateRevsForAppend(runDir: string): RevAfter {
  const key = `${runDir}#${currentStateGeneration()}`;
  if (revMemo && revMemo.key === key) return revMemo.value;
  const value = collectStateRevs(runDir);
  revMemo = { key, value };
  return value;
}

/**
 * Append one audit event; the jsonl append is the transaction commit point.
 * @contract docs/18 §3 team.event.v1 · docs/17 §5.2 seq from events.meta.json (caller holds the lock) · §5.3 events-last write order
 */
export function appendEvent(runDir: string, evt: EventInput): number {
  const metaFile = join(runDir, 'events.meta.json');
  const meta = existsSync(metaFile)
    ? (JSON.parse(readFileSync(metaFile, 'utf8')) as { next_seq: number })
    : { next_seq: 1 };
  const seq = meta.next_seq;
  const payload = evt.payload ?? {};
  const manualRevAfter = typeof payload.rev_after === 'object' && payload.rev_after !== null
    ? (payload.rev_after as Record<string, unknown>)
    : {};
  const line = {
    schema_version: 'team.event.v1',
    ts: new Date().toISOString(),
    seq,
    event: evt.event,
    actor: evt.actor,
    run_id: evt.run_id,
    ...(evt.task_id ? { task_id: evt.task_id } : {}),
    ...(evt.claim_id ? { claim_id: evt.claim_id } : {}),
    payload: { ...payload, rev_after: { ...manualRevAfter, ...collectStateRevsForAppend(runDir) } },
  };
  appendFileSync(join(runDir, 'events.jsonl'), JSON.stringify(line) + '\n');
  writeFileSync(metaFile, JSON.stringify({ next_seq: seq + 1 }));
  vlog('event', `${evt.event} seq ${seq}${evt.task_id ? ` (${evt.task_id})` : ''}`);
  return seq;
}

export interface LedgerEvent {
  seq: number;
  event: string;
  task_id?: string;
  claim_id?: string;
  actor?: { type: string; id: string };
  payload?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface SafeEvents {
  events: LedgerEvent[];
  /** 1-based line numbers that failed to parse (torn tail line after ENOSPC/power loss). */
  corrupt_lines: number[];
}

/**
 * Tolerant ledger reader: a torn line must degrade to a finding, never crash the reader —
 * submit, report, audit AND repair all parse this file (review finding #9).
 */
export function readEventsSafe(runDir: string): SafeEvents {
  const file = join(runDir, 'events.jsonl');
  const out: SafeEvents = { events: [], corrupt_lines: [] };
  if (!existsSync(file)) return out;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    try {
      out.events.push(JSON.parse(line) as LedgerEvent);
    } catch {
      out.corrupt_lines.push(i + 1);
    }
  });
  return out;
}
