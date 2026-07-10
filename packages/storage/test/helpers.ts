import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function mkTmpDir(prefix = 'sigmarun-test-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function mkTmpGitRepo(): string {
  const dir = mkTmpDir();
  execSync('git init -q -b main', { cwd: dir });
  execSync('git config user.email t@t.local && git config user.name t', { cwd: dir });
  return dir;
}

export function mkTmpBareRepo(): string {
  const dir = mkTmpDir();
  execSync('git init -q --bare', { cwd: dir });
  return dir;
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
