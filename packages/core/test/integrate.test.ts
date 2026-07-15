import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { integrateStart, integrateRecord, reportRun } from '@sigmarun/core';
import { foldLedger } from '@sigmarun/audit';
import { statusRun } from '@sigmarun/watch';
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
}, 120_000);
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
const readJson = (rel: string) => JSON.parse(readFileSync(join(runDir(), rel), 'utf8'));
const events = () => readFileSync(join(runDir(), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('integrate + report (16 §4; BDD-008-01/02/03)', () => {
  it('verified tasks carry no live task claim (AUD-009 row 5 — verify completes the claim)', () => {
    const claims = readJson('claims/task-claims.json').claims as Array<{ task_id: string; status: string }>;
    for (const id of ['TASK-0001', 'TASK-0002', 'TASK-0003']) {
      const live = claims.filter((c) => c.task_id === id && ['active', 'submitted'].includes(c.status));
      expect(live).toEqual([]);
    }
  });

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

    // 15 §3.3 `integrated -> done`: reporting accepts the merged tasks (dogfood finding #3)
    for (const id of ['TASK-0001', 'TASK-0002']) {
      expect(readJson(`tasks/${id}/task.json`).status).toBe('done');
      expect(readJson('team-task-list.json').tasks.find((r: { task_id: string }) => r.task_id === id).status).toBe('done');
    }
    expect(readJson('tasks/TASK-0003/task.json').status).toBe('changes_requested'); // failed merge is not accepted
    const doneEvents = events().filter((e) => e.event === 'task_done');
    expect(doneEvents.map((e) => e.task_id).sort()).toEqual(['TASK-0001', 'TASK-0002']);
    expect(doneEvents[0].payload.via).toBe('report_accept');
    // replay folds task_done -> done, so AUD-034 stays coherent on reported runs
    expect(foldLedger(events()).get('TASK-0001')?.status).toBe('done');
    // docs/03 S9 fractional progress: done 1 + done 1 + changes_requested 0.45 over 3
    const status = statusRun({ cwd: repo, runId: 'RUN-0001' });
    expect((status.data as { progress_pct: number }).progress_pct).toBe(82);
  });

  it('report refuses while verified tasks remain unintegrated', () => {
    integrateStart({ cwd: repo, runId: 'RUN-0001' });
    const env = reportRun({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('invalid_transition');
  });
});

describe('run reopen — integrating is no longer a one-way street (docs/15 §2.2; S7)', () => {
  it('reopen -> active; task add + publish work again; integrate start re-enters', async () => {
    const { runReopen, taskAdd, publishTasks } = await import('@sigmarun/core');
    integrateStart({ cwd: repo, runId: 'RUN-0001' });
    expect(JSON.parse(readFileSync(join(runDir(), 'run.json'), 'utf8')).status).toBe('integrating');

    // mid-integration you find a missing piece — previously every door was welded shut
    const blockedAdd = taskAdd({ cwd: repo, runId: 'RUN-0001', task: { title: 'Hotfix', objective: 'Patch the gap.', acceptance: ['patched'] } });
    expect(blockedAdd.code).toBe('invalid_transition');

    const reopened = runReopen({ cwd: repo, runId: 'RUN-0001' });
    expect(reopened.ok).toBe(true);
    expect(events().some((e) => e.event === 'integration_reopened')).toBe(true);

    const added = taskAdd({ cwd: repo, runId: 'RUN-0001', task: { title: 'Hotfix', objective: 'Patch the gap.', acceptance: ['patched'] } });
    expect(added.ok).toBe(true);
    const published = publishTasks({ cwd: repo, runId: 'RUN-0001', taskIds: [(added.data as { task_id: string }).task_id] });
    expect(published.ok).toBe(true);

    const again = integrateStart({ cwd: repo, runId: 'RUN-0001' });
    expect(again.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(runDir(), 'run.json'), 'utf8')).status).toBe('integrating');
  });

  it('reopen refuses outside integrating', async () => {
    const { runReopen } = await import('@sigmarun/core');
    const env = runReopen({ cwd: repo, runId: 'RUN-0001' }); // run is active here
    expect(env.ok).toBe(false);
    expect(env.code).toBe('invalid_transition');
  });
});

describe('require_verification=false — the D6-symmetric verify-gate knob (docs/15 §10; remediation R0-9)', () => {
  let lite: string;
  afterEach(() => cleanup(lite));

  async function approveViaPolicySkip(taskId: string, slug: string, agent: string): Promise<void> {
    const { setupWorking } = await import('../../dispatch/test/fixture.js');
    const { submitEvidence } = await import('@sigmarun/core');
    const { validDraft } = await import('./submit-fixture.js');
    await setupWorking(lite, agent, taskId, slug);
    submitEvidence({
      cwd: lite, runId: 'RUN-0001', taskId, agentId: agent,
      evidencePath: validDraft(lite, {
        changed_files: [{ path: `src/${slug.replace('task-', '')}/index.ts`, change_type: 'added' }],
        acceptance: [{ item: `${slug.replace('task-', '')} done.`, status: 'met' }],
      }),
    });
  }

  it('approved tasks integrate and report when the run policy waives verification', async () => {
    lite = mkClaimRepo([{ key: 'a' }, { key: 'b' }], { policy: { require_review: false, require_verification: false } });
    const w = registerDefault(lite, 'w-owner');
    await approveViaPolicySkip('TASK-0001', 'task-a', w);
    await approveViaPolicySkip('TASK-0002', 'task-b', w);
    const liteDir = join(lite, '.team', 'runs', 'RUN-0001');
    expect(JSON.parse(readFileSync(join(liteDir, 'tasks', 'TASK-0001', 'task.json'), 'utf8')).status).toBe('approved');

    const start = integrateStart({ cwd: lite, runId: 'RUN-0001' });
    expect(start.ok).toBe(true);
    expect((start.data as { merge_order: unknown[] }).merge_order.length).toBe(2);

    const recA = integrateRecord({ cwd: lite, runId: 'RUN-0001', taskId: 'TASK-0001', mergeCommit: 'a1b2c3d' });
    expect(recA.ok).toBe(true);

    // an approved-but-unintegrated task must still block the report
    const early = reportRun({ cwd: lite, runId: 'RUN-0001' });
    expect(early.ok).toBe(false);
    expect(early.code).toBe('invalid_transition');

    const recB = integrateRecord({ cwd: lite, runId: 'RUN-0001', taskId: 'TASK-0002', mergeCommit: 'e4f5a6b' });
    expect(recB.ok).toBe(true);
    const rep = reportRun({ cwd: lite, runId: 'RUN-0001' });
    expect(rep.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(liteDir, 'run.json'), 'utf8')).status).toBe('reported');
    expect(JSON.parse(readFileSync(join(liteDir, 'tasks', 'TASK-0001', 'task.json'), 'utf8')).status).toBe('done');
  });

  it('with the gate ON (default), an approved task does not integrate', async () => {
    lite = mkClaimRepo([{ key: 'a' }], { policy: { require_review: false } });
    const w = registerDefault(lite, 'w-owner');
    await approveViaPolicySkip('TASK-0001', 'task-a', w);
    const start = integrateStart({ cwd: lite, runId: 'RUN-0001' });
    expect(start.ok).toBe(false);
    expect(start.code).toBe('invalid_transition');
  });
});
