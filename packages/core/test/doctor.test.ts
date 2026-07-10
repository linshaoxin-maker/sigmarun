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
