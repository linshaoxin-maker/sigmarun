import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, appendFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, readEventsSafe } from '@sigmarun/core';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function mkRun(): string {
  const d = mkdtempSync(join(tmpdir(), 'sr-seq-'));
  dirs.push(d);
  return d;
}
const emit = (runDir: string, event: string): number =>
  appendEvent(runDir, { event, actor: { type: 'system', id: 'S' }, run_id: 'RUN-0001', payload: {} });
const metaNext = (runDir: string): number =>
  JSON.parse(readFileSync(join(runDir, 'events.meta.json'), 'utf8')).next_seq as number;

describe('appendEvent seq allocation is crash-safe (P0-5: the ledger is the source of truth, not events.meta.json)', () => {
  it('does not reuse a seq when events.meta.json lags the committed ledger after a mid-write crash', () => {
    const runDir = mkRun();
    emit(runDir, 'evt_a'); // seq 1
    emit(runDir, 'evt_b'); // seq 2
    emit(runDir, 'evt_c'); // seq 3 -> meta.next_seq becomes 4

    // Simulate a crash between the jsonl append (the commit point) and the meta bump: the line for
    // seq 3 committed durably, but the process died before events.meta.json advanced past it.
    writeFileSync(join(runDir, 'events.meta.json'), JSON.stringify({ next_seq: 3 }));

    const seq = emit(runDir, 'evt_d');
    expect(seq).toBe(4); // NOT 3 — reusing 3 would permanently duplicate the committed line's seq

    const seqs = readEventsSafe(runDir).events.map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicate in the ledger
    expect(metaNext(runDir)).toBe(5); // meta is kept in sync as a cache (AUD-033: next_seq === max + 1)
  });

  it('derives the next seq from the last COMMITTED line, skipping a torn tail (readEventsSafe tolerance)', () => {
    const runDir = mkRun();
    emit(runDir, 'evt_a'); // seq 1
    emit(runDir, 'evt_b'); // seq 2 -> meta.next_seq becomes 3

    // A torn tail line (power loss mid-append) is unparseable; it never committed.
    appendFileSync(join(runDir, 'events.jsonl'), '{"seq":2,"event":"evt_torn');
    // ...and meta also lags (crash before its bump).
    writeFileSync(join(runDir, 'events.meta.json'), JSON.stringify({ next_seq: 2 }));

    const seq = emit(runDir, 'evt_c');
    // last committed good seq is 2; the torn line is ignored; meta's stale 2 is not trusted.
    expect(seq).toBe(3);
  });
});
