import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { runCli } from '../src/cli.js';
import { serveDashboard } from '../src/dashboard.js';
import { mkTmpGitRepo, cleanup } from '../../storage/test/helpers.js';
import { validPayload } from '../../core/test/payload-fixture.js';

const dirs: string[] = [];
let srv: Server | undefined;
afterEach(async () => {
  if (srv) { await new Promise((r) => srv!.close(r)); srv = undefined; }
  while (dirs.length) cleanup(dirs.pop()!);
});

function seededRepo(): string {
  const repo = mkTmpGitRepo(); dirs.push(repo);
  runCli(['init', '--json'], { cwd: repo });
  const f = join(repo, 'payload.json');
  writeFileSync(f, JSON.stringify(validPayload()));
  runCli(['run', 'import', f, '--lightweight', '--json'], { cwd: repo });
  return repo;
}

describe('dashboard — read-only local page over the existing read model (docs/23)', () => {
  it('--once prints one aggregated state envelope: runs + tasks + graph nodes', () => {
    const repo = seededRepo();
    const r = runCli(['dashboard', '--once', '--json'], { cwd: repo });
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(true);
    const run = env.data.runs[0];
    expect(run.run.run_id).toBe('RUN-0001');
    expect(run.tasks.length).toBeGreaterThan(0);
    expect(run.graph.nodes.length).toBe(run.tasks.length);
    expect(run.status.user_state.state).toBeTruthy();
  });

  it('outside a git repo it fails fast with a clean envelope (no socket, no hang)', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'dash-nogit-')); dirs.push(dir);
    const r = runCli(['dashboard', '--once', '--json'], { cwd: dir });
    expect(r.exitCode).not.toBe(0);
    expect(JSON.parse(r.stdout).code).toBe('not_a_git_repo');
  });

  it('serve mode on a repo with zero runs refuses politely with guidance instead of an empty page', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    runCli(['init', '--json'], { cwd: repo });
    const r = runCli(['dashboard', '--json'], { cwd: repo }); // no --once: would serve if there were runs
    expect(r.keepAlive).toBeUndefined(); // no server started
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(true);
    expect(env.next_actions.join(' ')).toContain('/team-plan');
  });

  it('serves the page and /api/state over HTTP; page is self-contained (no CDN)', async () => {
    const repo = seededRepo();
    srv = serveDashboard({ cwd: repo, port: 0 });
    await new Promise((r) => srv!.once('listening', r));
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(page).toContain('sigmarun dashboard');
    expect(page).not.toMatch(/https?:\/\/cdn|unpkg|jsdelivr/); // self-contained
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    expect(state.ok).toBe(true);
    expect(state.data.runs[0].run.run_id).toBe('RUN-0001');
    const missing = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(missing.status).toBe(404);
  });

  it('bad --port is a usage error', () => {
    const repo = seededRepo();
    const r = runCli(['dashboard', '--port=nope', '--json'], { cwd: repo });
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout).code).toBe('usage_error');
  });
});
