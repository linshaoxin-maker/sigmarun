import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface EventActor {
  type: 'agent' | 'user' | 'policy' | 'sweep';
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
  const line = {
    schema_version: 'team.event.v1',
    ts: new Date().toISOString(),
    seq,
    event: evt.event,
    actor: evt.actor,
    run_id: evt.run_id,
    ...(evt.task_id ? { task_id: evt.task_id } : {}),
    ...(evt.claim_id ? { claim_id: evt.claim_id } : {}),
    payload: evt.payload ?? {},
  };
  appendFileSync(join(runDir, 'events.jsonl'), JSON.stringify(line) + '\n');
  writeFileSync(metaFile, JSON.stringify({ next_seq: seq + 1 }));
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
