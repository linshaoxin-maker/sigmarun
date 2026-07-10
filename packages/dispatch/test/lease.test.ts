import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonState, writeJsonStateAtomic } from '@sigmarun/storage';
import { claimNext, heartbeat, releaseTask, reclaimTask } from '@sigmarun/dispatch';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault } from './fixture.js';

let repo: string;
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
const readJson = (rel: string) => JSON.parse(readFileSync(join(runDir(), rel), 'utf8'));
const events = () => readFileSync(join(runDir(), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

/** Rewind the active claim's lease by `minutes` to simulate elapsed time. */
function expireLease(minutes: number): void {
  const file = join(runDir(), 'claims', 'task-claims.json');
  const { doc, rev } = readJsonState(file);
  const claims = (doc as { claims: Array<{ lease_until: string; acquired_at: string }> }).claims;
  claims[0].lease_until = new Date(Date.now() - minutes * 60_000).toISOString();
  writeJsonStateAtomic(file, doc, { expectedRev: rev });
}

describe('heartbeat (docs/10 §9; event #26)', () => {
  it('extends the lease and stamps the agent file', () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const agent = registerDefault(repo);
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent });
    expireLease(5);
    const env = heartbeat({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent });
    expect(env.ok).toBe(true);
    const lease = Date.parse(readJson('claims/task-claims.json').claims[0].lease_until);
    expect(lease).toBeGreaterThan(Date.now() + 25 * 60_000);
    expect(events().some((e) => e.event === 'heartbeat')).toBe(true);
  });

  it('rejects a heartbeat from a non-owner with not_claim_owner', () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const a1 = registerDefault(repo, 'win-1');
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: a1 });
    const a2 = registerDefault(repo, 'win-2', 'codex');
    const env = heartbeat({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: a2 });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('not_claim_owner');
  });
});

describe('release (BDD-007 family; BR-004 progress is never erased)', () => {
  it('owner release frees the task, records previous_attempts, releases path claims, lets others claim', () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const a1 = registerDefault(repo, 'win-1');
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: a1 });
    const env = releaseTask({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: a1, reason: 'switching work' });
    expect(env.ok).toBe(true);

    expect(readJson('tasks/TASK-0001/task.json').status).toBe('ready');
    const attempts = readJson('tasks/TASK-0001/task.json').previous_attempts;
    expect(attempts.length).toBe(1);
    expect(attempts[0].agent_id).toBe(a1);
    expect(attempts[0].claim_id).toBe('CLAIM-task-0001');
    expect(readJson('claims/task-claims.json').claims[0].status).toBe('released');
    expect(readJson('claims/path-claims.json').claims[0].status).toBe('released');
    const row = readJson('team-task-list.json').tasks[0];
    expect(row.owner_agent_id).toBeNull();
    const ev = events().find((e) => e.event === 'task_released');
    expect(ev.payload.attempt).toBe(1);
    expect(ev.payload.released_claim_ids).toContain('CLAIM-task-0001');

    const a2 = registerDefault(repo, 'win-2', 'codex');
    const next = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: a2 });
    expect(next.ok).toBe(true);
    expect((next.data as { task_id: string }).task_id).toBe('TASK-0001');
  });

  it('non-owner release is rejected with not_claim_owner and mutates nothing', () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const a1 = registerDefault(repo, 'win-1');
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: a1 });
    const a2 = registerDefault(repo, 'win-2', 'codex');
    const env = releaseTask({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: a2 });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('not_claim_owner');
    expect(readJson('claims/task-claims.json').claims[0].status).toBe('active');
  });
});

describe('reclaim: manual and 3xTTL sweep (BDD-007-02/03; D9; AUD-003 blocked exemption)', () => {
  it('manual reclaim before expiry is rejected as invalid_transition', () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const a1 = registerDefault(repo, 'win-1');
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: a1 });
    const env = reclaimTask({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001' });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('invalid_transition');
  });

  it('manual reclaim of an expired lease frees the task with actor user (BDD-007-02)', () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const a1 = registerDefault(repo, 'win-1');
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: a1 });
    expireLease(10);
    const env = reclaimTask({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001' });
    expect(env.ok).toBe(true);
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('ready');
    expect(readJson('tasks/TASK-0001/task.json').previous_attempts[0].reclaim_reason).toBe('stale_lease_manual');
    expect(readJson('claims/task-claims.json').claims[0].status).toBe('reclaimed');
    const ev = events().find((e) => e.event === 'task_reclaimed');
    expect(ev.actor.type).toBe('user');
    expect(ev.payload.reclaim_reason).toBe('stale_lease_manual');
  });

  it('sweep auto-reclaims past 3xTTL and the caller can claim the task (BDD-007-03)', () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const a1 = registerDefault(repo, 'win-1');
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: a1 });
    expireLease(61); // TTL 30min: lease_until + 2xTTL passed => 3xTTL since acquire
    const a2 = registerDefault(repo, 'win-2', 'codex');
    const env = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: a2 });
    expect(env.ok).toBe(true);
    expect((env.data as { task_id: string }).task_id).toBe('TASK-0001');
    const reclaim = events().find((e) => e.event === 'task_reclaimed');
    expect(reclaim.actor.type).toBe('sweep');
    expect(reclaim.payload.reclaim_reason).toBe('stale_lease_auto');
    expect(reclaim.payload.triggered_by).toBe(a2);
    const attempts = readJson('tasks/TASK-0001/task.json').previous_attempts;
    expect(attempts[0].agent_id).toBe(a1);
  });

  it('expired but under 3xTTL is NOT swept; the task stays held', () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const a1 = registerDefault(repo, 'win-1');
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: a1 });
    expireLease(10);
    const a2 = registerDefault(repo, 'win-2', 'codex');
    const env = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: a2 });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('no_claimable_task');
    expect(readJson('claims/task-claims.json').claims[0].status).toBe('active');
  });

  it('a blocked task is exempt from the sweep (AUD-003 / docs/15 §5.1)', () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const a1 = registerDefault(repo, 'win-1');
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: a1 });
    const taskFile = join(runDir(), 'tasks', 'TASK-0001', 'task.json');
    const { doc, rev } = readJsonState(taskFile);
    (doc as { status: string }).status = 'blocked';
    writeJsonStateAtomic(taskFile, doc, { expectedRev: rev });
    expireLease(120);
    const a2 = registerDefault(repo, 'win-2', 'codex');
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: a2 });
    expect(readJson('claims/task-claims.json').claims[0].status).toBe('active');
    expect(events().some((e) => e.event === 'task_reclaimed')).toBe(false);
  });
});
