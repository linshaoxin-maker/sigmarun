import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimNext, registerAgent, reviewClaim, reviewDecide, verifySubmit } from '@sigmarun/dispatch';
import { submitEvidence } from '@sigmarun/core';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault, setupWorking } from './fixture.js';
import { validDraft } from '../../core/test/submit-fixture.js';

let repo: string;
let owner: string;
let reviewer: string;
let verifier: string;
beforeEach(async () => {
  repo = mkClaimRepo([{ key: 'a' }]);
  owner = registerDefault(repo, 'win-owner');
  await setupWorking(repo, owner);
  submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner, evidencePath: validDraft(repo) });
  reviewer = (registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'claude-code', role: 'reviewer', label: 'w-r' }).data as { agent_id: string }).agent_id;
  reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer });
  reviewDecide({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer, decision: 'approve', review: { findings: [] } });
  verifier = (registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'codex', role: 'verifier', label: 'w-v' }).data as { agent_id: string }).agent_id;
});
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
const readJson = (rel: string) => JSON.parse(readFileSync(join(runDir(), rel), 'utf8'));
const events = () => readFileSync(join(runDir(), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

function verifyDraft(overrides: Record<string, unknown> = {}): string {
  const dir = join(repo, '..', `vd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'v.log');
  writeFileSync(out, 'all green\n');
  const draft = {
    target: { kind: 'task', task_id: 'TASK-0001' },
    checks: [{ name: 'focused tests', cmd: 'npm test', exit_code: 0, output_file: out, status: 'pass' }],
    gates: { build: 'pass', focused_tests: 'pass', regression_tests: 'skipped', scope_check: 'pass', evidence_complete: 'pass' },
    skip_reasons: { regression_tests: 'run-level covers it' },
    verdict: 'pass',
    failures_mapped: [],
    ...overrides,
  };
  const p = join(dir, 'verify.json');
  writeFileSync(p, JSON.stringify(draft));
  return p;
}

describe('verify submit — task target (14 §4; BDD-006-07 positive gate)', () => {
  it('pass: writes VERIFY record + outputs, approved -> verified, event pair', () => {
    const env = verifySubmit({ cwd: repo, runId: 'RUN-0001', agentId: verifier, verifyPath: verifyDraft() });
    expect(env.ok).toBe(true);
    const record = readJson('verification/VERIFY-0001.json');
    expect(record.verdict).toBe('pass');
    expect(record.target).toEqual({ kind: 'task', task_id: 'TASK-0001' });
    expect(record.checks[0].output_ref).toBe('outputs/VERIFY-0001-01.log');
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('verified');
    const names = events().map((e) => e.event);
    expect(names).toContain('verification_started');
    expect(names).toContain('verification_passed');
  });

  it('rejects exit_code/status mismatch and verdict contradicting a failing gate', () => {
    const bad = verifySubmit({
      cwd: repo, runId: 'RUN-0001', agentId: verifier,
      verifyPath: verifyDraft({ checks: [{ name: 't', cmd: 'x', exit_code: 1, output_file: null, status: 'pass' }] }),
    });
    expect(bad.code).toBe('schema_invalid');
    const contradict = verifySubmit({
      cwd: repo, runId: 'RUN-0001', agentId: verifier,
      verifyPath: verifyDraft({ gates: { build: 'fail', focused_tests: 'pass', regression_tests: 'pass', scope_check: 'pass', evidence_complete: 'pass' }, verdict: 'pass' }),
    });
    expect(contradict.code).toBe('schema_invalid');
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('approved'); // untouched
  });

  it('an all-skipped verification cannot carry verdict=pass (vacuous truth; remediation B5)', () => {
    const env = verifySubmit({
      cwd: repo, runId: 'RUN-0001', agentId: verifier,
      verifyPath: verifyDraft({
        checks: [],
        gates: { build: 'skipped', focused_tests: 'skipped', regression_tests: 'skipped', scope_check: 'skipped', evidence_complete: 'skipped' },
        skip_reasons: { build: 'n/a', focused_tests: 'n/a', regression_tests: 'n/a', scope_check: 'n/a', evidence_complete: 'n/a' },
        verdict: 'pass',
      }),
    });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('schema_invalid');
    expect((env.data as { errors: string[] }).errors.some((e) => e.includes('at least one executed'))).toBe(true);
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('approved'); // untouched
  });

  it('fail verdict maps the task back to changes_requested and revives the owner claim', () => {
    const env = verifySubmit({
      cwd: repo, runId: 'RUN-0001', agentId: verifier,
      verifyPath: verifyDraft({
        gates: { build: 'pass', focused_tests: 'fail', regression_tests: 'skipped', scope_check: 'pass', evidence_complete: 'pass' },
        verdict: 'fail',
        failures_mapped: ['TASK-0001'],
      }),
    });
    expect(env.ok).toBe(true);
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('changes_requested');
    expect(readJson('claims/task-claims.json').claims[0].status).toBe('active'); // revived
    const failed = events().find((e) => e.event === 'verification_failed');
    expect(failed.payload.failures_mapped).toEqual(['TASK-0001']);
  });

  it('a verified task cannot be re-verified (invalid_transition) — BDD-006-07 negative gate', () => {
    verifySubmit({ cwd: repo, runId: 'RUN-0001', agentId: verifier, verifyPath: verifyDraft() });
    const again = verifySubmit({ cwd: repo, runId: 'RUN-0001', agentId: verifier, verifyPath: verifyDraft() });
    expect(again.code).toBe('invalid_transition');
  });

  it('claim-next --role verifier synthesizes verify_work from the approved queue (D15)', () => {
    const env = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: verifier, role: 'verifier' });
    expect(env.ok).toBe(true);
    const data = env.data as { kind: string; task_id: string };
    expect(data.kind).toBe('verify_work');
    expect(data.task_id).toBe('TASK-0001');
    const nothing = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: owner, role: 'verifier' });
    expect(nothing.code).toBe('no_claimable_task'); // owner filtered by independence guard
  });
});
