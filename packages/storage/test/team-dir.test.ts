import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveTeamRoot, GatewayError } from '@sigmarun/storage';
import { mkTmpGitRepo, mkTmpBareRepo, mkTmpDir, cleanup } from './helpers.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()!); });

describe('resolveTeamRoot (contract: docs/16 §2 resolution order)', () => {
  it('resolves .team under repo root from the root itself', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    const r = resolveTeamRoot({ cwd: repo });
    expect(r.repoRoot).toBe(repo);
    expect(r.teamRoot).toBe(join(repo, '.team'));
  });

  it('resolves the same teamRoot from a nested subdirectory', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    const sub = join(repo, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    expect(resolveTeamRoot({ cwd: sub }).teamRoot).toBe(join(repo, '.team'));
  });

  it('honors explicit teamRootFlag above git resolution', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    const other = mkTmpDir(); dirs.push(other);
    expect(resolveTeamRoot({ cwd: repo, teamRootFlag: other }).teamRoot).toBe(other);
  });

  it('throws not_a_git_repo outside any repository', () => {
    const plain = mkTmpDir(); dirs.push(plain);
    try {
      resolveTeamRoot({ cwd: plain });
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).code).toBe('not_a_git_repo');
    }
  });

  it('throws bare_repo_unsupported inside a bare repo', () => {
    const bare = mkTmpBareRepo(); dirs.push(bare);
    try {
      resolveTeamRoot({ cwd: bare });
      expect.unreachable('should throw');
    } catch (e) {
      expect((e as GatewayError).code).toBe('bare_repo_unsupported');
    }
  });
});
