import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimNext, heartbeat, reviewClaim, verifySubmit } from '@sigmarun/dispatch';
import { registerAgent } from '@sigmarun/dispatch';
import { submitEvidence } from '@sigmarun/core';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault, setupWorking } from './fixture.js';
import { validDraft } from '../../core/test/submit-fixture.js';
import { mkdirSync, writeFileSync } from 'node:fs';

let repo: string;
let owner: string;
beforeEach(async () => {
  repo = mkClaimRepo([{ key: 'a' }]);
  owner = registerDefault(repo, 'w-owner');
  await setupWorking(repo, owner);
  submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner, evidencePath: validDraft(repo) });
}, 30_000);
afterEach(() => cleanup(repo));

const events = () => readFileSync(join(repo, '.team', 'runs', 'RUN-0001', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const reg = (label: string, role: string) =>
  (registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'codex', role, label }).data as { agent_id: string }).agent_id;

describe('smoke-test round fixes (L9/L13): gate leases', () => {
  it('heartbeat extends an active review claim instead of claim_not_found (L9)', () => {
    const rev = reg('w-rev', 'reviewer');
    const claimed = reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: rev });
    expect(claimed.ok).toBe(true);
    const hb = heartbeat({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: rev });
    expect(hb.ok).toBe(true);
    expect((hb.data as { kind: string }).kind).toBe('review');
  });

  it('verify synthesis leases the work with mutual exclusion and heartbeat support (L13, 15 S7)', async () => {
    const rev = reg('w-rev', 'reviewer');
    reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: rev });
    const { reviewDecide } = await import('@sigmarun/dispatch');
    reviewDecide({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: rev, decision: 'approve', review: { findings: [] } });

    const v1 = reg('w-v1', 'verifier');
    const v2 = reg('w-v2', 'verifier');
    const got = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: v1, role: 'verifier' });
    expect(got.ok).toBe(true);
    const data = got.data as { kind: string; task_id: string; claim_id: string; lease_until: string };
    expect(data.kind).toBe('verify_work');
    expect(data.claim_id).toMatch(/^CLAIM-verify-/);
    expect(events().some((e) => e.event === 'verify_claimed')).toBe(true);

    // second verifier is NOT offered the leased task
    const second = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: v2, role: 'verifier' });
    expect(second.ok).toBe(false);
    expect(second.code).toBe('no_claimable_task');

    // same verifier re-asking gets the same lease (idempotent re-offer)
    const again = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: v1, role: 'verifier' });
    expect(again.ok).toBe(true);
    expect((again.data as { claim_id: string }).claim_id).toBe(data.claim_id);

    // heartbeat extends the verify lease
    const hb = heartbeat({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: v1 });
    expect(hb.ok).toBe(true);
    expect((hb.data as { kind: string }).kind).toBe('verify');

    // verify submit completes the lease; the task can then be verified by the record
    const outDir = join(repo, '..', `smoke-vout-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(outDir, { recursive: true });
    const log = join(outDir, 'v.log');
    writeFileSync(log, 'ok\n');
    const draft = join(outDir, 'v.json');
    writeFileSync(draft, JSON.stringify({
      target: { kind: 'task', task_id: 'TASK-0001' },
      checks: [{ name: 'focused', cmd: 'true', exit_code: 0, output_file: log, status: 'pass' }],
      gates: { build: 'pass', focused_tests: 'pass', regression_tests: 'skipped', scope_check: 'pass', evidence_complete: 'pass' },
      skip_reasons: { regression_tests: 'covered at run level' },
      verdict: 'pass', failures_mapped: [],
    }));
    const env = verifySubmit({ cwd: repo, runId: 'RUN-0001', agentId: v1, verifyPath: draft });
    expect(env.ok).toBe(true);
    const rc = JSON.parse(readFileSync(join(repo, '.team', 'runs', 'RUN-0001', 'claims', 'review-claims.json'), 'utf8'));
    const mine = rc.claims.filter((c: { kind?: string }) => (c.kind ?? 'review') === 'verify');
    expect(mine.every((c: { status: string }) => c.status !== 'active')).toBe(true);
  }, 30_000);
});
