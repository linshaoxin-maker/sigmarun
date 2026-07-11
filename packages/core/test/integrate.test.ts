import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { integrateStart, integrateRecord, reportRun } from '@sigmarun/core';
import { registerAgent } from '@sigmarun/dispatch';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault, driveToVerified } from '../../dispatch/test/fixture.js';

let repo: string;
let owner: string;
beforeEach(async () => {
  repo = mkClaimRepo(
    [
      { key: 'a', priority: 50 },
      { key: 'b', deps: ['a'], priority: 50 },
      { key: 'c', priority: 90 },
    ],
    // docs/10 §6 relaxation knob: the chained task must be claimable once its dep is verified
    { policy: { deps_satisfied_when: ['approved', 'verified', 'integrated', 'done'] } },
  );
  owner = registerDefault(repo, 'w-owner');
  const reviewer = (registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'claude-code', role: 'reviewer', label: 'w-r' }).data as { agent_id: string }).agent_id;
  const verifier = (registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'codex', role: 'verifier', label: 'w-v' }).data as { agent_id: string }).agent_id;
  await driveToVerified(repo, 'TASK-0001', 'a', owner, reviewer, verifier);
  await driveToVerified(repo, 'TASK-0002', 'b', owner, reviewer, verifier);
  await driveToVerified(repo, 'TASK-0003', 'c', owner, reviewer, verifier);
}, 30_000);
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
const readJson = (rel: string) => JSON.parse(readFileSync(join(runDir(), rel), 'utf8'));
const events = () => readFileSync(join(runDir(), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('integrate + report (16 §4; BDD-008-01/02/03)', () => {
  it('start: deterministic topo order (deps before priority), run integrating', () => {
    const env = integrateStart({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);
    const data = env.data as { branch: string; merge_order: Array<{ task_id: string }> };
    expect(data.branch).toBe('team/RUN-0001/integration');
    // T3 (priority 90, no deps) first in its layer; T1 before T2 (blocks edge)
    const order = data.merge_order.map((m) => m.task_id);
    expect(order.indexOf('TASK-0001')).toBeLessThan(order.indexOf('TASK-0002'));
    expect(order.length).toBe(3);
    expect(readJson('run.json').status).toBe('integrating');
    expect(events().some((e) => e.event === 'integration_started')).toBe(true);
  });

  it('record: merge success -> integrated + path claims released; --failed -> minimal VERIFY + changes_requested', () => {
    integrateStart({ cwd: repo, runId: 'RUN-0001' });
    const ok = integrateRecord({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0003', mergeCommit: 'abc1234' });
    expect(ok.ok).toBe(true);
    expect(readJson('tasks/TASK-0003/task.json').status).toBe('integrated');
    const released = readJson('claims/path-claims.json').claims.filter((c: { task_id: string }) => c.task_id === 'TASK-0003');
    expect(released.every((c: { status: string }) => c.status === 'released')).toBe(true);
    const taskClaims = readJson('claims/task-claims.json').claims.filter((c: { task_id: string }) => c.task_id === 'TASK-0003');
    expect(taskClaims.every((c: { status: string }) => ['completed', 'released', 'reclaimed'].includes(c.status))).toBe(true); // AUD-009: no live claim survives integration
    const ev = events().find((e) => e.event === 'task_integrated');
    expect(ev.payload.merge_commit).toBe('abc1234');

    const failed = integrateRecord({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0002', failed: true, reason: 'focused checks failed after merge' });
    expect(failed.ok).toBe(true);
    expect(readJson('tasks/TASK-0002/task.json').status).toBe('changes_requested');
    const vf = events().filter((e) => e.event === 'verification_failed').pop();
    expect(vf.payload.failures_mapped).toEqual(['TASK-0002']);
    expect(vf.payload.verify_id).toMatch(/^VERIFY-\d{4}$/); // auto minimal record keeps #38 contract
  });

  it('report: writes integration.md + report.md, run -> reported, main untouched (BDD-008-03)', () => {
    const mainBefore = execFileSync('git', ['-C', repo, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();
    integrateStart({ cwd: repo, runId: 'RUN-0001' });
    integrateRecord({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', mergeCommit: 'a111111' });
    integrateRecord({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0002', mergeCommit: 'b222222' });
    integrateRecord({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0003', failed: true, reason: 'flaky check' });

    const env = reportRun({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);
    expect(readJson('run.json').status).toBe('reported');
    const integration = readFileSync(join(runDir(), 'integration.md'), 'utf8');
    expect(integration).toContain('TASK-0001');
    expect(integration).toContain('a111111');
    expect(integration).toContain('TASK-0003'); // reverted list
    expect(existsSync(join(runDir(), 'report.md'))).toBe(true);
    expect(events().some((e) => e.event === 'run_reported')).toBe(true);
    const mainAfter = execFileSync('git', ['-C', repo, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(mainAfter).toBe(mainBefore); // gateway never commits to the checkout
  });

  it('report refuses while verified tasks remain unintegrated', () => {
    integrateStart({ cwd: repo, runId: 'RUN-0001' });
    const env = reportRun({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('invalid_transition');
  });
});
