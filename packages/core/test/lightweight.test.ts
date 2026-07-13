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

  it('done is refused on a full (non-lightweight) run', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    initProject({ cwd: repo });
    importRun({ cwd: repo, payload: validPayload() }); // full pipeline
    const env = taskDone({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: 'x' });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('invalid_transition');
    expect(env.message).toMatch(/not lightweight/);
  });
});
