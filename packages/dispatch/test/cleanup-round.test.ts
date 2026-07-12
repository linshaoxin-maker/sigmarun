import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerAgent, reviewClaim, reviewDecide, unblockTask } from '@sigmarun/dispatch';
import { submitEvidence } from '@sigmarun/core';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault, setupWorking, payloadWith } from './fixture.js';
import { validDraft } from '../../core/test/submit-fixture.js';

let repo: string;
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
const readJson = (rel: string) => JSON.parse(readFileSync(join(runDir(), rel), 'utf8'));
const events = () => readFileSync(join(runDir(), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('review decision=block + unblock (docs/14 §3.2; docs/15 §3.3 blocked edges; event #34/#15)', () => {
  it('block writes the record, parks the task, and unblock returns it to working', async () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const owner = registerDefault(repo, 'w-owner');
    await setupWorking(repo, owner);
    submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner, evidencePath: validDraft(repo) });
    const reviewer = (registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'claude-code', role: 'reviewer', label: 'w-r' }).data as { agent_id: string }).agent_id;
    reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer });

    const env = reviewDecide({
      cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer,
      decision: 'block', review: { findings: [{ finding_id: 'F-01', severity: 'blocker', message: 'needs a human product decision', must_fix: false }] },
    });
    expect(env.ok).toBe(true);
    expect(readJson('reviews/TASK-0001/REVIEW-TASK-0001-01.json').decision).toBe('block');
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('blocked');
    expect(readJson('claims/review-claims.json').claims[0].status).toBe('completed');
    expect(events().some((e) => e.event === 'review_blocked' && e.payload.review_id === 'REVIEW-TASK-0001-01')).toBe(true);

    // Security (review): only a task owner or --agent=user may lift a block.
    const stranger = (registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'codex', role: 'implementer', label: 'w-x' }).data as { agent_id: string }).agent_id;
    expect(unblockTask({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: stranger }).code).toBe('not_claim_owner');

    const un = unblockTask({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner, reason: 'decision made' });
    expect(un.ok).toBe(true);
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('working');
    expect(events().some((e) => e.event === 'task_unblocked' && e.payload.reason === 'decision made')).toBe(true);

    // CRITICAL (state-machine review Finding 1): unblock must revive the owner claim to active,
    // or the task is permanently unclaimable (submit/resume/release/reclaim all fail). Assert the
    // claim is active AND a forward op (heartbeat, which requires an active owner claim) succeeds.
    const ownerClaim = readJson('claims/task-claims.json').claims.find((c: { task_id: string; status: string }) => c.task_id === 'TASK-0001' && c.status === 'active');
    expect(ownerClaim).toBeTruthy();
    expect(ownerClaim.agent_id).toBe(owner);
    const { heartbeat } = await import('@sigmarun/dispatch');
    const hb = heartbeat({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner });
    expect(hb.ok).toBe(true);

    const again = unblockTask({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner });
    expect(again.code).toBe('invalid_transition');
  });
});

describe('task-level review.required overrides run-level false (docs/15 §9 strict-wins)', () => {
  it('a task explicitly requiring review stays submitted even when the run skips reviews', async () => {
    repo = mkClaimRepo([{ key: 'a' }], { policy: { require_review: false } });
    // hand the task an explicit review.required: true via a re-import-free route: fixture payload has no review field,
    // so build a second repo where the payload sets it.
    cleanup(repo);
    const { mkTmpGitRepo } = await import('../../storage/test/helpers.js');
    const { initProject, importRun, publishTasks } = await import('@sigmarun/core');
    repo = mkTmpGitRepo();
    initProject({ cwd: repo });
    const payload = payloadWith([{ key: 'a' }], { require_review: false }) as {
      tasks: Array<Record<string, unknown>>;
    };
    payload.tasks[0]!.review = { required: true }; // strict wins
    importRun({ cwd: repo, payload });
    publishTasks({ cwd: repo, runId: 'RUN-0001' });

    const owner = registerDefault(repo, 'w-owner');
    await setupWorking(repo, owner);
    const env = submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner, evidencePath: validDraft(repo) });
    expect(env.ok).toBe(true);
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('submitted'); // NOT auto-approved
    expect(events().some((e) => e.event === 'review_skipped')).toBe(false);
  });

  it('without the explicit task flag the run-level skip still applies (inherit)', async () => {
    repo = mkClaimRepo([{ key: 'a' }], { policy: { require_review: false } });
    const owner = registerDefault(repo, 'w-owner');
    await setupWorking(repo, owner);
    submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner, evidencePath: validDraft(repo) });
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('approved');
    expect(events().some((e) => e.event === 'review_skipped')).toBe(true);
  });
});
