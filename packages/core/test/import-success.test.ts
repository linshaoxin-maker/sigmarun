import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importRun, initProject } from '@sigmarun/core';
import { mkTmpGitRepo, cleanup } from '../../storage/test/helpers.js';
import { validPayload } from './payload-fixture.js';

let repo: string;
beforeEach(() => { repo = mkTmpGitRepo(); initProject({ cwd: repo }); });
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');

describe('run import happy path (BDD-001-01; contracts docs/09 §6–7, 17 §5.3, 13 §5.5)', () => {
  it('assigns RUN/TASK ids and returns the client_task_key mapping', () => {
    const env = importRun({ cwd: repo, payload: validPayload() });
    expect(env.ok).toBe(true);
    const data = env.data as { run_id: string; status: string; task_id_map: Array<{ client_task_key: string; task_id: string }> };
    expect(data.run_id).toBe('RUN-0001');
    expect(data.status).toBe('draft');
    expect(data.task_id_map).toEqual([
      { client_task_key: 'auth-domain', task_id: 'TASK-0001', title: 'Add auth domain model' },
      { client_task_key: 'auth-api-tests', task_id: 'TASK-0002', title: 'Add auth API tests' },
    ]);
  });

  it('persists the full artifact set with draft tasks', () => {
    importRun({ cwd: repo, payload: validPayload() });
    for (const p of [
      'run.json', 'team-task-list.json', 'task-graph.json', 'plan.md', 'counters.json',
      'context/run-memory.md', 'tasks/TASK-0001/task.json', 'tasks/TASK-0001/task.md', 'tasks/TASK-0002/task.json',
    ]) expect(existsSync(join(runDir(), p)), p).toBe(true);
    const list = JSON.parse(readFileSync(join(runDir(), 'team-task-list.json'), 'utf8'));
    expect(list.tasks.map((t: { status: string }) => t.status)).toEqual(['draft', 'draft']);
    const task = JSON.parse(readFileSync(join(runDir(), 'tasks/TASK-0002/task.json'), 'utf8'));
    expect(task.depends_on).toEqual(['TASK-0001']);
  });

  it('13 §5.5: task-graph nodes and edges carry no status field', () => {
    importRun({ cwd: repo, payload: validPayload() });
    const g = JSON.parse(readFileSync(join(runDir(), 'task-graph.json'), 'utf8'));
    expect(g.nodes.length).toBe(2);
    expect(g.edges.length).toBe(1);
    for (const n of g.nodes) expect('status' in n).toBe(false);
    for (const e of g.edges) expect('status' in e).toBe(false);
    expect(g.edges[0]).toMatchObject({ from: 'TASK-0001', to: 'TASK-0002', kind: 'blocks' });
  });

  it('17 §5.3 commit point: events are run_created + task_created x2 with seq 1..3', () => {
    importRun({ cwd: repo, payload: validPayload() });
    const lines = readFileSync(join(runDir(), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((e) => e.event)).toEqual(['run_created', 'task_created', 'task_created']);
    expect(lines.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(lines[0].actor).toEqual({ type: 'agent', id: 'AGENT-claude-001' });
    expect(lines[0].payload.rev_after).toBeDefined();
    expect(lines[0].schema_version).toBe('team.event.v1');
  });

  it('bumps the project run counter: a second distinct payload becomes RUN-0002', () => {
    importRun({ cwd: repo, payload: validPayload() });
    const p2 = validPayload();
    (p2.run as Record<string, unknown>).title = 'Another run';
    const env2 = importRun({ cwd: repo, payload: p2 });
    expect((env2.data as { run_id: string }).run_id).toBe('RUN-0002');
  });
});
