import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { importRun, initProject } from '@sigmarun/core';
import { mkTmpGitRepo, cleanup } from '../../storage/test/helpers.js';
import { validPayload } from './payload-fixture.js';

let repo: string;
beforeEach(() => { repo = mkTmpGitRepo(); initProject({ cwd: repo }); });
afterEach(() => cleanup(repo));

type Mut = (p: Record<string, any>) => void;

describe('run import must-reject table (BDD-001-02/03; docs/09 §8.1/§9)', () => {
  const cases: Array<[string, Mut, string]> = [
    ['unsupported payload schema', (p) => { p.schema_version = 'team.plan_payload.v9'; }, 'schema_version'],
    ['empty tasks', (p) => { p.tasks = []; }, 'tasks'],
    ['duplicate client_task_key', (p) => { p.tasks[1].client_task_key = 'auth-domain'; }, 'auth-domain'],
    ['depends_on unknown key', (p) => { p.tasks[1].depends_on = ['nope']; }, 'nope'],
    ['task missing acceptance', (p) => { delete p.tasks[0].acceptance; }, 'acceptance'],
    ['priority out of range', (p) => { p.tasks[0].priority = 200; }, 'priority'],
    ['non-positive weight', (p) => { p.tasks[0].weight = 0; }, 'weight'],
    ['absolute path outside repo', (p) => { p.tasks[0].paths = { allow: ['/etc/passwd'] }; }, 'path'],
    ['forged runtime field owner_agent_id', (p) => { p.tasks[0].owner_agent_id = 'AGENT-x'; }, 'owner_agent_id'],
    ['forged execution status', (p) => { p.tasks[0].status = 'done'; }, 'status'],
  ];

  it.each(cases)('%s is rejected with a pointed error', (_name, mutate, needle) => {
    const p = validPayload() as Record<string, any>;
    mutate(p);
    const env = importRun({ cwd: repo, payload: p });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('schema_invalid');
    expect(JSON.stringify(env.data)).toContain(needle);
  });

  it('rejection leaves zero residue on disk (no run directory, counter unchanged)', () => {
    const p = validPayload() as Record<string, any>;
    p.tasks = [];
    importRun({ cwd: repo, payload: p });
    expect(existsSync(join(repo, '.team', 'runs', 'RUN-0001'))).toBe(false);
    const env = importRun({ cwd: repo, payload: validPayload() });
    expect((env.data as { run_id: string }).run_id).toBe('RUN-0001');
  });
});
