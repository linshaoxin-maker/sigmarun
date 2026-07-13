import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { doctorProject, initProject } from '@sigmarun/core';
import { mkTmpGitRepo, mkTmpDir, cleanup } from '../../storage/test/helpers.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()!); });

function checkByName(env: ReturnType<typeof doctorProject>, name: string) {
  const c = (env.data as { checks: Array<{ name: string; status: string; detail: string }> }).checks
    .find((x) => x.name === name);
  expect(c, `check ${name} present`).toBeDefined();
  return c!;
}

describe('sigmarun doctor (contract: docs/17 §8; BDD-001 background)', () => {
  it('all checks pass on a freshly initialized repo', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    initProject({ cwd: repo });
    const env = doctorProject({ cwd: repo });
    expect(env.ok).toBe(true);
    const checks = (env.data as { checks: Array<{ status: string }> }).checks;
    expect(checks.length).toBeGreaterThanOrEqual(7);
    expect(checks.every((c) => c.status === 'pass')).toBe(true);
  });

  it('fails with not_a_git_repo outside a repository (ERR-006 journey)', () => {
    const plain = mkTmpDir(); dirs.push(plain);
    const env = doctorProject({ cwd: plain });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('not_a_git_repo');
  });

  it('AUD-030: detects tracked .team files and points to git rm --cached', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    initProject({ cwd: repo });
    writeFileSync(join(repo, '.team/polluted.txt'), 'x');
    execSync('git add -f .team/polluted.txt', { cwd: repo });
    const env = doctorProject({ cwd: repo });
    const c = checkByName(env, 'tracked_team_dir');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('git rm');
  });

  it('21 §4.1: unknown project schema major is reported as unsupported', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    initProject({ cwd: repo });
    const f = join(repo, '.team/project.json');
    const doc = JSON.parse(readFileSync(f, 'utf8'));
    doc.schema_version = 'team.project.v9';
    writeFileSync(f, JSON.stringify(doc, null, 2));
    const env = doctorProject({ cwd: repo });
    const c = checkByName(env, 'project_schema');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('unsupported_schema_version');
  });
});

describe('doctor --fix — guided self-heal (roadmap Phase 1, fault degradation)', () => {
  it('adds the missing .gitignore entry and re-checks it green', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    initProject({ cwd: repo });
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n'); // drop the .team/ entry init added
    expect(checkByName(doctorProject({ cwd: repo }), 'gitignore_team_entry').status).toBe('fail');

    const env = doctorProject({ cwd: repo, fix: true });
    expect(checkByName(env, 'gitignore_team_entry').status).toBe('pass');
    const fixed = (env.data as { fixed: string[] }).fixed;
    expect(fixed.some((f) => f.includes('.gitignore'))).toBe(true);
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toContain('.team/');
  });

  it('initializes an uninitialized repo', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    expect(checkByName(doctorProject({ cwd: repo }), 'team_initialized').status).toBe('fail');
    const env = doctorProject({ cwd: repo, fix: true });
    expect(checkByName(env, 'team_initialized').status).toBe('pass');
    expect((env.data as { fixed: string[] }).fixed.some((f) => /init/i.test(f))).toBe(true);
  });

  it('untracks .team files that were accidentally committed (files kept on disk)', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    initProject({ cwd: repo });
    execSync('git add -f .team', { cwd: repo }); // force-track despite .gitignore
    expect(checkByName(doctorProject({ cwd: repo }), 'tracked_team_dir').status).toBe('fail');

    const env = doctorProject({ cwd: repo, fix: true });
    expect(checkByName(env, 'tracked_team_dir').status).toBe('pass');
    expect(execSync('git ls-files .team', { cwd: repo, encoding: 'utf8' }).trim()).toBe('');
    // the files themselves survive
    expect(readFileSync(join(repo, '.team', 'project.json'), 'utf8')).toContain('team.project.v1');
  });

  it('plain doctor never mutates; --fix leaves genuinely unfixable checks failed and unclaimed', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    initProject({ cwd: repo });
    writeFileSync(join(repo, '.team', 'counters.json'), '{"schema_version":"team.counters.v1","broken":true}'); // corrupt shape, not auto-fixable
    // plain doctor does not touch the file
    const before = readFileSync(join(repo, '.gitignore'), 'utf8');
    doctorProject({ cwd: repo });
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(before);

    const env = doctorProject({ cwd: repo, fix: true });
    expect(checkByName(env, 'counters_schema').status).toBe('fail'); // still failed
    expect((env.data as { fixed: string[] }).fixed.some((f) => /counters/i.test(f))).toBe(false); // not falsely claimed
  });
});
