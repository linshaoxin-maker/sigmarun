import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonState, writeJsonStateAtomic } from '@sigmarun/storage';
import { claimNext, releaseTask, reviewClaim, reviewDecide, resumeTask, registerAgent } from '@sigmarun/dispatch';
import { submitEvidence } from '@sigmarun/core';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault, setupWorking } from './fixture.js';
import { validDraft } from '../../core/test/submit-fixture.js';

let repo: string;
let owner: string;
let reviewer: string;
beforeEach(async () => {
  repo = mkClaimRepo([{ key: 'a' }]);
  owner = registerDefault(repo, 'win-owner');
  await setupWorking(repo, owner);
  submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner, evidencePath: validDraft(repo) });
  const env = registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'claude-code', role: 'reviewer', label: 'win-review' });
  reviewer = (env.data as { agent_id: string }).agent_id;
});
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
const readJson = (rel: string) => JSON.parse(readFileSync(join(runDir(), rel), 'utf8'));
const events = () => readFileSync(join(runDir(), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const msgs = () => {
  const f = join(runDir(), 'context', 'messages.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

function approveDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { checklist: [{ item: 'behavior coverage', status: 'pass' }], findings: [], ...overrides };
}

describe('review claim + D15 synthesis (BDD-006-01/02/05; INV-008)', () => {
  it('explicit review claim flips the task to reviewing with a 20-minute lease', () => {
    const env = reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer });
    expect(env.ok).toBe(true);
    const claim = readJson('claims/review-claims.json').claims[0];
    expect(claim.reviewer_agent_id).toBe(reviewer);
    expect(claim.round).toBe(1);
    const leaseMs = Date.parse(claim.lease_until) - Date.now();
    expect(leaseMs).toBeGreaterThan(15 * 60_000);
    expect(leaseMs).toBeLessThan(25 * 60_000);
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('reviewing');
    expect(events().some((e) => e.event === 'review_claimed' && e.payload.round === 1)).toBe(true);
  });

  it('claim-next --role reviewer synthesizes a review_work item (BDD-006-01)', () => {
    const env = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: reviewer, role: 'reviewer' });
    expect(env.ok).toBe(true);
    const data = env.data as { kind: string; task_id: string; round: number; evidence_ref: string };
    expect(data.kind).toBe('review_work');
    expect(data.task_id).toBe('TASK-0001');
    expect(data.round).toBe(1);
    expect(data.evidence_ref).toBe('evidence/TASK-0001/evidence.json');
    expect(readJson('claims/review-claims.json').claims.length).toBe(1);
  });

  it('synthesis offers a task freed by its own sweep on the FIRST call (remediation S5 stale-read)', () => {
    reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer }); // task -> reviewing
    // the reviewer dies: expire its gate lease on disk
    const f = join(runDir(), 'claims', 'review-claims.json');
    const { doc, rev } = readJsonState(f);
    (doc as { claims: Array<{ lease_until: string }> }).claims[0]!.lease_until = new Date(Date.now() - 60_000).toISOString();
    writeJsonStateAtomic(f, doc as Record<string, unknown>, { expectedRev: rev });
    // a second reviewer synthesizes: the same call must sweep the stale gate AND offer the task —
    // one call, not "no_claimable_task then retry"
    const env2 = registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'codex', role: 'reviewer', label: 'win-review-2' });
    const r2 = (env2.data as { agent_id: string }).agent_id;
    const first = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: r2, role: 'reviewer' });
    expect(first.ok).toBe(true);
    expect((first.data as { task_id: string }).task_id).toBe('TASK-0001');
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('reviewing');
  });

  it('any historical owner is rejected with self_approval_forbidden (BDD-006-02)', () => {
    const direct = reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner });
    expect(direct.ok).toBe(false);
    expect(direct.code).toBe('self_approval_forbidden');
    const synth = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: owner, role: 'reviewer' });
    expect(synth.ok).toBe(false);
    expect(synth.code).toBe('no_claimable_task'); // filtered out, not crashed
  });

  it('a past holder who never submitted MAY review; the submitter may not (D22 substantive contribution)', async () => {
    // D22 rewrote this expectation: the old "ever held a claim" surface barred `first` here,
    // which combined with takeover into the S1 permanent review deadlock.
    const repo2 = mkClaimRepo([{ key: 'z' }]);
    try {
      const first = registerDefault(repo2, 'w1');
      claimNext({ cwd: repo2, runId: 'RUN-0001', agentId: first });
      releaseTask({ cwd: repo2, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: first });
      const second = registerDefault(repo2, 'w2', 'codex');
      await setupWorking(repo2, second, 'TASK-0001', 'task-z');
      submitEvidence({ cwd: repo2, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: second, evidencePath: validDraft(repo2, { acceptance: [{ item: 'z done.', status: 'met' }] }) });
      const bySubmitter = reviewClaim({ cwd: repo2, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: second });
      expect(bySubmitter.code).toBe('self_approval_forbidden');
      const byPastHolder = reviewClaim({ cwd: repo2, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: first });
      expect(byPastHolder.ok).toBe(true);
    } finally {
      cleanup(repo2);
    }
  });

  it('a reclaim takeover no longer deadlocks the review gate (S1/D22)', async () => {
    const repo2 = mkClaimRepo([{ key: 's1' }]);
    try {
      const a = registerDefault(repo2, 'w-a');
      claimNext({ cwd: repo2, runId: 'RUN-0001', agentId: a, taskId: 'TASK-0001' });
      // A dies: lease expires, the human reclaims
      const f = join(repo2, '.team', 'runs', 'RUN-0001', 'claims', 'task-claims.json');
      const { doc, rev } = readJsonState(f);
      (doc as { claims: Array<{ lease_until: string }> }).claims[0]!.lease_until = new Date(Date.now() - 60_000).toISOString();
      writeJsonStateAtomic(f, doc as Record<string, unknown>, { expectedRev: rev });
      const { reclaimTask } = await import('@sigmarun/dispatch');
      expect(reclaimTask({ cwd: repo2, runId: 'RUN-0001', taskId: 'TASK-0001' }).ok).toBe(true);
      // B takes over, does the work, submits
      const b = registerDefault(repo2, 'w-b', 'codex');
      await setupWorking(repo2, b, 'TASK-0001', 'task-s1');
      submitEvidence({ cwd: repo2, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: b, evidencePath: validDraft(repo2, { acceptance: [{ item: 's1 done.', status: 'met' }] }) });
      // OLD world: A and B were BOTH "owners" -> nobody present could ever review. NEW: A never
      // submitted evidence, so A reviews B's submission; the run breathes again.
      const synth = claimNext({ cwd: repo2, runId: 'RUN-0001', agentId: a, role: 'reviewer' });
      expect(synth.ok).toBe(true);
      expect((synth.data as { task_id: string }).task_id).toBe('TASK-0001');
      const decide = reviewDecide({ cwd: repo2, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: a, decision: 'approve', review: { findings: [] } });
      expect(decide.ok).toBe(true);
    } finally {
      cleanup(repo2);
    }
  });

  it('approve carrying a must_fix finding is rejected (no "approved yet with open change demands" state)', () => {
    reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer });
    const bad = reviewDecide({
      cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer,
      decision: 'approve', review: { findings: [{ must_fix: true, message: 'blocking issue' }] },
    });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('schema_invalid');
    // task must NOT have advanced, and no open request_changes message should have been mirrored
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('reviewing');
  });

  it('reclaim --force: the human takes a live lease request-changes gave a dead owner (S4/B4)', async () => {
    const { reclaimTask } = await import('@sigmarun/dispatch');
    reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer });
    const decide = reviewDecide({
      cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer,
      decision: 'request_changes', review: { findings: [{ must_fix: true, message: 'fix the guard' }] },
    });
    expect(decide.ok).toBe(true);
    // the owner claim is revived with a FULL fresh TTL — and the owner is dead
    const claim = readJson('claims/task-claims.json').claims[0];
    expect(claim.status).toBe('active');
    expect(Date.parse(claim.lease_until)).toBeGreaterThan(Date.now() + 20 * 60_000);

    // agents must keep waiting out the lease (anti-collision stays machine-proof)
    const plain = reclaimTask({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001' });
    expect(plain.ok).toBe(false);
    expect(plain.code).toBe('invalid_transition');
    expect(plain.next_actions.join(' ')).toContain('--force --agent=user');
    const notHuman = reclaimTask({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', force: true, agentId: reviewer });
    expect(notHuman.code).toBe('usage_error');

    // the human override works: hostage released, progress kept
    const forced = reclaimTask({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', force: true, agentId: 'user' });
    expect(forced.ok).toBe(true);
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('ready');
    expect(readJson('tasks/TASK-0001/task.json').previous_attempts.length).toBe(1);
    const ev = events().find((e) => e.event === 'task_reclaimed' && e.payload.forced === true);
    expect(ev.payload.reclaim_reason).toBe('forced_by_user');
  });

  it('synthesis names the tasks filtered by independence instead of claiming the queue is empty', () => {
    const env = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: owner, role: 'reviewer' });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('no_claimable_task');
    expect((env.data as { filtered_by_independence: string[] }).filtered_by_independence).toContain('TASK-0001');
    expect(env.message).toContain('accountable author');
  });

  it('a second reviewer cannot double-claim; an expired review lease is swept back to submitted (BDD-006-05)', () => {
    reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer });
    const third = registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'codex', role: 'reviewer', label: 'win-r2' });
    const thirdId = (third.data as { agent_id: string }).agent_id;
    const dup = reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: thirdId });
    expect(dup.code).toBe('task_already_claimed');

    const file = join(runDir(), 'claims', 'review-claims.json');
    const { doc, rev } = readJsonState(file);
    (doc as { claims: Array<{ lease_until: string }> }).claims[0].lease_until = new Date(Date.now() - 5 * 60_000).toISOString();
    writeJsonStateAtomic(file, doc, { expectedRev: rev });

    const retry = reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: thirdId });
    expect(retry.ok).toBe(true);
    expect(events().some((e) => e.event === 'review_released' && e.actor.type === 'sweep')).toBe(true);
    expect(readJson('claims/review-claims.json').claims[0].status).toBe('released');
  });
});

describe('review decisions (BDD-006-03/04; 14 §3.2)', () => {
  beforeEach(() => {
    reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer });
  });

  it('approve writes an immutable round record and flips the task to approved', () => {
    const env = reviewDecide({
      cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer,
      decision: 'approve', review: approveDraft(),
    });
    expect(env.ok).toBe(true);
    const record = readJson('reviews/TASK-0001/REVIEW-TASK-0001-01.json');
    expect(record.decision).toBe('approve');
    expect(record.reviewer_agent_id).toBe(reviewer);
    expect(record.round).toBe(1);
    expect(record.evidence_revision).toBe(1);
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('approved');
    expect(readJson('claims/review-claims.json').claims[0].status).toBe('completed');
    expect(events().some((e) => e.event === 'review_approved' && e.payload.review_id === 'REVIEW-TASK-0001-01')).toBe(true);
  });

  it('only the claim holder can decide (not_claim_owner)', () => {
    const stranger = registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'codex', role: 'reviewer', label: 'win-x' });
    const env = reviewDecide({
      cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001',
      agentId: (stranger.data as { agent_id: string }).agent_id,
      decision: 'approve', review: approveDraft(),
    });
    expect(env.code).toBe('not_claim_owner');
  });

  it('request-changes without a must_fix finding is rejected with zero mutation (BDD-006-03)', () => {
    const env = reviewDecide({
      cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer,
      decision: 'request_changes', review: approveDraft({ findings: [] }),
    });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('schema_invalid');
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('reviewing');
    expect(existsSync(join(runDir(), 'reviews', 'TASK-0001'))).toBe(false);
  });

  it('request-changes revives the owner claim, mirrors findings, and resume returns to working (BDD-006-04)', () => {
    const env = reviewDecide({
      cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer,
      decision: 'request_changes',
      review: approveDraft({
        findings: [{ finding_id: 'F-01', severity: 'major', kind: 'missing_case', message: 'Locked-account path untested.', must_fix: true }],
      }),
    });
    expect(env.ok).toBe(true);
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('changes_requested');
    const taskClaim = readJson('claims/task-claims.json').claims[0];
    expect(taskClaim.status).toBe('active'); // revived, same claim (15 §4.4)
    expect(Date.parse(taskClaim.lease_until)).toBeGreaterThan(Date.now());
    expect(readJson('claims/path-claims.json').claims[0].status).toBe('active'); // never released
    const mirrored = msgs().find((m) => m.type === 'request_changes');
    expect(mirrored.body).toContain('Locked-account');
    const record = readJson('reviews/TASK-0001/REVIEW-TASK-0001-01.json');
    expect(record.findings[0].message_ref).toBe(mirrored.message_id);
    expect(events().some((e) => e.event === 'changes_requested' && e.payload.must_fix_count === 1)).toBe(true);

    const resume = resumeTask({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner });
    expect(resume.ok).toBe(true);
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('working');

    const rework = submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner, evidencePath: validDraft(repo) });
    expect(rework.ok).toBe(true);
    expect((rework.data as { revision: number }).revision).toBe(2);

    const round2 = reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer });
    expect((round2.data as { round: number }).round).toBe(2);
    reviewDecide({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer, decision: 'approve', review: approveDraft() });
    expect(existsSync(join(runDir(), 'reviews', 'TASK-0001', 'REVIEW-TASK-0001-01.json'))).toBe(true);
    expect(existsSync(join(runDir(), 'reviews', 'TASK-0001', 'REVIEW-TASK-0001-02.json'))).toBe(true); // never overwritten
  });
});

describe('skip record (14 §3.2 last rule; closes the FEAT-007 gap)', () => {
  it('require_review=false submit writes a minimal skipped_by_policy review record', async () => {
    const repo2 = mkClaimRepo([{ key: 'k' }]);
    try {
      const runFile = join(repo2, '.team', 'runs', 'RUN-0001', 'run.json');
      const { doc, rev } = readJsonState(runFile);
      ((doc as { default_policy: Record<string, unknown> }).default_policy).require_review = false;
      writeJsonStateAtomic(runFile, doc, { expectedRev: rev });
      const a = registerDefault(repo2, 'w1');
      await setupWorking(repo2, a, 'TASK-0001', 'task-k');
      submitEvidence({ cwd: repo2, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: a, evidencePath: validDraft(repo2, { acceptance: [{ item: 'k done.', status: 'met' }] }) });
      const record = JSON.parse(readFileSync(join(repo2, '.team', 'runs', 'RUN-0001', 'reviews', 'TASK-0001', 'REVIEW-TASK-0001-01.json'), 'utf8'));
      expect(record.decision).toBe('skipped_by_policy');
      expect(record.round).toBe(1);
    } finally {
      cleanup(repo2);
    }
  });
});
