import { importRun, initProject, publishTasks } from '@sigmarun/core';
import { registerAgent } from '@sigmarun/dispatch';
import { mkTmpGitRepo } from '../../storage/test/helpers.js';

export interface TaskSpec {
  key: string;
  deps?: string[];
  paths?: Record<string, string[]>;
  priority?: number;
  role?: string;
  checks?: string[];
  type?: string;
}

export function payloadWith(tasks: TaskSpec[], policy?: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 'team.plan_payload.v1',
    source: { tool: 'claude-code', command: '/team-plan', prompt: 'fixture', agent_id: 'AGENT-claude-001' },
    run: { title: 'Fixture run', mode: 'feature', goal: 'Exercise claim engine.', ...(policy ? { policy } : {}) },
    plan: { summary: 'Fixture plan.' },
    tasks: tasks.map((t) => ({
      client_task_key: t.key,
      title: `Task ${t.key}`,
      type: t.type ?? 'implementation',
      objective: `Do ${t.key}.`,
      acceptance: [`${t.key} done.`],
      ...(t.deps ? { depends_on: t.deps } : {}),
      paths: t.paths ?? { allow: [`src/${t.key}/**`] },
      ...(t.priority !== undefined ? { priority: t.priority } : {}),
      ...(t.role ? { suggested_role: t.role } : {}),
      ...(t.checks ? { required_checks: t.checks } : {}),
    })),
  };
}

/** init + import + publish + register one agent; returns repo path. */
export function mkClaimRepo(tasks: TaskSpec[], opts: { publish?: boolean; policy?: Record<string, unknown> } = {}): string {
  const repo = mkTmpGitRepo();
  initProject({ cwd: repo });
  importRun({ cwd: repo, payload: payloadWith(tasks, opts.policy) });
  if (opts.publish !== false) publishTasks({ cwd: repo, runId: 'RUN-0001' });
  return repo;
}

export function registerDefault(repo: string, label = 'win-a', tool = 'claude-code'): string {
  const env = registerAgent({ cwd: repo, runId: 'RUN-0001', tool, role: 'implementer', label });
  return (env.data as { agent_id: string }).agent_id;
}

/** Drive a task all the way to verified: claim -> worktree -> submit -> review -> verify pass. */
export async function driveToVerified(
  repo: string,
  taskId: string,
  slugKey: string,
  owner: string,
  reviewer: string,
  verifier: string,
): Promise<void> {
  const { join } = await import('node:path');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { claimNext, reviewClaim, reviewDecide, verifySubmit } = await import('@sigmarun/dispatch');
  const { submitEvidence } = await import('@sigmarun/core');
  claimNext({ cwd: repo, runId: 'RUN-0001', agentId: owner, taskId });
  await setupWorkingClaimed(repo, owner, taskId, slugKey);
  const { validDraft } = await import('../../core/test/submit-fixture.js');
  submitEvidence({
    cwd: repo, runId: 'RUN-0001', taskId, agentId: owner,
    evidencePath: validDraft(repo, {
      changed_files: [{ path: `src/${slugKey}/index.ts`, change_type: 'added' }],
      acceptance: [{ item: `${slugKey} done.`, status: 'met' }],
    }),
  });
  reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId, agentId: reviewer });
  reviewDecide({ cwd: repo, runId: 'RUN-0001', taskId, agentId: reviewer, decision: 'approve', review: { findings: [] } });
  const outDir = join(repo, '..', `vout-${taskId}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, 'verify.log');
  writeFileSync(out, 'verify ok\n');
  const draft = join(outDir, 'verify.json');
  writeFileSync(draft, JSON.stringify({
    target: { kind: 'task', task_id: taskId },
    checks: [{ name: 'focused tests', cmd: 'npm test', exit_code: 0, output_file: out, status: 'pass' }],
    gates: { build: 'pass', focused_tests: 'pass', regression_tests: 'skipped', scope_check: 'pass', evidence_complete: 'pass' },
    skip_reasons: { regression_tests: 'covered by run-level verification' },
    verdict: 'pass',
    failures_mapped: [],
  }));
  verifySubmit({ cwd: repo, runId: 'RUN-0001', agentId: verifier, verifyPath: draft });
}

/** worktree for an ALREADY claimed task (driveToVerified claims directed first). */
async function setupWorkingClaimed(repo: string, agent: string, taskId: string, slug: string): Promise<string> {
  const { execFileSync } = await import('node:child_process');
  const { join } = await import('node:path');
  const { mkdirSync } = await import('node:fs');
  const { registerWorktree } = await import('@sigmarun/dispatch');
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-m', 'base', '--no-gpg-sign'], { stdio: 'ignore' });
  const branch = `team/RUN-0001/${taskId}-${slug}`;
  const { readFileSync } = await import('node:fs');
  const wtRel = (JSON.parse(readFileSync(join(repo, '.team', 'runs', 'RUN-0001', 'run.json'), 'utf8')) as { worktree_root: string }).worktree_root;
  const root = join(repo, wtRel);
  mkdirSync(root, { recursive: true });
  const path = join(root, `wt-${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  execFileSync('git', ['-C', repo, 'worktree', 'add', path, '-b', branch, 'HEAD'], { stdio: 'ignore' });
  registerWorktree({ cwd: repo, runId: 'RUN-0001', taskId, agentId: agent, path, branch });
  return path;
}

/** claim TASK-0001 and drive it to working via a real git worktree; returns the worktree path. */
export async function setupWorking(repo: string, agent: string, taskId = 'TASK-0001', slug = 'task-a'): Promise<string> {
  const { execFileSync } = await import('node:child_process');
  const { join } = await import('node:path');
  const { mkdirSync } = await import('node:fs');
  const { claimNext, registerWorktree } = await import('@sigmarun/dispatch');
  claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent, taskId });
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-m', 'base', '--no-gpg-sign'], { stdio: 'ignore' });
  const branch = `team/RUN-0001/${taskId}-${slug}`;
  const { readFileSync } = await import('node:fs');
  const wtRel = (JSON.parse(readFileSync(join(repo, '.team', 'runs', 'RUN-0001', 'run.json'), 'utf8')) as { worktree_root: string }).worktree_root;
  const root = join(repo, wtRel);
  mkdirSync(root, { recursive: true });
  const path = join(root, `wt-${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  execFileSync('git', ['-C', repo, 'worktree', 'add', path, '-b', branch, 'HEAD'], { stdio: 'ignore' });
  registerWorktree({ cwd: repo, runId: 'RUN-0001', taskId, agentId: agent, path, branch });
  return path;
}
