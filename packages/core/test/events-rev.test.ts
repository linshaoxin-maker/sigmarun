import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { collectStateRevs, appendEvent } from '@sigmarun/core';
import { writeJsonStateAtomic } from '@sigmarun/storage';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function mkRun(): string {
  const runDir = mkdtempSync(join(tmpdir(), 'sr-rev-'));
  dirs.push(runDir);
  return runDir;
}

describe('collectStateRevs freshness contract (concurrency review Finding 2 fix)', () => {
  it('always reflects the latest on-disk rev — never a stale memo (guards the cross-process bug)', () => {
    const runDir = mkRun();
    const f = join(runDir, 'run.json');
    writeJsonStateAtomic(f, { schema_version: 'team.run.v1' }, { expectedRev: 0 }); // rev 1
    expect(collectStateRevs(runDir)['run.json']).toBe(1);
    // a write "by another process" is simulated by a direct atomic write; the reader must see it,
    // not a cached snapshot from the previous call.
    writeJsonStateAtomic(f, { schema_version: 'team.run.v1' }, { expectedRev: 1 }); // rev 2
    expect(collectStateRevs(runDir)['run.json']).toBe(2);
  });

  it('stamps each event with a rev_after that matches a fresh snapshot at append time', () => {
    const runDir = mkRun();
    mkdirSync(join(runDir, 'tasks', 'TASK-0001'), { recursive: true });
    const tf = join(runDir, 'tasks', 'TASK-0001', 'task.json');
    writeJsonStateAtomic(tf, { schema_version: 'team.task.v1', status: 'ready' }, { expectedRev: 0 }); // rev 1
    // batched transaction: all state written, then two events appended (memo hot path)
    appendEvent(runDir, { event: 'task_claimed', actor: { type: 'agent', id: 'A' }, run_id: 'RUN-0001', task_id: 'TASK-0001', payload: {} });
    writeJsonStateAtomic(tf, { schema_version: 'team.task.v1', status: 'working' }, { expectedRev: 1 }); // rev 2 — generation bumps
    appendEvent(runDir, { event: 'task_started', actor: { type: 'agent', id: 'A' }, run_id: 'RUN-0001', task_id: 'TASK-0001', payload: {} });
    const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    // the second event must reflect rev 2 (the memo invalidated on the intervening write), not a stale rev 1
    expect(events[0].payload.rev_after['tasks/TASK-0001/task.json']).toBe(1);
    expect(events[1].payload.rev_after['tasks/TASK-0001/task.json']).toBe(2);
    // and the last event agrees with a fresh recompute (AUD-032's comparison basis)
    expect(events[1].payload.rev_after['tasks/TASK-0001/task.json']).toBe(collectStateRevs(runDir)['tasks/TASK-0001/task.json']);
  });
});
