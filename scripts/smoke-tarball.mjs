#!/usr/bin/env node
/**
 * Tarball smoke test — the guard the unit suite structurally cannot be.
 *
 * `npm test` compiles source with vitest; it can pass green while the PUBLISHED artifact is
 * broken (a stale `tsc -b` bundle, a mis-declared `files` list, a bad bin shebang, a wrong
 * adapter install path). This packs the real tarball, installs it into a throwaway prefix, and
 * drives the INSTALLED `sigmarun` binary through a minimal but real journey. Any failure exits
 * non-zero so CI blocks the release.
 *
 * Run: `npm run smoke`. Node-only (no shell assumptions) so it works on the CI matrix.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmps = [];
const mktmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); tmps.push(d); return d; };
const cleanup = () => { for (const d of tmps) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } };

let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
};
const run = (bin, args, opts = {}) => {
  try { return { ok: true, out: execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) }; }
  catch (e) { return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status }; }
};

try {
  console.log('== build + pack the real tarball (self-cleaning release) ==');
  execFileSync('npm', ['run', 'release'], { cwd: root, stdio: 'inherit' });
  const rel = join(root, 'release');
  const packOut = execFileSync('npm', ['pack'], { cwd: rel, encoding: 'utf8' }).trim().split('\n').pop().trim();
  const tgz = join(rel, packOut);
  check('npm pack produced a tarball', existsSync(tgz), tgz);

  console.log('== install the tarball into a throwaway prefix ==');
  const prefix = mktmp('sigmarun-smoke-prefix-');
  writeFileSync(join(prefix, 'package.json'), JSON.stringify({ name: 'smoke-host', private: true }) + '\n');
  execFileSync('npm', ['install', tgz], { cwd: prefix, stdio: 'inherit' });
  const bin = join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'sigmarun.cmd' : 'sigmarun');
  check('installed bin exists', existsSync(bin), bin);

  console.log('== drive the installed CLI in a fresh git repo ==');
  const repo = mktmp('sigmarun-smoke-repo-');
  const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git(['init']); git(['config', 'user.email', 'smoke@sigmarun.local']); git(['config', 'user.name', 'smoke']);
  git(['commit', '--allow-empty', '-m', 'init']);
  const sr = (args, opts = {}) => run(bin, args, { cwd: repo, ...opts });

  // A) version surfaces gateway + template generation
  const ver = sr(['--version']);
  check('--version prints a bare semver first line', /^\d+\.\d+\.\d+/.test(ver.out.split('\n')[0] ?? ''), ver.out.trim());
  check('--version shows adapter template generation', /adapter templates:/.test(ver.out), ver.out.trim());

  // B) init + adapter install lands the right files on the right paths
  check('init exits ok', sr(['init', '--json']).ok);
  sr(['adapter', 'install', '--tool=all', '--json']);
  const skills = existsSync(join(repo, '.agents', 'skills')) ? readdirSync(join(repo, '.agents', 'skills')).length : 0;
  const cmds = existsSync(join(repo, '.claude', 'commands')) ? readdirSync(join(repo, '.claude', 'commands')).length : 0;
  check('Codex skills land under .agents/skills (P0-3)', skills > 0, `found ${skills}`);
  check('Claude commands land under .claude/commands', cmds > 0, `found ${cmds}`);
  check('.codex/ is NOT created (the old wrong path)', !existsSync(join(repo, '.codex')));

  // C) lightweight journey end to end: import -> register -> claim -> done
  const payload = {
    schema_version: 'team.plan_payload.v1',
    source: { tool: 'claude-code', command: '/team-plan', prompt: 'smoke', agent_id: 'AGENT-claude-001' },
    run: { title: 'smoke', mode: 'feature', goal: 'smoke the tarball' },
    plan: { summary: 'one task' },
    tasks: [{ client_task_key: 'k', title: 'T', type: 'implementation', objective: 'o', acceptance: ['done'], paths: { allow: ['x.js'] } }],
  };
  const pf = join(repo, 'plan.json'); writeFileSync(pf, JSON.stringify(payload));
  check('run import --lightweight ok', sr(['run', 'import', pf, '--lightweight', '--json']).ok);
  const reg = sr(['agent', 'register', 'RUN-0001', '--tool=claude-code', '--json']);
  let agentId = '';
  try { agentId = JSON.parse(reg.out).data.agent_id; } catch { /* leave blank */ }
  check('agent register returns an AGENT-ID', /^AGENT-/.test(agentId), agentId || reg.out.trim());
  check('claim-next ok', sr(['claim-next', 'RUN-0001', `--agent=${agentId}`, '--json']).ok);
  check('done ok', sr(['done', 'RUN-0001', 'TASK-0001', `--agent=${agentId}`, '--json']).ok);

  // D) human-face validation prints the error list, not just "fix the listed items" (breakpoint #1)
  const badPf = join(repo, 'bad.json'); writeFileSync(badPf, JSON.stringify({ tasks: [{}] }));
  const bad = sr(['run', 'import', badPf]); // human mode, no --json
  check('run import bad plan fails', !bad.ok);
  check('human face lists the actual field errors (breakpoint #1)', /\n\s+- .+/.test(bad.out), bad.out.split('\n').slice(0, 3).join(' | '));

  console.log(failed === 0 ? '\nSMOKE PASSED' : `\nSMOKE FAILED (${failed} check(s))`);
} catch (e) {
  console.error('\nSMOKE ERRORED:', e?.message ?? e);
  failed++;
} finally {
  cleanup();
}
process.exit(failed === 0 ? 0 : 1);
