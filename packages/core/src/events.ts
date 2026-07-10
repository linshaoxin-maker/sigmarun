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
