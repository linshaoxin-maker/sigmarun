import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonState, writeJsonStateAtomic } from '@sigmarun/storage';
import { blockTask, unblockTask, claimNext, sweepRun } from '@sigmarun/dispatch';
import { postMessage } from '@sigmarun/context';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault, setupWorking } from './fixture.js';

let repo: string;
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
const readJson = (rel: string) => JSON.parse(readFileSync(join(runDir(), rel), 'utf8'));
const events = () => readFileSync(join(runDir(), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

function expireLease(minutesAgo: number): void {
  const f = join(runDir(), 'claims', 'task-claims.json');
  const { doc, rev } = readJsonState(f);
  (doc as { claims: Array<{ lease_until: string }> }).claims[0]!.lease_until = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  writeJsonStateAtomic(f, doc as Record<string, unknown>, { expectedRev: rev });
}

describe('block — the owner freeze while a blocker awaits its answer (15 §3.3; S2)', () => {
  it('block freezes the lease against the sweep; answer + unblock revives the claim (S2)', async () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const owner = registerDefault(repo, 'win-owner');
    await setupWorking(repo, owner);
    const msg = postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: owner, type: 'blocker', taskId: 'TASK-0001', body: 'Need a schema decision.' });
    const msgId = (msg.data as { message_id: string }).message_id;

    const blocked = blockTask({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner, msgId });
    expect(blocked.ok).toBe(true);
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('blocked');
    expect(events().some((e) => e.event === 'task_blocked' && e.payload.message_id === msgId)).toBe(true);

    // lease WAY past the 3xTTL horizon — the sweep must not touch a blocked task
    expireLease(200);
    const swept = sweepRun({ cwd: repo, runId: 'RUN-0001' });
    expect((swept.data as { reclaimed: unknown[] }).reclaimed).toEqual([]);
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('blocked');

    // answer arrives; owner unblocks; the claim revives with a fresh lease
    postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: 'user', type: 'answer', inReplyTo: msgId, body: 'Keep v1.' });
    const un = unblockTask({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner });
    expect(un.ok).toBe(true);
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('working');
    const claim = readJson('claims/task-claims.json').claims[0];
    expect(claim.status).toBe('active');
    expect(Date.parse(claim.lease_until)).toBeGreaterThan(Date.now() + 20 * 60_000);
  });

  it('block guards: non-owner, wrong message, wrong state', async () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const owner = registerDefault(repo, 'win-owner');
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: owner }); // claimed, not yet working
    const msg = postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: owner, type: 'blocker', taskId: 'TASK-0001', body: 'q' });
    const msgId = (msg.data as { message_id: string }).message_id;

    const wrongState = blockTask({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner, msgId });
    expect(wrongState.code).toBe('invalid_transition'); // claimed, block needs working

    await setupWorking(repo, owner); // registers the worktree -> working (claim already held)
    const other = registerDefault(repo, 'win-2', 'codex');
    const notOwner = blockTask({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: other, msgId });
    expect(notOwner.code).toBe('not_claim_owner');

    const note = postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: owner, type: 'note', taskId: 'TASK-0001', body: 'n' });
    const badMsg = blockTask({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner, msgId: (note.data as { message_id: string }).message_id });
    expect(badMsg.code).toBe('schema_invalid');
  });

  it('a reclaim over an unanswered blocker parks the task at blocked; unblock (post-answer) frees it to ready (docs/10 §10)', async () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const owner = registerDefault(repo, 'win-owner');
    await setupWorking(repo, owner);
    // owner posts the blocker but forgets to run block, then dies
    const msg = postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: owner, type: 'blocker', taskId: 'TASK-0001', body: 'Need input.' });
    const msgId = (msg.data as { message_id: string }).message_id;
    expireLease(200); // way past lease + 2xTTL

    const swept = sweepRun({ cwd: repo, runId: 'RUN-0001' });
    expect((swept.data as { reclaimed: unknown[] }).reclaimed.length).toBe(1);
    // parked at blocked, NOT offered back to the queue
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('blocked');
    const reclaimedEv = events().find((e) => e.event === 'task_reclaimed');
    expect(reclaimedEv.payload.parked).toBe('blocked');
    const other = registerDefault(repo, 'win-2', 'codex');
    expect(claimNext({ cwd: repo, runId: 'RUN-0001', agentId: other }).code).toBe('no_claimable_task');

    // the answer lands; the original asker (a historical owner) unblocks -> ready, claimable again
    postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: 'user', type: 'answer', inReplyTo: msgId, body: 'Answered.' });
    const un = unblockTask({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner });
    expect(un.ok).toBe(true);
    expect((un.data as { to: string }).to).toBe('ready');
    expect(claimNext({ cwd: repo, runId: 'RUN-0001', agentId: other }).ok).toBe(true);
  });
});
