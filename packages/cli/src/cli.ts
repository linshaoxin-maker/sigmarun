import { readFileSync } from 'node:fs';
import { initProject, doctorProject, importRun, publishTasks, failEnvelope, type Envelope, type DoctorCheck } from '@sigmarun/core';

const EXIT_BY_CODE: Record<string, number> = {
  OK: 0,
  usage_error: 2,
  lock_timeout: 3,
  schema_invalid: 4,
  rev_conflict: 6,
  duplicate_payload: 6,
  cross_run_conflict: 6,
  run_not_found: 5,
  task_not_found: 5,
  run_not_active: 7,
  not_a_git_repo: 8,
  bare_repo_unsupported: 8,
  team_root_not_found: 8,
  io_error: 8,
  unsupported_schema_version: 8,
};

export interface CliResult {
  exitCode: number;
  stdout: string;
}

function render(env: Envelope, json: boolean): string {
  if (json) return JSON.stringify(env);
  const lines = [env.message];
  const checks = (env.data as { checks?: DoctorCheck[] } | undefined)?.checks;
  if (checks) for (const c of checks) lines.push(`  [${c.status}] ${c.name} — ${c.detail}`);
  for (const w of env.warnings) lines.push(`  warning: ${w.message}`);
  for (const a of env.next_actions) lines.push(`  next: ${a}`);
  return lines.join('\n');
}

/**
 * CLI front-end: parse argv, delegate to a primitive, print the envelope, map exit code.
 * @contract docs/17 §1 command table · §2 envelope · §2.2 exit-code map · docs/20 §3 (front ends hold no business rules)
 */
export function runCli(argv: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): CliResult {
  const json = argv.includes('--json');
  const force = argv.includes('--force');
  const args = argv.filter((a) => !a.startsWith('--'));
  const cmd = args[0];
  let env: Envelope;
  if (cmd === 'init') {
    env = initProject({ cwd: opts.cwd, env: opts.env });
  } else if (cmd === 'doctor') {
    env = doctorProject({ cwd: opts.cwd, env: opts.env });
  } else if (cmd === 'task' && args[1] === 'publish') {
    const runId = args[2];
    if (!runId) {
      env = failEnvelope('usage_error', 'Usage: sigmarun task publish <RUN-ID> [--tasks=TASK-0001,...] [--force] [--json]');
    } else {
      const tasksFlag = argv.find((a) => a.startsWith('--tasks='));
      const taskIds = tasksFlag ? tasksFlag.slice('--tasks='.length).split(',').filter(Boolean) : undefined;
      env = publishTasks({ cwd: opts.cwd, env: opts.env, runId, taskIds, force });
    }
  } else if (cmd === 'run' && args[1] === 'import') {
    const file = args[2];
    if (!file) {
      env = failEnvelope('usage_error', 'Usage: sigmarun run import <payload.json> [--force] [--json]');
    } else {
      try {
        const payload = JSON.parse(readFileSync(file, 'utf8'));
        env = importRun({ cwd: opts.cwd, env: opts.env, payload, force });
      } catch (e) {
        env = failEnvelope('schema_invalid', `Payload file is not valid JSON: ${String(e)}`);
      }
    }
  } else {
    env = failEnvelope('usage_error', `Unknown command: ${cmd ?? '(none)'}`);
  }
  return { exitCode: EXIT_BY_CODE[env.code] ?? 1, stdout: render(env, json) };
}
