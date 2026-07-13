import { describe, it, expect, afterEach } from 'vitest';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEvents } from '@sigmarun/core';
import { claimNext } from '@sigmarun/dispatch';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault } from '../../dispatch/test/fixture.js';

let repo: string;
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');

interface EventView { seq: number; event: string; actor: { id: string }; task_id: string | null; }
interface EventsData { run_id: string; total: number; shown: number; corrupt_lines: number[]; events: EventView[]; }

describe('events reader — the ledger becomes observable (Phase 1 observability)', () => {
  it('reads the ledger, is read-only, and returns a structured, ok envelope', () => {
    repo = mkClaimRepo([{ key: 'a' }, { key: 'b' }]);
    const agent = registerDefault(repo);
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent });

    const env = readEvents({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);
    expect(env.code).toBe('OK');
    const d = env.data as EventsData;
    expect(d.run_id).toBe('RUN-0001');
    expect(d.total).toBeGreaterThan(0);
    expect(d.events.length).toBe(d.shown);
    // events carry the columns the timeline needs
    const claimed = d.events.find((e) => e.event === 'task_claimed');
    expect(claimed).toBeTruthy();
    expect(claimed!.actor.id).toBe(agent);
    expect(claimed!.task_id).toBe('TASK-0001');
    // ascending by seq (a timeline reads oldest -> newest)
    for (let i = 1; i < d.events.length; i++) expect(d.events[i]!.seq).toBeGreaterThan(d.events[i - 1]!.seq);
  });

  it('filters by task, type, and since; caps with limit while total counts the full match', () => {
    repo = mkClaimRepo([{ key: 'a' }, { key: 'b' }]);
    const a1 = registerDefault(repo, 'w1');
    const a2 = registerDefault(repo, 'w2', 'codex');
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: a1 }); // TASK-0001
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: a2 }); // TASK-0002

    const byTask = readEvents({ cwd: repo, runId: 'RUN-0001', task: 'TASK-0002' }).data as EventsData;
    expect(byTask.events.every((e) => e.task_id === 'TASK-0002')).toBe(true);
    expect(byTask.events.some((e) => e.event === 'task_claimed')).toBe(true);

    const byType = readEvents({ cwd: repo, runId: 'RUN-0001', type: 'task_claimed' }).data as EventsData;
    expect(byType.events.length).toBeGreaterThanOrEqual(2);
    expect(byType.events.every((e) => e.event === 'task_claimed')).toBe(true);

    const all = readEvents({ cwd: repo, runId: 'RUN-0001' }).data as EventsData;
    const midSeq = all.events[Math.floor(all.events.length / 2)]!.seq;
    const since = readEvents({ cwd: repo, runId: 'RUN-0001', since: midSeq }).data as EventsData;
    expect(since.events.every((e) => e.seq > midSeq)).toBe(true);

    const capped = readEvents({ cwd: repo, runId: 'RUN-0001', limit: 2 }).data as EventsData;
    expect(capped.events.length).toBe(2);
    expect(capped.total).toBe(all.total); // total is the full match, not the shown slice
    expect(capped.events[1]!.seq).toBe(all.events[all.events.length - 1]!.seq); // most-recent window
  });

  it('surfaces a torn tail as corrupt_lines + a warning instead of crashing (observability of ledger health)', () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    appendFileSync(join(runDir(), 'events.jsonl'), '{"event":"task_don'); // torn last line

    const env = readEvents({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true); // a query never crashes on a torn ledger
    const d = env.data as EventsData;
    expect(d.corrupt_lines.length).toBe(1);
    expect(env.warnings.some((w) => w.code === 'ledger_torn_tail')).toBe(true);
  });

  it('missing run is run_not_found (exit-5 class), not an empty read', () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const env = readEvents({ cwd: repo, runId: 'RUN-9999' });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('run_not_found');
  });
});
