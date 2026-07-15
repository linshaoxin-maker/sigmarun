import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importRun, initProject, publishTasks } from '@sigmarun/core';
import { readJsonState, writeJsonStateAtomic } from '@sigmarun/storage';
import { mkTmpGitRepo, cleanup } from '../../storage/test/helpers.js';
import { validPayload } from './payload-fixture.js';

let repo: string;
beforeEach(() => {
  repo = mkTmpGitRepo();
  initProject({ cwd: repo });
  importRun({ cwd: repo, payload: validPayload() });
});
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
const events = (dir = runDir()) => readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('task publish (BDD-002-01; contracts docs/15 §6/§2.3)', () => {
  it('publishes all draft tasks, activates the run, and commits events in order', () => {
    const env = publishTasks({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);
    expect((env.data as { published: number; run_status: string }).published).toBe(2);
    expect((env.data as { run_status: string }).run_status).toBe('active');
    const list = JSON.parse(readFileSync(join(runDir(), 'team-task-list.json'), 'utf8'));
    expect(list.tasks.map((t: { status: string }) => t.status)).toEqual(['ready', 'ready']);
    expect(JSON.parse(readFileSync(join(runDir(), 'tasks/TASK-0001/task.json'), 'utf8')).status).toBe('ready');
    expect(JSON.parse(readFileSync(join(runDir(), 'run.json'), 'utf8')).status).toBe('active');
    const tail = events().slice(3);
    expect(tail.map((e) => e.event)).toEqual(['task_published', 'task_published', 'run_activated']);
    expect(tail.map((e) => e.seq)).toEqual([4, 5, 6]);
    expect(tail[2].payload.published_count).toBe(2);
  });

  it('--tasks subset publishes only the named task; second publish does not re-activate', () => {
    const env1 = publishTasks({ cwd: repo, runId: 'RUN-0001', taskIds: ['TASK-0001'] });
    expect((env1.data as { published: number }).published).toBe(1);
    const list = JSON.parse(readFileSync(join(runDir(), 'team-task-list.json'), 'utf8'));
    expect(list.tasks.map((t: { status: string }) => t.status)).toEqual(['ready', 'draft']);
    publishTasks({ cwd: repo, runId: 'RUN-0001', taskIds: ['TASK-0002'] });
    expect(events().filter((e) => e.event === 'run_activated').length).toBe(1);
  });

  it('already-ready tasks are skipped with a warning (idempotent)', () => {
    publishTasks({ cwd: repo, runId: 'RUN-0001' });
    const env = publishTasks({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);
    expect((env.data as { published: number }).published).toBe(0);
    expect(env.warnings.some((w) => w.code === 'already_ready')).toBe(true);
  });

  it('unknown run id fails with run_not_found', () => {
    const env = publishTasks({ cwd: repo, runId: 'RUN-9999' });
    expect(env.code).toBe('run_not_found');
  });

  it('unknown task id fails with task_not_found and mutates nothing', () => {
    const env = publishTasks({ cwd: repo, runId: 'RUN-0001', taskIds: ['TASK-0099'] });
    expect(env.code).toBe('task_not_found');
    const list = JSON.parse(readFileSync(join(runDir(), 'team-task-list.json'), 'utf8'));
    expect(list.tasks.map((t: { status: string }) => t.status)).toEqual(['draft', 'draft']);
  });

  it('15 §2.4: publish is rejected while the run is paused (run_not_active)', () => {
    const runFile = join(runDir(), 'run.json');
    const cur = readJsonState(runFile);
    writeJsonStateAtomic(runFile, { ...cur.doc, status: 'paused' }, { expectedRev: cur.rev });
    const env = publishTasks({ cwd: repo, runId: 'RUN-0001' });
    expect(env.code).toBe('run_not_active');
  });
});

describe('D18 cross-run path overlap at publish (BDD-002-03/04; docs/16 §5)', () => {
  function importSecondRun(policy?: Record<string, unknown>) {
    const p = validPayload() as Record<string, any>;
    p.run.title = 'Second run touching auth';
    if (policy) p.run.policy = policy;
    p.tasks = [{
      client_task_key: 'auth-overlap',
      title: 'Touch auth again',
      type: 'implementation',
      objective: 'overlapping work',
      acceptance: ['ok'],
      paths: { allow: ['src/auth/session/**'] },
      required_checks: ['true'],
    }];
    return importRun({ cwd: repo, payload: p });
  }

  it('warn policy (default): publish succeeds with a warning and an overlap event', () => {
    publishTasks({ cwd: repo, runId: 'RUN-0001' });
    importSecondRun();
    const env = publishTasks({ cwd: repo, runId: 'RUN-0002' });
    expect(env.ok).toBe(true);
    expect(env.warnings.some((w) => w.code === 'cross_run_overlap')).toBe(true);
    const dir2 = join(repo, '.team', 'runs', 'RUN-0002');
    expect(events(dir2).some((e) => e.event === 'cross_run_overlap_detected')).toBe(true);
  });

  it('block policy: publish is refused with cross_run_conflict; --force overrides', () => {
    publishTasks({ cwd: repo, runId: 'RUN-0001' });
    importSecondRun({ cross_run_path_policy: 'block' });
    const refused = publishTasks({ cwd: repo, runId: 'RUN-0002' });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('cross_run_conflict');
    const dir2 = join(repo, '.team', 'runs', 'RUN-0002');
    const list = JSON.parse(readFileSync(join(dir2, 'team-task-list.json'), 'utf8'));
    expect(list.tasks[0].status).toBe('draft');
    const forced = publishTasks({ cwd: repo, runId: 'RUN-0002', force: true });
    expect(forced.ok).toBe(true);
    expect(forced.warnings.some((w) => w.code === 'cross_run_overlap')).toBe(true);
  });
});
