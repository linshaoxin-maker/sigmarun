import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonState, writeJsonStateAtomic } from '@sigmarun/storage';
import { initProject, importRun, taskDone } from '@sigmarun/core';
import { claimNext } from '@sigmarun/dispatch';
import { statusRun } from '@sigmarun/watch';
import { mkTmpGitRepo, cleanup } from '../../storage/test/helpers.js';
import { validPayload } from './payload-fixture.js';

let repo: string;
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
const events = () => readFileSync(join(runDir(), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('TxKernel seed — min_gateway_version write gate + lock_takeover ledger (docs/21 §8; docs/17 §4)', () => {
  it('an old gateway is refused at every write door; reads stay open (gateway_too_old)', () => {
    repo = mkTmpGitRepo();
    initProject({ cwd: repo });
    importRun({ cwd: repo, payload: validPayload(), lightweight: true });
    // the project now demands a future gateway major
    const pf = join(repo, '.team', 'project.json');
    const { doc, rev } = readJsonState(pf);
    (doc as { min_gateway_version?: string }).min_gateway_version = '99.0.0';
    writeJsonStateAtomic(pf, doc as Record<string, unknown>, { expectedRev: rev });

    const claim = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: 'win-1' });
    expect(claim.ok).toBe(false);
    expect(claim.code).toBe('gateway_too_old');
    const done = taskDone({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: 'win-1' });
    expect(done.code).toBe('gateway_too_old');
    const anotherImport = importRun({ cwd: repo, payload: validPayload(), lightweight: true });
    expect(anotherImport.code).toBe('gateway_too_old');

    // read paths are not walled (migrate-on-read ruling stands)
    expect(statusRun({ cwd: repo, runId: 'RUN-0001' }).ok).toBe(true);
  });

  it('a stale-lock takeover lands on the ledger as lock_takeover (seize first, record after)', () => {
    repo = mkTmpGitRepo();
    initProject({ cwd: repo });
    importRun({ cwd: repo, payload: validPayload(), lightweight: true });

    // a crashed holder left run.lock behind, 40s cold (stale horizon is 30s)
    const lockDir = join(runDir(), 'run.lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'meta.json'), JSON.stringify({ pid: 424242, token: 'dead-token', acquired_at: new Date(Date.now() - 40_000).toISOString() }));
    const old = new Date(Date.now() - 40_000);
    utimesSync(lockDir, old, old);

    const env = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: 'win-1' });
    expect(env.ok).toBe(true); // the takeover rescued the transaction
    const takeover = events().find((e) => e.event === 'lock_takeover');
    expect(takeover).toBeTruthy();
    expect(takeover.actor).toEqual({ type: 'system', id: 'lock-manager' });
    expect(takeover.payload.stale_pid).toBe(424242);
    expect(takeover.payload.age_ms).toBeGreaterThan(29_000);
    // and the ledger stays ordered: the takeover record precedes the claim it unblocked
    const claimSeq = events().find((e) => e.event === 'task_claimed').seq;
    expect(takeover.seq).toBeLessThan(claimSeq);
  });
});
