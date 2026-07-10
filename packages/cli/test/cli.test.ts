import { describe, it, expect, afterEach } from 'vitest';
import { runCli } from '../src/cli.js';
import { mkTmpGitRepo, cleanup } from '../../storage/test/helpers.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()!); });

describe('cli front-end (contract: docs/17 §1/§2.2 — parse, delegate, map exit code)', () => {
  it('init --json prints one parseable envelope and exits 0', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    const r = runCli(['init', '--json'], { cwd: repo });
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(true);
    expect(env.meta.envelope_version).toBe('team.envelope.v1');
  });

  it('doctor --json parses and exits 0 on an initialized repo', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    runCli(['init', '--json'], { cwd: repo });
    const r = runCli(['doctor', '--json'], { cwd: repo });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);
  });

  it('unknown command maps to usage_error with exit 2', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    const r = runCli(['bogus', '--json'], { cwd: repo });
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout).code).toBe('usage_error');
  });

  it('environment failure maps to exit 8 (17 §2.2)', () => {
    const r = runCli(['doctor', '--json'], { cwd: '/tmp' });
    expect(r.exitCode).toBe(8);
    expect(JSON.parse(r.stdout).code).toBe('not_a_git_repo');
  });

  it('run import <file> --json imports and exits 0 (FEAT-002)', async () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    runCli(['init', '--json'], { cwd: repo });
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { validPayload } = await import('../../core/test/payload-fixture.js');
    const f = join(repo, 'payload.json');
    writeFileSync(f, JSON.stringify(validPayload()));
    const r = runCli(['run', 'import', f, '--json'], { cwd: repo });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).data.run_id).toBe('RUN-0001');
  });

  it('run import without a file argument is a usage error', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    const r = runCli(['run', 'import', '--json'], { cwd: repo });
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout).code).toBe('usage_error');
  });

  it('register -> claim-next -> release roundtrip via argv (FEAT-004)', async () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    runCli(['init', '--json'], { cwd: repo });
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { validPayload } = await import('../../core/test/payload-fixture.js');
    const f = join(repo, 'payload.json');
    writeFileSync(f, JSON.stringify(validPayload()));
    runCli(['run', 'import', f, '--json'], { cwd: repo });
    runCli(['task', 'publish', 'RUN-0001', '--json'], { cwd: repo });

    const reg = runCli(['agent', 'register', 'RUN-0001', '--tool=codex', '--label=win-1', '--json'], { cwd: repo });
    expect(reg.exitCode).toBe(0);
    const agentId = JSON.parse(reg.stdout).data.agent_id;

    const claim = runCli(['claim-next', 'RUN-0001', `--agent=${agentId}`, '--json'], { cwd: repo });
    expect(claim.exitCode).toBe(0);
    expect(JSON.parse(claim.stdout).data.task_id).toBe('TASK-0001');

    const again = runCli(['claim-next', 'RUN-0001', `--agent=${agentId}`, '--json'], { cwd: repo });
    expect(again.exitCode).toBe(1); // agent_claim_limit: fallback class per 17 §2.2
    expect(JSON.parse(again.stdout).code).toBe('agent_claim_limit');

    const rel = runCli(['release', 'RUN-0001', 'TASK-0001', `--agent=${agentId}`, '--json'], { cwd: repo });
    expect(rel.exitCode).toBe(0);
  });

  it('claim-next without --agent is a usage error', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    const r = runCli(['claim-next', 'RUN-0001', '--json'], { cwd: repo });
    expect(r.exitCode).toBe(2);
  });
});
