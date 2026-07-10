import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { importRun, initProject, publishTasks, runShow } from '@sigmarun/core';
import { mkTmpGitRepo, cleanup } from '../../storage/test/helpers.js';
import { validPayload } from './payload-fixture.js';

let repo: string;
beforeEach(() => {
  repo = mkTmpGitRepo();
  initProject({ cwd: repo });
  importRun({ cwd: repo, payload: validPayload() });
});
afterEach(() => cleanup(repo));

describe('run show (read-only; dispatch flow step 1)', () => {
  it('returns the run summary, task rollup, and status counts', () => {
    publishTasks({ cwd: repo, runId: 'RUN-0001' });
    const env = runShow({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);
    const data = env.data as {
      run: { run_id: string; status: string; title: string };
      tasks: Array<{ task_id: string; status: string; owner_agent_id: string | null }>;
      counts: Record<string, number>;
    };
    expect(data.run.run_id).toBe('RUN-0001');
    expect(data.run.status).toBe('active');
    expect(data.tasks.length).toBe(2);
    expect(data.counts.ready).toBe(2);
  });

  it('unknown run is run_not_found', () => {
    const env = runShow({ cwd: repo, runId: 'RUN-0099' });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('run_not_found');
  });
});
