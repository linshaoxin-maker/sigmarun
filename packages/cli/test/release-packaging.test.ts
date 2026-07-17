import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Release-line reconciliation (P0-2): the README that ships to npm must be the ONE honest root
 * README — not a second, separately-maintained copy that silently drifts from the walked-back
 * product story. Same "drift is a red test" contract as docs-reconciliation: if build-release.mjs
 * is repointed at a stale file, if a second frozen README reappears, or if walk-back language
 * creeps back into the packaged README, this test goes red instead of the drift shipping to users.
 */
const ROOT = join(__dirname, '..', '..', '..');
const buildRelease = readFileSync(join(ROOT, 'scripts', 'build-release.mjs'), 'utf8');

/** The repo-relative path build-release.mjs copies into the tarball as README.md. */
function packagedReadmeRel(): string {
  const m = /cpSync\(\s*join\(root,\s*'([^']+)'\)\s*,\s*join\(out,\s*'README\.md'\)\)/.exec(buildRelease);
  if (!m) throw new Error('could not find the README cpSync target in build-release.mjs');
  return m[1]!;
}

describe('release packaging — the npm README is the single honest source (P0-2)', () => {
  it('build-release.mjs packages the repo-root README.md, not a second frozen file', () => {
    expect(packagedReadmeRel()).toBe('README.md');
  });

  it('no separately-maintained second README lingers to drift from the root', () => {
    // scripts/release-readme.md was the frozen fork that never tracked the walk-back — once the
    // root README is the packaged source, that second source must be gone, or the foot-gun returns.
    expect(existsSync(join(ROOT, 'scripts', 'release-readme.md'))).toBe(false);
  });

  it('the packaged README carries the current, honest product story', () => {
    const readme = readFileSync(join(ROOT, packagedReadmeRel()), 'utf8');
    // present — the walked-back framing and the human-loop the release must not hide
    expect(readme).toContain('record-keeping');     // "structured record-keeping, not a quality authority"
    expect(readme).toContain('Staying in control');  // the human-in-the-loop section
    expect(readme).toContain('10-point');            // doctor really runs 10 checks on an init'd repo
    // absent — the frozen walk-back language and the 9-vs-10 self-contradiction
    expect(readme).not.toMatch(/firewall/i);
    expect(readme).not.toMatch(/self-reported/i);
    expect(readme).not.toContain('9-point');
  });
});
