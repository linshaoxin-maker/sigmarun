import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonState, writeJsonStateAtomic } from '@sigmarun/storage';
import { claimNext, registerAgent, reviewClaim, reviewDecide, verifySubmit } from '@sigmarun/dispatch';
import { submitEvidence } from '@sigmarun/core';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault, setupWorking } from './fixture.js';
import { validDraft } from '../../core/test/submit-fixture.js';

let repo: string;
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
const readJson = (rel: string) => JSON.parse(readFileSync(join(runDir(), rel), 'utf8'));
const events = () => readFileSync(join(runDir(), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

function verifyDraftFile(overrides: Record<string, unknown> = {}): string {
  const dir = join(repo, '..', `vfx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'v.log');
  writeFileSync(out, 'ok\n');
  const draft = {
    target: { kind: 'task', task_id: 'TASK-0001' },
    checks: [{ name: 'focused tests', cmd: 'npm test', exit_code: 0, output_file: out, status: 'pass' }],
    gates: { build: 'pass', focused_tests: 'pass', regression_tests: 'skipped', scope_check: 'pass', evidence_complete: 'pass' },
    skip_reasons: { regression_tests: 'covered elsewhere' },
    verdict: 'pass',
    failures_mapped: [],
    ...overrides,
  };
  const p = join(dir, 'verify.json');
  writeFileSync(p, JSON.stringify(draft));
  return p;
}

async function submitTask1(owner: string): Promise<void> {
  await setupWorking(repo, owner);
  submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner, evidencePath: validDraft(repo) });
}

describe('review sweep persists on every path (fix #3)', () => {
  it('a guard-failure call after lease expiry still lands the release on disk, exactly once', async () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const owner = registerDefault(repo, 'w-owner');
    await submitTask1(owner);
    const reviewer = (registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'claude-code', role: 'reviewer', label: 'w-r' }).data as { agent_id: string }).agent_id;
    reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer });

    const file = join(runDir(), 'claims', 'review-claims.json');
    const { doc, rev } = readJsonState(file);
    (doc as { claims: Array<{ lease_until: string }> }).claims[0].lease_until = new Date(Date.now() - 60_000).toISOString();
    writeJsonStateAtomic(file, doc, { expectedRev: rev });

    // owner triggers the sweep and then fails the INV-008 guard — previously a half-commit
    const denied = reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner });
    expect(denied.code).toBe('self_approval_forbidden');
    expect(readJson('claims/review-claims.json').claims[0].status).toBe('released'); // persisted despite the early return
    expect(events().filter((e) => e.event === 'review_released').length).toBe(1);

    // a second sweep-triggering call must not duplicate the release event
    const denied2 = reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner });
    expect(denied2.code).toBe('self_approval_forbidden');
    expect(events().filter((e) => e.event === 'review_released').length).toBe(1);
  });
});

describe('verify independence + registration (fix #4)', () => {
  it('a historical owner cannot verify their own task; unregistered agents are rejected', async () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const owner = registerDefault(repo, 'w-owner');
    await submitTask1(owner);
    const reviewer = (registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'claude-code', role: 'reviewer', label: 'w-r' }).data as { agent_id: string }).agent_id;
    reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer });
    reviewDecide({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer, decision: 'approve', review: { findings: [] } });

    const selfVerify = verifySubmit({ cwd: repo, runId: 'RUN-0001', agentId: owner, verifyPath: verifyDraftFile() });
    expect(selfVerify.ok).toBe(false);
    expect(selfVerify.code).toBe('self_approval_forbidden');
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('approved'); // untouched

    const ghost = verifySubmit({ cwd: repo, runId: 'RUN-0001', agentId: 'AGENT-ghost-001', verifyPath: verifyDraftFile() });
    expect(ghost.code).toBe('agent_not_registered');
  });
});

describe('run-level failures_mapped guards (fix #6)', () => {
  it('phantom ids and non-revertible tasks are rejected before any write', async () => {
    repo = mkClaimRepo([{ key: 'a' }, { key: 'b' }]);
    const owner = registerDefault(repo, 'w-owner');
    await submitTask1(owner); // TASK-0001 submitted; TASK-0002 stays ready
    const verifier = (registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'codex', role: 'verifier', label: 'w-v' }).data as { agent_id: string }).agent_id;

    const phantom = verifySubmit({
      cwd: repo, runId: 'RUN-0001', agentId: verifier,
      verifyPath: verifyDraftFile({
        target: { kind: 'run' },
        gates: { build: 'pass', focused_tests: 'fail', regression_tests: 'skipped', scope_check: 'pass', evidence_complete: 'pass' },
        verdict: 'fail',
        failures_mapped: ['TASK-0999'],
      }),
    });
    expect(phantom.code).toBe('schema_invalid');
    expect((phantom.data as { errors: string[] }).errors.some((e) => e.includes('TASK-0999'))).toBe(true);

    const notRevertible = verifySubmit({
      cwd: repo, runId: 'RUN-0001', agentId: verifier,
      verifyPath: verifyDraftFile({
        target: { kind: 'run' },
        gates: { build: 'pass', focused_tests: 'fail', regression_tests: 'skipped', scope_check: 'pass', evidence_complete: 'pass' },
        verdict: 'fail',
        failures_mapped: ['TASK-0002'], // ready — never verified
      }),
    });
    expect(notRevertible.code).toBe('schema_invalid');
    expect(readJson('tasks/TASK-0002/task.json').status).toBe('ready'); // zero mutation
  });
});

describe('directed claims respect the run-wide parallel cap (fix #7)', () => {
  it('claim-next --task hits parallel_limit_reached once the cap is full', () => {
    repo = mkClaimRepo(
      [{ key: 'a' }, { key: 'b' }],
      { policy: { max_parallel_tasks: 1 } },
    );
    const a1 = registerDefault(repo, 'w-1');
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: a1 });
    const a2 = registerDefault(repo, 'w-2', 'codex');
    const directed = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: a2, taskId: 'TASK-0002' });
    expect(directed.ok).toBe(false);
    expect(directed.code).toBe('parallel_limit_reached');
    expect(readJson('claims/task-claims.json').claims.length).toBe(1);
  });
});

describe('verify outputs go through the same cut-then-redact pipeline (fix: unbounded logs)', () => {
  it('truncates long verify outputs and records output_truncated', async () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const owner = registerDefault(repo, 'w-owner');
    await submitTask1(owner);
    const reviewer = (registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'claude-code', role: 'reviewer', label: 'w-r' }).data as { agent_id: string }).agent_id;
    reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer });
    reviewDecide({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer, decision: 'approve', review: { findings: [] } });
    const verifier = (registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'codex', role: 'verifier', label: 'w-v' }).data as { agent_id: string }).agent_id;

    const draft = verifyDraftFile();
    const parsed = JSON.parse(readFileSync(draft, 'utf8'));
    writeFileSync(parsed.checks[0].output_file, Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join('\n'));
    const env = verifySubmit({ cwd: repo, runId: 'RUN-0001', agentId: verifier, verifyPath: draft });
    expect(env.ok).toBe(true);
    const record = readJson('verification/VERIFY-0001.json');
    expect(record.checks[0].output_truncated).toBe(true);
    const log = readFileSync(join(runDir(), 'verification', record.checks[0].output_ref), 'utf8');
    expect(log).toContain('lines truncated');
  });
});
