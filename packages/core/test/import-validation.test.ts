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

/**
 * Run mode labels (docs/34 §2/§7). The enum widened so the planner's routing decision survives
 * onto the run — collapsing refactor/perf into `feature`, or hotfix into `debug`, silently
 * disabled the mode-recipe audit rules that key off `run.mode`.
 */
describe('run mode enum (docs/34 §2 routing labels)', () => {
  it.each(['feature', 'bugfix', 'debug', 'review', 'integration', 'spike', 'docs', 'perf', 'refactor', 'hotfix', 'release'])(
    'accepts routed mode %s',
    (mode) => {
      const p = validPayload() as Record<string, any>;
      p.run.mode = mode;
      // give every implementation slice a check so this test measures the enum alone, not the
      // bugfix must-reject exercised below
      for (const t of p.tasks) t.required_checks ??= ['npm test'];
      const env = importRun({ cwd: repo, payload: p });
      expect(env.ok, `mode ${mode} should import`).toBe(true);
      expect((env.data as { mode?: string }).mode ?? mode).toBe(mode);
    },
  );

  it('still rejects a mode outside the enum — a typo must not become a silent label', () => {
    const p = validPayload() as Record<string, any>;
    p.run.mode = 'refactoring';
    const env = importRun({ cwd: repo, payload: p });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('schema_invalid');
    expect(JSON.stringify(env.data)).toContain('mode');
  });
});

/**
 * Mode-aware must-reject (docs/34 §7): a bugfix implementation with no required_checks cannot
 * show the bug is gone — the recipe's red->green evidence has nowhere to land. Everywhere else
 * this stays the long-standing `task_without_checks` warning.
 */
describe('bugfix runs demand a check on implementation slices', () => {
  it('rejects a bugfix implementation task with no required_checks', () => {
    const p = validPayload() as Record<string, any>;
    p.run.mode = 'bugfix';
    delete p.tasks[0].required_checks;
    const env = importRun({ cwd: repo, payload: p });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('schema_invalid');
    expect(JSON.stringify(env.data)).toContain('required_checks');
  });

  it('exempts the investigation slice — a repro/impact task carries no check by design', () => {
    const p = validPayload() as Record<string, any>;
    p.run.mode = 'bugfix';
    p.tasks[1].type = 'investigation';
    delete p.tasks[1].required_checks;
    const env = importRun({ cwd: repo, payload: p });
    expect(env.ok).toBe(true);
  });

  it('other modes keep the warning, not a rejection', () => {
    const p = validPayload() as Record<string, any>;
    p.run.mode = 'feature';
    delete p.tasks[0].required_checks;
    const env = importRun({ cwd: repo, payload: p });
    expect(env.ok).toBe(true);
    expect(JSON.stringify(env.warnings ?? [])).toContain('task_without_checks');
  });
});
