import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { approvePaths, claimNext } from '@sigmarun/dispatch';
import { readJsonState, writeJsonStateAtomic } from '@sigmarun/storage';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault } from './fixture.js';

let repo: string;
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
const readJson = (rel: string) => JSON.parse(readFileSync(join(runDir(), rel), 'utf8'));
const events = () => readFileSync(join(runDir(), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('claim-next happy path (BDD-003-01; docs/10 §2.2)', () => {
  it('claims the dependency-free task with claims, state flips, events, lease, worktree hint', () => {
    repo = mkClaimRepo([{ key: 'a' }, { key: 'b', deps: ['a'] }]);
    const agent = registerDefault(repo);
    const before = Date.now();
    const env = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent });
    expect(env.ok).toBe(true);
    const data = env.data as Record<string, unknown>;
    expect(data.task_id).toBe('TASK-0001');
    expect(data.claim_id).toBe('CLAIM-task-0001');
    expect(data.path_claim_ids).toEqual(['CLAIM-path-0002']);
    expect(data.agent_id).toBe(agent);
    const lease = Date.parse(data.lease_until as string);
    expect(lease).toBeGreaterThan(before + 25 * 60_000);
    expect(lease).toBeLessThan(before + 35 * 60_000);
    const wt = data.worktree as { suggested_branch: string; suggested_path: string };
    expect(wt.suggested_branch).toMatch(/^team\/RUN-0001\/TASK-0001-/);
    expect(wt.suggested_path).toContain('TASK-0001');

    expect(readJson('tasks/TASK-0001/task.json').status).toBe('claimed');
    const row = readJson('team-task-list.json').tasks[0];
    expect(row.status).toBe('claimed');
    expect(row.owner_agent_id).toBe(agent);
    expect(row.claim_id).toBe('CLAIM-task-0001');
    expect(readJson('claims/task-claims.json').claims[0].status).toBe('active');
    expect(readJson('claims/path-claims.json').claims[0].paths.allow).toEqual(['src/a/**']);
    expect(readJson('agents/' + agent + '.json').current_task_id).toBe('TASK-0001');

    const tail = events().slice(-2);
    expect(tail.map((e) => e.event)).toEqual(['task_claimed', 'path_claimed']);
    expect(tail[0].claim_id).toBe('CLAIM-task-0001');
    expect(tail[0].payload.lease_until).toBe(data.lease_until);
    expect(tail[0].actor).toEqual({ type: 'agent', id: agent });
  });

  it('a cap tripped by a crash ghost points at repair; a genuinely occupied task does not (P1-9 discoverability)', () => {
    repo = mkClaimRepo([{ key: 'a' }, { key: 'b' }]);
    const agent = registerDefault(repo);
    // Real claim first — this materializes claims/task-claims.json with an ACTIVE claim on TASK-0001.
    expect(claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent }).data).toMatchObject({ task_id: 'TASK-0001' });

    // GHOST: simulate a crash where the claim record persisted but the task/list rolled back to ready
    // (the task_claimed commit never landed). The active claim now sits on a task that is NOT in flight.
    const toReady = () => {
      const list = readJsonState(join(runDir(), 'team-task-list.json'));
      const row = (list.doc as { tasks: Array<Record<string, unknown> & { task_id: string }> }).tasks.find((r) => r.task_id === 'TASK-0001')!;
      row.status = 'ready'; row.owner_agent_id = null; row.claim_id = null;
      writeJsonStateAtomic(join(runDir(), 'team-task-list.json'), list.doc as Record<string, unknown>, { expectedRev: list.rev });
      const t1 = readJsonState(join(runDir(), 'tasks', 'TASK-0001', 'task.json'));
      (t1.doc as { status: string }).status = 'ready';
      writeJsonStateAtomic(join(runDir(), 'tasks', 'TASK-0001', 'task.json'), t1.doc as Record<string, unknown>, { expectedRev: t1.rev });
    };
    toReady();

    // The agent already holds 1 active claim (the ghost) -> agent_claim_limit. Because the ghost sits on a
    // ready task, the guidance must name repair.
    const ghost = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent });
    expect(ghost.code).toBe('agent_claim_limit');
    expect(ghost.next_actions.join(' ')).toMatch(/repair/);

    // CONTROL: put TASK-0001 back to genuinely claimed (occupied). Same cap trips, but no ghost -> no repair hint.
    const list = readJsonState(join(runDir(), 'team-task-list.json'));
    const row = (list.doc as { tasks: Array<Record<string, unknown> & { task_id: string }> }).tasks.find((r) => r.task_id === 'TASK-0001')!;
    row.status = 'claimed'; row.owner_agent_id = agent; row.claim_id = 'CLAIM-task-0001';
    writeJsonStateAtomic(join(runDir(), 'team-task-list.json'), list.doc as Record<string, unknown>, { expectedRev: list.rev });
    const t1 = readJsonState(join(runDir(), 'tasks', 'TASK-0001', 'task.json'));
    (t1.doc as { status: string }).status = 'claimed';
    writeJsonStateAtomic(join(runDir(), 'tasks', 'TASK-0001', 'task.json'), t1.doc as Record<string, unknown>, { expectedRev: t1.rev });

    const real = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent });
    expect(real.code).toBe('agent_claim_limit');
    expect(real.next_actions.join(' ')).not.toMatch(/repair/);
  });

  it('worktree suggestion derives from run.worktree_root and passes register (remediation A1; smoke L17 regression)', async () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const agent = registerDefault(repo);
    const env = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent });
    expect(env.ok).toBe(true);
    const wt = (env.data as { worktree: { suggested_branch: string; suggested_path: string } }).worktree;
    const wtRoot = readJson('run.json').worktree_root as string;
    expect(wt.suggested_path).toBe(`${wtRoot}/TASK-0001`);

    // the gateway's own suggestion must pass the gateway's own register containment check
    const { execFileSync } = await import('node:child_process');
    const { mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const { registerWorktree } = await import('@sigmarun/dispatch');
    execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-m', 'base', '--no-gpg-sign'], { stdio: 'ignore' });
    const abs = join(repo, wt.suggested_path);
    mkdirSync(dirname(abs), { recursive: true });
    execFileSync('git', ['-C', repo, 'worktree', 'add', abs, '-b', wt.suggested_branch, 'HEAD'], { stdio: 'ignore' });
    const reg = registerWorktree({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, path: abs, branch: wt.suggested_branch });
    expect(reg.ok).toBe(true);
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('working');
  });

  it('picks the higher-priority task first (docs/10 §7 ordering)', () => {
    repo = mkClaimRepo([{ key: 'low', priority: 40 }, { key: 'high', priority: 90 }]);
    const agent = registerDefault(repo);
    const env = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent });
    expect((env.data as { task_id: string }).task_id).toBe('TASK-0002');
  });

  it('--dry-run explains the pick without writing anything', () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const agent = registerDefault(repo);
    const env = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent, dryRun: true });
    expect(env.ok).toBe(true);
    expect((env.data as { would_claim: string }).would_claim).toBe('TASK-0001');
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('ready');
    expect(existsSync(join(runDir(), 'claims', 'task-claims.json'))).toBe(false);
  });
});

describe('claim-next guards (BR-001)', () => {
  it('rejects on a planned (unpublished) run with run_not_active (BDD-002-02, row 1)', () => {
    repo = mkClaimRepo([{ key: 'a' }], { publish: false });
    const agent = registerDefault(repo);
    const env = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('run_not_active');
  });

  it('dependency-blocked queue yields no_claimable_task with excluded reasons (BDD-003-02, row 5)', () => {
    repo = mkClaimRepo([{ key: 'a' }, { key: 'b', deps: ['a'] }]);
    const a1 = registerDefault(repo, 'win-1');
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: a1 });
    const a2 = registerDefault(repo, 'win-2', 'codex');
    const env = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: a2 });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('no_claimable_task');
    const excluded = (env.data as { excluded: Array<{ task_id: string; reason: string }> }).excluded;
    expect(excluded).toContainEqual({ task_id: 'TASK-0002', reason: 'deps_blocked' });
  });

  it('path overlap skips the candidate; directed claim reports path_conflict with blocked_by (BDD-003-03, row 7)', () => {
    repo = mkClaimRepo([
      { key: 'a', paths: { allow: ['src/auth/**'] } },
      { key: 'b', paths: { allow: ['src/auth/login/**'] } },
      { key: 'c', paths: { allow: ['src/billing/**'] } },
    ]);
    const a1 = registerDefault(repo, 'win-1');
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: a1 });
    const a2 = registerDefault(repo, 'win-2', 'codex');
    const env = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: a2 });
    expect(env.ok).toBe(true);
    expect((env.data as { task_id: string }).task_id).toBe('TASK-0003');

    const a3 = registerDefault(repo, 'win-3', 'codex');
    const directed = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: a3, taskId: 'TASK-0002' });
    expect(directed.ok).toBe(false);
    expect(directed.code).toBe('path_conflict');
    const blockedBy = (directed.data as { blocked_by: Array<{ task_id: string }> }).blocked_by;
    expect(blockedBy[0].task_id).toBe('TASK-0001');
  });

  it('an agent holding an active claim is capped (BDD-003-04, row 3)', () => {
    repo = mkClaimRepo([{ key: 'a' }, { key: 'b' }]);
    const agent = registerDefault(repo);
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent });
    const env = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('agent_claim_limit');
  });

  it('directed claim on a held task is task_already_claimed and mutates nothing (BDD-004-02, row 4)', () => {
    repo = mkClaimRepo([{ key: 'a' }, { key: 'b' }]);
    const a1 = registerDefault(repo, 'win-1');
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: a1 });
    const a2 = registerDefault(repo, 'win-2', 'codex');
    const env = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: a2, taskId: 'TASK-0001' });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('task_already_claimed');
    expect(readJson('claims/task-claims.json').claims.length).toBe(1);
  });

  it('an integrating run still offers verification-type tasks from the queue (docs/15 §2.1; enum-typo regression)', async () => {
    repo = mkClaimRepo([{ key: 'a' }, { key: 'v', type: 'verification', paths: { allow: ['verify/**'] } }]);
    const owner = registerDefault(repo, 'win-owner');
    const reviewer = registerDefault(repo, 'win-rev', 'codex');
    const verifier = registerDefault(repo, 'win-ver', 'codex');
    const { driveToVerified } = await import('./fixture.js');
    await driveToVerified(repo, 'TASK-0001', 'a', owner, reviewer, verifier);
    const { integrateStart } = await import('@sigmarun/core');
    const started = integrateStart({ cwd: repo, runId: 'RUN-0001' });
    expect(started.ok).toBe(true);
    expect(readJson('run.json').status).toBe('integrating');

    const claimer = registerDefault(repo, 'win-x', 'codex');
    const env = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: claimer });
    expect(env.ok).toBe(true);
    expect((env.data as { task_id: string }).task_id).toBe('TASK-0002');
  });

  it('D20 default gate: a verified upstream unblocks its downstream without any policy knob', () => {
    repo = mkClaimRepo([{ key: 'a' }, { key: 'b', deps: ['a'] }]);
    const agent = registerDefault(repo);
    // hoist TASK-0001 to verified by hand — the gate reads row status, not the journey
    const list = readJsonState(join(repo, '.team', 'runs', 'RUN-0001', 'team-task-list.json'));
    (list.doc as { tasks: Array<{ task_id: string; status: string }> }).tasks[0]!.status = 'verified';
    writeJsonStateAtomic(join(repo, '.team', 'runs', 'RUN-0001', 'team-task-list.json'), list.doc as Record<string, unknown>, { expectedRev: list.rev });
    const env = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent, taskId: 'TASK-0002' });
    expect(env.ok).toBe(true);
    expect((env.data as { task_id: string }).task_id).toBe('TASK-0002');
  });

  it('directed claim on a dependency-blocked task is deps_blocked (BDD-004-03, row 5)', () => {
    repo = mkClaimRepo([{ key: 'a' }, { key: 'b', deps: ['a'] }]);
    const agent = registerDefault(repo);
    const env = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent, taskId: 'TASK-0002' });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('deps_blocked');
  });

  it('role mismatch on a directed claim is capability_mismatch (row 6)', () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const agent = registerDefault(repo);
    const env = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent, taskId: 'TASK-0001', role: 'reviewer' });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('capability_mismatch');
  });

  it('requires_approval blocks the claim until approve-paths grants it (BDD-003-08, row 8; AUD-004 inline)', () => {
    repo = mkClaimRepo([{ key: 'a', paths: { allow: ['src/a/**'], requires_approval: ['src/users/**'] } }]);
    const agent = registerDefault(repo);
    const denied = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent, taskId: 'TASK-0001' });
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe('requires_approval');

    const grant = approvePaths({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', paths: ['src/users/**'], grantedBy: 'user' });
    expect(grant.ok).toBe(true);
    expect(events().some((e) => e.event === 'path_approval_granted' && e.payload.paths.includes('src/users/**'))).toBe(true);

    const env = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent, taskId: 'TASK-0001' });
    expect(env.ok).toBe(true);
    expect((env.data as { task_id: string }).task_id).toBe('TASK-0001');
  });
});
