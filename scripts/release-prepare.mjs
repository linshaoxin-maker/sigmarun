#!/usr/bin/env node
/**
 * Prepare a release deterministically (roadmap Phase 2 — release automation).
 *
 *   node scripts/release-prepare.mjs <patch|minor|major|x.y.z> [--dry-run] [--date=YYYY-MM-DD]
 *
 * Bumps the version in ONE consistent set of places, then cuts the CHANGELOG. It does NOT commit,
 * tag, or publish — those stay explicit (publishing needs your npm login). It prints the exact
 * follow-up commands. `--dry-run` reports the plan without writing anything.
 *
 * Version lives in three synchronized spots and this keeps them in lockstep:
 *   - root package.json
 *   - every packages/<pkg>/package.json (workspace members)
 *   - GATEWAY_VERSION in packages/core/src/envelope.ts (the runtime version in --version / envelopes)
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dateArg = args.find((a) => a.startsWith('--date='))?.slice('--date='.length);
const bump = args.find((a) => !a.startsWith('--'));

if (!bump) {
  console.error('Usage: node scripts/release-prepare.mjs <patch|minor|major|x.y.z> [--dry-run] [--date=YYYY-MM-DD]');
  process.exit(2);
}

const rootPkgPath = join(root, 'package.json');
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
const current = rootPkg.version;

function nextVersion(cur, how) {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const [maj, min, pat] = cur.split('.').map(Number);
  if (how === 'major') return `${maj + 1}.0.0`;
  if (how === 'minor') return `${maj}.${min + 1}.0`;
  if (how === 'patch') return `${maj}.${min}.${pat + 1}`;
  console.error(`Unknown bump "${how}" — use patch|minor|major or an explicit x.y.z.`);
  process.exit(2);
}

const version = nextVersion(current, bump);
const date = dateArg ?? new Date().toISOString().slice(0, 10);

// ---- collect the edits ----
const edits = []; // { path, apply: () => newContent, note }

// root + workspace package.json version fields
const pkgFiles = [rootPkgPath];
const pkgsDir = join(root, 'packages');
for (const name of readdirSync(pkgsDir)) {
  const p = join(pkgsDir, name, 'package.json');
  if (existsSync(p)) pkgFiles.push(p);
}
for (const p of pkgFiles) {
  const pkg = JSON.parse(readFileSync(p, 'utf8'));
  if (pkg.version === version) continue;
  edits.push({
    path: p,
    note: `version ${pkg.version} -> ${version}`,
    apply: () => JSON.stringify({ ...pkg, version }, null, 2) + '\n',
  });
}

// GATEWAY_VERSION constant
const envPath = join(root, 'packages/core/src/envelope.ts');
const envSrc = readFileSync(envPath, 'utf8');
const gwRe = /export const GATEWAY_VERSION = '([^']+)';/;
const gwMatch = gwRe.exec(envSrc);
if (!gwMatch) {
  console.error('Could not find GATEWAY_VERSION in envelope.ts');
  process.exit(1);
}
if (gwMatch[1] !== version) {
  edits.push({
    path: envPath,
    note: `GATEWAY_VERSION ${gwMatch[1]} -> ${version}`,
    apply: () => envSrc.replace(gwRe, `export const GATEWAY_VERSION = '${version}';`),
  });
}

// CHANGELOG: cut Unreleased -> versioned section, leave a fresh Unreleased
const clPath = join(root, 'CHANGELOG.md');
const cl = readFileSync(clPath, 'utf8');
const marker = '## Unreleased\n';
if (!cl.includes(marker)) {
  console.error('CHANGELOG.md has no "## Unreleased" section to cut.');
  process.exit(1);
}
const cutChangelog = cl.replace(marker, `## Unreleased\n\n## ${version} — ${date}\n`);
edits.push({ path: clPath, note: `cut Unreleased -> ## ${version} — ${date}`, apply: () => cutChangelog });

// ---- report / apply ----
console.log(`Release ${current} -> ${version}  (${dryRun ? 'DRY RUN' : 'applying'})\n`);
for (const e of edits) console.log(`  ${e.path.slice(root.length + 1).padEnd(40)} ${e.note}`);
if (edits.length === 0) console.log('  (nothing to change — versions already at target)');

if (!dryRun) {
  for (const e of edits) writeFileSync(e.path, e.apply());
  console.log(`\nApplied. Next steps (explicit — not run for you):`);
  console.log(`  1. npm install            # refresh the lockfile for the new versions`);
  console.log(`  2. npm run build && npx vitest run   # confirm green`);
  console.log(`  3. git add -A && git commit -m "release: v${version}"`);
  console.log(`  4. git tag v${version}`);
  console.log(`  5. npm run release        # build the publishable release/ tarball`);
  console.log(`  6. (in release/) npm publish --access public --tag next --provenance   # needs npm login`);
  console.log(`  7. git push && git push --tag v${version}   # CI can also publish on the tag`);
} else {
  console.log(`\nDry run — no files written. Re-run without --dry-run to apply.`);
}
