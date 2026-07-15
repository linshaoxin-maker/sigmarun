import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importRun, taskDone, initProject } from '@sigmarun/core';
import { claimNext } from '@sigmarun/dispatch';
import { statusRun } from '@sigmarun/watch';
import { mkTmpGitRepo, cleanup } from '../../storage/test/helpers.js';
import { validPayload } from './payload-fixture.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()!); });

function lightweightRun(): string {
  const repo = mkTmpGitRepo(); dirs.push(repo);
  initProject({ cwd: repo });
  importRun({ cwd: repo, payload: validPayload(), lightweight: true });
  return repo;
}
const readJson = (repo: string, rel: string) => JSON.parse(readFileSync(join(repo, '.team', 'runs', 'RUN-0001', rel), 'utf8'));

describe('lightweight mode — decompose → claim → done (no review/verify/integrate)', () => {
  it('import --lightweight makes tasks immediately claimable and the run active', () => {
    const repo = lightweightRun();
    expect(readJson(repo, 'run.json').status).toBe('active');
    expect(readJson(repo, 'run.json').lightweight).toBe(true);
    expect(readJson(repo, 'team-task-list.json').tasks.every((t: { status: string }) => t.status === 'ready')).toBe(true);
    expect(readJson(repo, 'run.json').default_policy.require_review).toBe(false);
    expect(readJson(repo, 'run.json').default_policy.require_verification).toBe(false);
  });

  it('any --agent id self-registers on claim, and done completes the task directly', () => {
    const repo = lightweightRun();
    // no `agent register` step — a free-form id just works
    const claim = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: 'codex-1' });
    expect(claim.ok).toBe(true);
    const taskId = (claim.data as { task_id: string }).task_id;
    expect((claim.next_actions).some((a) => a.includes('sigmarun done'))).toBe(true);

    const done = taskDone({ cwd: repo, runId: 'RUN-0001', taskId, agentId: 'codex-1', note: 'shipped' });
    expect(done.ok).toBe(true);
    expect(readJson(repo, `tasks/${taskId}/task.json`).status).toBe('done');
    const ev = readFileSync(join(repo, '.team', 'runs', 'RUN-0001', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const doneEv = ev.find((e) => e.event === 'task_done' && e.task_id === taskId);
    expect(doneEv.payload.via).toBe('done_command');
    // the claim is released, no live claim survives
    const claims = readJson(repo, 'claims/task-claims.json').claims;
    expect(claims.every((c: { status: string }) => c.status !== 'active')).toBe(true);
  });

  it('progress reaches 100% after both tasks are done', () => {
    const repo = lightweightRun();
    for (const id of ['TASK-0001', 'TASK-0002']) {
      claimNext({ cwd: repo, runId: 'RUN-0001', agentId: `w-${id}` });
      taskDone({ cwd: repo, runId: 'RUN-0001', taskId: id, agentId: `w-${id}` });
    }
    expect((statusRun({ cwd: repo, runId: 'RUN-0001' }).data as { progress_pct: number }).progress_pct).toBe(100);
  });

  it('another agent cannot mark a task it does not hold as done', () => {
    const repo = lightweightRun();
    const taskId = (claimNext({ cwd: repo, runId: 'RUN-0001', agentId: 'owner' }).data as { task_id: string }).task_id;
    const env = taskDone({ cwd: repo, runId: 'RUN-0001', taskId, agentId: 'intruder' });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('not_claim_owner');
  });

  it('the mode wall: submit/review/verify/integrate are refused on a lightweight run with mode_mismatch (S3)', async () => {
    const repo = lightweightRun();
    const claim = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: 'win-1' });
    const taskId = (claim.data as { task_id: string }).task_id;

    const { submitEvidence, integrateStart } = await import('@sigmarun/core');
    const submit = submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId, agentId: 'win-1', evidencePath: '/nope.json' });
    expect(submit.code).toBe('mode_mismatch');
    expect(submit.next_actions.join(' ')).toContain('sigmarun done');

    const { reviewClaim, verifySubmit } = await import('@sigmarun/dispatch');
    const review = reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId, agentId: 'win-2' });
    expect(review.code).toBe('mode_mismatch');
    const verify = verifySubmit({ cwd: repo, runId: 'RUN-0001', agentId: 'win-2', verifyPath: '/nope.json' });
    expect(verify.code).toBe('mode_mismatch');
    const integ = integrateStart({ cwd: repo, runId: 'RUN-0001' });
    expect(integ.code).toBe('mode_mismatch');
    const synth = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: 'win-3', role: 'reviewer' });
    expect(synth.code).toBe('mode_mismatch');

    // the task is untouched by all five refusals and still completes the lightweight way
    expect(readJson(repo, `tasks/${taskId}/task.json`).status).toBe('claimed');
    expect(taskDone({ cwd: repo, runId: 'RUN-0001', taskId, agentId: 'win-1' }).ok).toBe(true);
  });

  it('run list carries lightweight + progress_pct so front ends can pick the right run', async () => {
    const repo = lightweightRun();
    const { runList } = await import('@sigmarun/watch');
    const env = runList({ cwd: repo });
    const runs = (env.data as { runs: Array<{ run_id: string; lightweight: boolean; progress_pct: number | null }> }).runs;
    expect(runs[0]!.lightweight).toBe(true);
    expect(typeof runs[0]!.progress_pct).toBe('number');
  });

  it('a lightweight run closes: done-all -> report -> reported -> archive; watch sees terminal (S8/D21)', async () => {
    const repo = lightweightRun();
    const { reportRun, runArchive } = await import('@sigmarun/core');

    // report refuses while tasks remain open
    const t1 = (claimNext({ cwd: repo, runId: 'RUN-0001', agentId: 'win-1' }).data as { task_id: string }).task_id;
    taskDone({ cwd: repo, runId: 'RUN-0001', taskId: t1, agentId: 'win-1' });
    const early = reportRun({ cwd: repo, runId: 'RUN-0001' });
    expect(early.ok).toBe(false);
    expect(early.code).toBe('invalid_transition');

    // the LAST done points at report
    const t2 = (claimNext({ cwd: repo, runId: 'RUN-0001', agentId: 'win-1' }).data as { task_id: string }).task_id;
    const last = taskDone({ cwd: repo, runId: 'RUN-0001', taskId: t2, agentId: 'win-1' });
    expect(last.next_actions.join(' ')).toContain(`sigmarun report RUN-0001`);

    const rep = reportRun({ cwd: repo, runId: 'RUN-0001' });
    expect(rep.ok).toBe(true);
    expect(readJson(repo, 'run.json').status).toBe('reported');
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(repo, '.team', 'runs', 'RUN-0001', 'report.md'))).toBe(true);
    expect(existsSync(join(repo, '.team', 'runs', 'RUN-0001', 'integration.md'))).toBe(false);

    const { watchOnce } = await import('@sigmarun/watch');
    expect((watchOnce({ cwd: repo, runId: 'RUN-0001' }).data as { terminal: boolean }).terminal).toBe(true);
    expect(runArchive({ cwd: repo, runId: 'RUN-0001' }).ok).toBe(true);
    expect(readJson(repo, 'run.json').status).toBe('archived');
  });

  it('done is refused on a full (non-lightweight) run', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    initProject({ cwd: repo });
    importRun({ cwd: repo, payload: validPayload() }); // full pipeline
    const env = taskDone({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: 'x' });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('mode_mismatch');
    expect(env.message).toMatch(/not lightweight/);
  });
});
