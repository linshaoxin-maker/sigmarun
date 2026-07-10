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
}

export function payloadWith(tasks: TaskSpec[]): Record<string, unknown> {
  return {
    schema_version: 'team.plan_payload.v1',
    source: { tool: 'claude-code', command: '/team-plan', prompt: 'fixture', agent_id: 'AGENT-claude-001' },
    run: { title: 'Fixture run', mode: 'feature', goal: 'Exercise claim engine.' },
    plan: { summary: 'Fixture plan.' },
    tasks: tasks.map((t) => ({
      client_task_key: t.key,
      title: `Task ${t.key}`,
      type: 'implementation',
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
export function mkClaimRepo(tasks: TaskSpec[], opts: { publish?: boolean } = {}): string {
  const repo = mkTmpGitRepo();
  initProject({ cwd: repo });
  importRun({ cwd: repo, payload: payloadWith(tasks) });
  if (opts.publish !== false) publishTasks({ cwd: repo, runId: 'RUN-0001' });
  return repo;
}

export function registerDefault(repo: string, label = 'win-a', tool = 'claude-code'): string {
  const env = registerAgent({ cwd: repo, runId: 'RUN-0001', tool, role: 'implementer', label });
  return (env.data as { agent_id: string }).agent_id;
}

/** claim TASK-0001 and drive it to working via a real git worktree; returns the worktree path. */
export async function setupWorking(repo: string, agent: string, taskId = 'TASK-0001', slug = 'task-a'): Promise<string> {
  const { execFileSync } = await import('node:child_process');
  const { join } = await import('node:path');
  const { claimNext, registerWorktree } = await import('@sigmarun/dispatch');
  claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent, taskId });
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-m', 'base', '--no-gpg-sign'], { stdio: 'ignore' });
  const branch = `team/RUN-0001/${taskId}-${slug}`;
  const path = join(repo, '..', `wt-${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  execFileSync('git', ['-C', repo, 'worktree', 'add', path, '-b', branch, 'HEAD'], { stdio: 'ignore' });
  registerWorktree({ cwd: repo, runId: 'RUN-0001', taskId, agentId: agent, path, branch });
  return path;
}
