#!/usr/bin/env node
/**
 * Assemble the publishable single-package `sigmarun` (docs/22 §4.1: MVP 单包发布，
 * bundle 全部 workspace 包 + 单 bin；@sigmarun/* 九包是内部结构，不随发布拆包).
 *
 * Run `npm run build` first — the bundle consumes each package's dist/ via
 * workspace resolution, so the tarball always matches what the suite verified.
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'release');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'dist'), { recursive: true });

// Workspace code is bundled; real npm deps stay external and install normally.
const EXTERNAL = ['zod', 'minimatch'];

await build({
  entryPoints: [join(root, 'packages/cli/dist/bin.js')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: EXTERNAL,
  outfile: join(out, 'dist/bin.js'), // entry keeps its own shebang; no banner (double shebang breaks ESM parse)
  legalComments: 'none',
});

const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const { readdirSync } = await import('node:fs');
const workspaceDeps = {};
for (const name of readdirSync(join(root, 'packages'))) {
  const manifest = join(root, 'packages', name, 'package.json');
  try {
    Object.assign(workspaceDeps, JSON.parse(readFileSync(manifest, 'utf8')).dependencies ?? {});
  } catch { /* not a package dir */ }
}
const dependencies = Object.fromEntries(EXTERNAL.map((d) => {
  if (!workspaceDeps[d]) throw new Error(`cannot resolve range for external dep ${d}`);
  return [d, workspaceDeps[d]];
}));

writeFileSync(join(out, 'package.json'), JSON.stringify({
  name: 'sigmarun',
  version: rootPkg.version,
  description: 'Repo-local multi-agent collaboration protocol + gateway CLI for AI coding agents (Claude Code, Codex): runs, task claims, evidence gates, review/verify, audit.',
  type: 'module',
  bin: { sigmarun: 'dist/bin.js' },
  files: ['dist', 'README.md', 'CHANGELOG.md'],
  engines: { node: '>=20' },
  keywords: ['ai-agents', 'multi-agent', 'claude-code', 'codex', 'orchestration', 'cli', 'collaboration'],
  dependencies,
}, null, 2) + '\n');

cpSync(join(root, 'CHANGELOG.md'), join(out, 'CHANGELOG.md'));
cpSync(join(root, 'scripts/release-readme.md'), join(out, 'README.md'));

console.log('release/ assembled: sigmarun@' + rootPkg.version);
