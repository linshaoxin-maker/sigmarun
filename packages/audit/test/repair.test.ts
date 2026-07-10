import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonState, writeJsonStateAtomic } from '@sigmarun/storage';
import { claimNext } from '@sigmarun/dispatch';
import { repairRun } from '@sigmarun/audit';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault } from '../../dispatch/test/fixture.js';

let repo: string;
let agent: string;
beforeEach(() => {
  repo = mkClaimRepo([{ key: 'a' }]);
  agent = registerDefault(repo);
  claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent });
});
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
const readJson = (rel: string) => JSON.parse(readFileSync(join(runDir(), rel), 'utf8'));
const events = () => readFileSync(join(runDir(), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('repair (docs/17 §5.3: ledger-driven, backup first, idempotent; BDD-007-06)', () => {
  it('rolls the task-list row forward to the event-ledger state, with backup and state_repaired', () => {
    // simulate a crash between detail and index writes: list row lags behind task.json/ledger (claimed)
    const listFile = join(runDir(), 'team-task-list.json');
    const { doc, rev } = readJsonState(listFile);
    const row = (doc as { tasks: Array<{ status: string; owner_agent_id: string | null }> }).tasks[0];
    row.status = 'ready';
    row.owner_agent_id = null;
    writeJsonStateAtomic(listFile, doc, { expectedRev: rev });

    const env = repairRun({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);
    const repaired = (env.data as { repaired: Array<{ target: string }> }).repaired;
    expect(repaired.length).toBeGreaterThan(0);
    expect(readJson('team-task-list.json').tasks[0].status).toBe('claimed');

    const backups = join(repo, '.team', 'backups');
    expect(existsSync(backups)).toBe(true);
    expect(readdirSync(backups).length).toBeGreaterThan(0);
    expect(events().some((e) => e.event === 'state_repaired')).toBe(true);
  });

  it('fixes events.meta counter drift (forward-roll to max seq + 1)', () => {
    const metaFile = join(runDir(), 'events.meta.json');
    writeFileSync(metaFile, JSON.stringify({ next_seq: 2 })); // stale counter
    const env = repairRun({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    const maxSeq = Math.max(...events().filter((e) => e.event !== 'state_repaired').map((e) => e.seq));
    expect(meta.next_seq).toBeGreaterThan(maxSeq);
  });

  it('is idempotent: a second run repairs nothing and writes no event', () => {
    const listFile = join(runDir(), 'team-task-list.json');
    const { doc, rev } = readJsonState(listFile);
    (doc as { tasks: Array<{ status: string }> }).tasks[0].status = 'ready';
    writeJsonStateAtomic(listFile, doc, { expectedRev: rev });
    repairRun({ cwd: repo, runId: 'RUN-0001' });
    const eventsBefore = events().length;
    const second = repairRun({ cwd: repo, runId: 'RUN-0001' });
    expect(second.ok).toBe(true);
    expect((second.data as { repaired: unknown[] }).repaired.length).toBe(0);
    expect(events().length).toBe(eventsBefore);
  });
});
