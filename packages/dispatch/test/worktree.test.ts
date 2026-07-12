import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonState, writeJsonStateAtomic } from '@sigmarun/storage';
import { claimNext, reclaimTask, registerWorktree, adoptWorktree } from '@sigmarun/dispatch';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault } from './fixture.js';

let repo: string;
let agent: string;
beforeEach(() => {
  repo = mkClaimRepo([{ key: 'a' }]);
  agent = registerDefault(repo);
  claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent });
});
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
const readJson = (rel: string) => JSON.parse(readFileSync(join(runDir(), rel), 'utf8'));
const events = () => readFileSync(join(runDir(), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const BRANCH = 'team/RUN-0001/TASK-0001-task-a';
function mkWorktree(name = 'wt1', branch = BRANCH, underRoot = true): string {
  // the tmp fixture repo starts with an unborn HEAD; git worktree add needs a commit
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-m', 'base', '--no-gpg-sign'], { stdio: 'ignore' });
  const wtRel = (JSON.parse(readFileSync(join(repo, '.team', 'runs', 'RUN-0001', 'run.json'), 'utf8')) as { worktree_root: string }).worktree_root;
  const base = underRoot ? join(repo, wtRel) : join(repo, '..');
  mkdirSync(base, { recursive: true });
  const path = join(base, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  execFileSync('git', ['-C', repo, 'worktree', 'add', path, '-b', branch, 'HEAD'], { stdio: 'ignore' });
  return path;
}

function expireLease(minutes: number): void {
  const file = join(runDir(), 'claims', 'task-claims.json');
  const { doc, rev } = readJsonState(file);
  (doc as { claims: Array<{ lease_until: string }> }).claims[0].lease_until = new Date(Date.now() - minutes * 60_000).toISOString();
  writeJsonStateAtomic(file, doc, { expectedRev: rev });
}

describe('worktree register (docs/16 §3.1–3.3; claimed→working; events #42/#13)', () => {
  it('registers the worktree, flips the task to working, records base_commit', () => {
    const path = mkWorktree();
    const env = registerWorktree({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, path, branch: BRANCH });
    expect(env.ok).toBe(true);
    const entry = readJson('worktrees.json').entries[0];
    expect(entry.worktree_id).toBe('WT-TASK-0001');
    expect(entry.branch).toBe(BRANCH);
    expect(entry.status).toBe('active');
    expect(entry.owner_agent_id).toBe(agent);
    expect(entry.base_commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('working');
    expect(readJson('team-task-list.json').tasks[0].status).toBe('working');
    const tail = events().slice(-2);
    expect(tail.map((e) => e.event)).toEqual(['worktree_created', 'task_started']);
    expect(tail[0].payload.worktree_id).toBe('WT-TASK-0001');
    expect(tail[0].payload.branch).toBe(BRANCH);
  });

  it('rejects a non-owner (not_claim_owner) and a bad branch name (schema_invalid)', () => {
    const path = mkWorktree();
    const other = registerDefault(repo, 'win-2', 'codex');
    const notOwner = registerWorktree({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: other, path, branch: BRANCH });
    expect(notOwner.code).toBe('not_claim_owner');
    const badBranch = registerWorktree({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, path, branch: 'feature/oops' });
    expect(badBranch.code).toBe('schema_invalid');
    const noPath = registerWorktree({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, path: join(repo, '..', 'nope-x'), branch: BRANCH });
    expect(noPath.code).toBe('io_error');
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('claimed');
  });

  it('rejects a worktree path outside run.worktree_root', () => {
    const path = mkWorktree('outside', BRANCH, false);
    const env = registerWorktree({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, path, branch: BRANCH });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('path_escape_detected');
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('claimed');
  });

  it('rejects when the task is not in claimed state (invalid_transition)', () => {
    const path = mkWorktree();
    registerWorktree({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, path, branch: BRANCH });
    const again = registerWorktree({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, path, branch: BRANCH });
    expect(again.code).toBe('invalid_transition');
  });
});

describe('reclaim marks the worktree abandoned; adopt transfers ownership (docs/16 §3.5; event #43)', () => {
  it('reclaim: entry -> abandoned, owner moved to history, previous_attempts carries the worktree', () => {
    const path = mkWorktree();
    registerWorktree({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, path, branch: BRANCH });
    expireLease(10);
    const env = reclaimTask({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001' });
    expect(env.ok).toBe(true);
    const entry = readJson('worktrees.json').entries[0];
    expect(entry.status).toBe('abandoned');
    expect(entry.owner_agent_id).toBeNull();
    expect(entry.previous_owner_agent_ids).toContain(agent);
    const attempt = readJson('tasks/TASK-0001/task.json').previous_attempts[0];
    expect(attempt.worktree_path).toBe(path);
    expect(attempt.branch).toBe(BRANCH);
  });

  it('adopt: new owner takes the abandoned worktree and the task goes working', () => {
    const path = mkWorktree();
    registerWorktree({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, path, branch: BRANCH });
    expireLease(10);
    reclaimTask({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001' });
    const successor = registerDefault(repo, 'win-2', 'codex');
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: successor });
    const env = adoptWorktree({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: successor });
    expect(env.ok).toBe(true);
    const entry = readJson('worktrees.json').entries[0];
    expect(entry.status).toBe('active');
    expect(entry.owner_agent_id).toBe(successor);
    expect(entry.previous_owner_agent_ids).toContain(agent);
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('working');
    const adopted = events().find((e) => e.event === 'worktree_adopted');
    expect(adopted.payload.previous_owner).toBe(agent);
  });

  it('adopt with nothing abandoned is invalid_transition', () => {
    const env = adoptWorktree({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('invalid_transition');
  });
});
