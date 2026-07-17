import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonState, writeJsonStateAtomic } from '@sigmarun/storage';
import { claimNext, releaseTask, registerAgent, reviewClaim, reviewDecide } from '@sigmarun/dispatch';
import { submitEvidence } from '@sigmarun/core';
import { repairRun, auditRun } from '@sigmarun/audit';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault, setupWorking, driveToVerified } from '../../dispatch/test/fixture.js';
import { validDraft } from '../../core/test/submit-fixture.js';

/**
 * P1-9: a crash between the claims write and the claim's own commit event can leave a task-claim
 * ACTIVE in claims/task-claims.json while the task itself is really `ready` (the ledger agrees).
 * That ghost is counted by claim-engine's parallel-slot / per-agent limits (claim-engine.ts:604,690),
 * so it wedges legitimate claim-next with parallel_limit_reached / agent_claim_limit until the ~3xTTL
 * sweep eventually reclaims it. `repair` never read claims/ before, so it could not clear it.
 *
 * RED LINE: repair must NEVER deactivate a *live* claim (a claim the event ledger still recognizes as
 * the holder of a claimed/working/blocked task). It cleans ONLY unambiguous residue; anything else is
 * a finding, not a mutation.
 */

let repo: string;
let agent: string;
beforeEach(() => {
  repo = mkClaimRepo([{ key: 'a' }, { key: 'b' }], { policy: { max_parallel_tasks: 1, max_active_claims_per_agent: 1 } });
  agent = registerDefault(repo);
});
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
const readJson = (rel: string) => JSON.parse(readFileSync(join(runDir(), rel), 'utf8'));
const events = () => readFileSync(join(runDir(), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const taskClaims = () => readJson('claims/task-claims.json').claims as Array<{ claim_id: string; task_id: string; status: string; agent_id: string }>;
const pathClaims = () => readJson('claims/path-claims.json').claims as Array<{ claim_id: string; task_id: string; status: string }>;
const activeTaskClaims = () => taskClaims().filter((c) => c.status === 'active');

/** Flip an already-terminal (released) claim back to ACTIVE to simulate a torn claim-deactivation write:
 *  the ledger + task.json + list all say `ready`, but the claim residue is still ACTIVE. */
function reactivateReleasedClaims(): void {
  const file = join(runDir(), 'claims', 'task-claims.json');
  const { doc, rev } = readJsonState(file);
  for (const c of (doc as { claims: Array<Record<string, unknown>> }).claims) {
    c.status = 'active';
    c.released_at = null;
    c.release_reason = null;
    c.lease_until = new Date(Date.now() + 30 * 60_000).toISOString(); // future lease -> the 3xTTL sweep will NOT reclaim it
  }
  writeJsonStateAtomic(file, doc as Record<string, unknown>, { expectedRev: rev });
  const pf = join(runDir(), 'claims', 'path-claims.json');
  const p = readJsonState(pf);
  for (const c of (p.doc as { claims: Array<Record<string, unknown>> }).claims) {
    c.status = 'active';
    c.lease_until = new Date(Date.now() + 30 * 60_000).toISOString();
  }
  writeJsonStateAtomic(pf, p.doc as Record<string, unknown>, { expectedRev: p.rev });
}

/** Build the canonical P1-9 ghost: claim then release TASK-0001 (task+ledger back to `ready`),
 *  then reactivate the released claim residue so it is ACTIVE again with a future lease. */
function makeGhostOnTask0001(): void {
  claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent, taskId: 'TASK-0001' });
  releaseTask({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent });
  reactivateReleasedClaims();
}

describe('repair — ghost task/path claim reconciliation (P1-9)', () => {
  it('deactivates a ghost task-claim left ACTIVE on a task the ledger shows as ready (AUD-005)', () => {
    makeGhostOnTask0001();
    // sanity: the ghost is present and the derived state is really `ready`
    expect(readJson('team-task-list.json').tasks.find((t: { task_id: string }) => t.task_id === 'TASK-0001').status).toBe('ready');
    expect(activeTaskClaims().map((c) => c.claim_id)).toContain('CLAIM-task-0001');
    // audit already flags it (detection exists; only the fix was missing)
    const before = auditRun({ cwd: repo, runId: 'RUN-0001' });
    expect((before.data as { findings: Array<{ rule_id: string }> }).findings.some((f) => f.rule_id === 'AUD-005')).toBe(true);

    const env = repairRun({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);

    // the ghost is now terminal (non-active), so it no longer occupies a slot
    expect(taskClaims().find((c) => c.claim_id === 'CLAIM-task-0001')!.status).not.toBe('active');
    expect(activeTaskClaims()).toHaveLength(0);
    // a named, readable finding + a state_repaired event pointing at the claims file
    const data = env.data as { findings: string[]; repaired: Array<{ target: string }>; backup?: string };
    expect(data.findings.some((f) => f.includes('CLAIM-task-0001') && f.includes('TASK-0001'))).toBe(true);
    expect(data.backup).toBeTruthy();
    expect(events().some((e) => e.event === 'state_repaired' && String(e.payload?.target).includes('task-claims.json'))).toBe(true);
    // audit is clean of AUD-005 afterwards
    const after = auditRun({ cwd: repo, runId: 'RUN-0001' });
    expect((after.data as { findings: Array<{ rule_id: string }> }).findings.some((f) => f.rule_id === 'AUD-005')).toBe(false);
  });

  it('frees the wedged parallel slot: a ready task becomes claimable again after repair', () => {
    makeGhostOnTask0001();
    // HARM: fresh agent cannot claim the genuinely-ready TASK-0002 — the ghost fills the only slot
    const blocked = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: registerDefault(repo, 'win-b') });
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe('parallel_limit_reached');

    repairRun({ cwd: repo, runId: 'RUN-0001' });

    const ok = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: registerDefault(repo, 'win-c') });
    expect(ok.ok).toBe(true); // slot freed
  });

  it('also deactivates the ghost task’s dangling ACTIVE path-claim', () => {
    makeGhostOnTask0001();
    expect(pathClaims().some((c) => c.task_id === 'TASK-0001' && c.status === 'active')).toBe(true);
    repairRun({ cwd: repo, runId: 'RUN-0001' });
    expect(pathClaims().some((c) => c.task_id === 'TASK-0001' && c.status === 'active')).toBe(false);
  });

  it('deactivates a ghost active claim stranded on a terminal (verified) task (AUD-009)', async () => {
    // verification_passed completes the owner claim (verify.ts:220); a crash that loses that write
    // leaves it ACTIVE on a verified task — a ghost still counted against the parallel cap.
    const reviewer = (registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'claude-code', role: 'reviewer', label: 'win-rev' }).data as { agent_id: string }).agent_id;
    const verifier = (registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'claude-code', role: 'verifier', label: 'win-ver' }).data as { agent_id: string }).agent_id;
    await driveToVerified(repo, 'TASK-0001', 'a', agent, reviewer, verifier); // slugKey 'a' matches paths.allow src/a/**
    expect(readJson('team-task-list.json').tasks.find((t: { task_id: string }) => t.task_id === 'TASK-0001').status).toBe('verified');
    // simulate the lost completion: flip the completed claim back to active
    const file = join(runDir(), 'claims', 'task-claims.json');
    const { doc, rev } = readJsonState(file);
    (doc as { claims: Array<Record<string, unknown>> }).claims.find((c) => c.task_id === 'TASK-0001')!.status = 'active';
    writeJsonStateAtomic(file, doc as Record<string, unknown>, { expectedRev: rev });
    expect(activeTaskClaims()).toHaveLength(1);

    const env = repairRun({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);
    expect(activeTaskClaims()).toHaveLength(0); // ghost on the terminal task is cleaned
    expect((env.data as { findings: string[] }).findings.some((f) => f.includes('TASK-0001') && f.includes('verified'))).toBe(true);
  });

  // ----- RED LINE guards: a live claim is NEVER touched -----

  it('RED LINE: never deactivates a live claim on a genuinely CLAIMED task (ledger consistent)', () => {
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent, taskId: 'TASK-0001' }); // real, committed
    expect(readJson('team-task-list.json').tasks.find((t: { task_id: string }) => t.task_id === 'TASK-0001').status).toBe('claimed');

    const env = repairRun({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);

    // the live claim survives untouched
    expect(taskClaims().find((c) => c.task_id === 'TASK-0001')!.status).toBe('active');
    expect(pathClaims().find((c) => c.task_id === 'TASK-0001')!.status).toBe('active');
    // no claim mutation was emitted or reported
    expect(events().some((e) => e.event === 'state_repaired' && String(e.payload?.target).includes('claims'))).toBe(false);
    const data = env.data as { findings: string[] };
    expect(data.findings.some((f) => f.includes('CLAIM-task-0001'))).toBe(false);
  });

  it('RED LINE: never deactivates a live claim on a WORKING task', async () => {
    await setupWorking(repo, agent, 'TASK-0001', 'task-a'); // real worktree -> task_started -> working
    expect(readJson('team-task-list.json').tasks.find((t: { task_id: string }) => t.task_id === 'TASK-0001').status).toBe('working');

    repairRun({ cwd: repo, runId: 'RUN-0001' });

    expect(taskClaims().find((c) => c.task_id === 'TASK-0001')!.status).toBe('active');
    expect(events().some((e) => e.event === 'state_repaired' && String(e.payload?.target).includes('claims'))).toBe(false);
  });

  it('RED LINE: a committed claim is NOT cleaned even when task.json/list were hand-edited back to ready — the ledger is the source of truth', () => {
    // The instruction's literal "roll task.json back to ready, leave the ACTIVE claim" construction:
    // the task_claimed event is STILL committed, so the ledger says the claim is LIVE. Cleaning it
    // would kill a live claim. Repair must instead trust the ledger (restore the task), never the claim.
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent, taskId: 'TASK-0001' });
    const listFile = join(runDir(), 'team-task-list.json');
    const { doc, rev } = readJsonState(listFile);
    const row = (doc as { tasks: Array<{ task_id: string; status: string; owner_agent_id: string | null; claim_id: string | null }> }).tasks.find((r) => r.task_id === 'TASK-0001')!;
    row.status = 'ready'; row.owner_agent_id = null; row.claim_id = null;
    writeJsonStateAtomic(listFile, doc as Record<string, unknown>, { expectedRev: rev });
    const taskFile = join(runDir(), 'tasks', 'TASK-0001', 'task.json');
    const t = readJsonState(taskFile);
    (t.doc as { status: string }).status = 'ready';
    writeJsonStateAtomic(taskFile, t.doc as Record<string, unknown>, { expectedRev: t.rev });

    const env = repairRun({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);

    // claim survives (it is live per the ledger); repair rolls the derived state FORWARD to the ledger instead
    expect(taskClaims().find((c) => c.task_id === 'TASK-0001')!.status).toBe('active');
    expect(readJson('team-task-list.json').tasks.find((t: { task_id: string }) => t.task_id === 'TASK-0001').status).toBe('claimed');
    const data = env.data as { findings: string[] };
    expect(data.findings.some((f) => f.includes('CLAIM-task-0001'))).toBe(false);
  });

  it('RED LINE: never touches a live rework claim on a CHANGES_REQUESTED task (request_changes revives it ACTIVE)', async () => {
    // request_changes revives the owner's claim in place (review.ts:465): a changes_requested task
    // legitimately holds an ACTIVE owner claim. Repair must treat that as occupancy, not a ghost.
    await setupWorking(repo, agent, 'TASK-0001', 'task-a');
    submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: validDraft(repo) });
    const reviewer = (registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'claude-code', role: 'reviewer', label: 'win-review' }).data as { agent_id: string }).agent_id;
    reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer });
    reviewDecide({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer, decision: 'request_changes', review: { findings: [{ must_fix: true, message: 'redo the guard' }] } });
    expect(readJson('team-task-list.json').tasks.find((t: { task_id: string }) => t.task_id === 'TASK-0001').status).toBe('changes_requested');
    expect(taskClaims().find((c) => c.task_id === 'TASK-0001')!.status).toBe('active'); // healthy rework claim

    const env = repairRun({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);

    // the rework claim survives untouched, and repair says nothing about it (no noise on a healthy state)
    expect(taskClaims().find((c) => c.task_id === 'TASK-0001')!.status).toBe('active');
    const data = env.data as { findings: string[] };
    expect(data.findings.some((f) => f.includes('CLAIM-task-0001'))).toBe(false);
    expect(events().some((e) => e.event === 'state_repaired' && String(e.payload?.target).includes('claims'))).toBe(false);
  });

  // ----- ambiguity is reported, never auto-resolved -----

  it('reports (finding only, no auto-clean) a second ACTIVE claim on an occupied task (double-claim residue)', () => {
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent, taskId: 'TASK-0001' }); // C1 live, task claimed
    // inject a SECOND active claim on the same (occupied) task — ambiguous: engine can't know the keeper
    const file = join(runDir(), 'claims', 'task-claims.json');
    const { doc, rev } = readJsonState(file);
    const c1 = (doc as { claims: Array<Record<string, unknown>> }).claims[0]!;
    (doc as { claims: Array<Record<string, unknown>> }).claims.push({
      ...c1, claim_id: 'CLAIM-task-9999', status: 'active', attempt: 2,
    });
    writeJsonStateAtomic(file, doc as Record<string, unknown>, { expectedRev: rev });

    const env = repairRun({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);
    // NEITHER claim is auto-deactivated (occupied task -> ambiguous), but a finding surfaces it
    expect(taskClaims().filter((c) => c.task_id === 'TASK-0001' && c.status === 'active')).toHaveLength(2);
    const data = env.data as { findings: string[] };
    expect(data.findings.some((f) => f.includes('CLAIM-task-9999') || f.toLowerCase().includes('double') || f.toLowerCase().includes('adjudicat'))).toBe(true);
  });

  // ----- no noise on a healthy run; idempotent -----

  it('a healthy claimed run yields NO claim findings and NO claim events', () => {
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent, taskId: 'TASK-0001' });
    const env = repairRun({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);
    const data = env.data as { findings: string[]; repaired: unknown[] };
    expect(data.findings.some((f) => f.toLowerCase().includes('claim'))).toBe(false);
    expect(events().some((e) => e.event === 'state_repaired' && String(e.payload?.target).includes('claims'))).toBe(false);
  });

  it('is idempotent: a second repair after a ghost cleanup does nothing and writes no event', () => {
    makeGhostOnTask0001();
    repairRun({ cwd: repo, runId: 'RUN-0001' });
    const n = events().length;
    const second = repairRun({ cwd: repo, runId: 'RUN-0001' });
    expect(second.ok).toBe(true);
    expect((second.data as { repaired: unknown[] }).repaired).toHaveLength(0);
    expect(events().length).toBe(n);
  });
});
