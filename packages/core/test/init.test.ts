import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initProject } from '@sigmarun/core';
import { mkTmpGitRepo, mkTmpDir, cleanup } from '../../storage/test/helpers.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()!); });

describe('sigmarun init (contract: docs/17 §8, docs/16 §1, docs/02 §6)', () => {
  it('creates the .team skeleton inside a git repo', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    const env = initProject({ cwd: repo });
    expect(env.ok).toBe(true);
    for (const p of ['.team/project.json', '.team/counters.json', '.team/templates', '.team/locks']) {
      expect(existsSync(join(repo, p)), p).toBe(true);
    }
  });

  it('D4: appends .team/ to .gitignore exactly once', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    initProject({ cwd: repo });
    initProject({ cwd: repo });
    const gi = readFileSync(join(repo, '.gitignore'), 'utf8');
    expect(gi.split('\n').filter((l) => l.trim() === '.team/').length).toBe(1);
  });

  it('is idempotent: second run succeeds with a warning and no overwrite', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    initProject({ cwd: repo });
    const before = readFileSync(join(repo, '.team/project.json'), 'utf8');
    const env2 = initProject({ cwd: repo });
    expect(env2.ok).toBe(true);
    expect(env2.warnings.length).toBeGreaterThan(0);
    expect(readFileSync(join(repo, '.team/project.json'), 'utf8')).toBe(before);
  });

  it('project.json matches docs/02 §6 fields (D12/D19/D2 defaults)', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    initProject({ cwd: repo });
    const p = JSON.parse(readFileSync(join(repo, '.team/project.json'), 'utf8'));
    expect(p.schema_version).toBe('team.project.v1');
    expect(p.rev).toBe(1);
    expect(typeof p.min_gateway_version).toBe('string');
    expect(p.project_memory_path).toBe('docs/team/MEMORY.md');
    expect(p.tooling).toEqual({ supports_claude_code: true, supports_codex: true, supports_cursor: false });
  });

  it('fails with not_a_git_repo outside a repository', () => {
    const plain = mkTmpDir(); dirs.push(plain);
    const env = initProject({ cwd: plain });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('not_a_git_repo');
    expect(env.next_actions.length).toBeGreaterThan(0);
  });
});
