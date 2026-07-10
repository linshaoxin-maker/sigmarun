import { initProject, doctorProject, failEnvelope, type Envelope, type DoctorCheck } from '@sigmarun/core';

const EXIT_BY_CODE: Record<string, number> = {
  OK: 0,
  usage_error: 2,
  lock_timeout: 3,
  rev_conflict: 6,
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
  const args = argv.filter((a) => a !== '--json');
  const cmd = args[0];
  let env: Envelope;
  switch (cmd) {
    case 'init':
      env = initProject({ cwd: opts.cwd, env: opts.env });
      break;
    case 'doctor':
      env = doctorProject({ cwd: opts.cwd, env: opts.env });
      break;
    default:
      env = failEnvelope('usage_error', `Unknown command: ${cmd ?? '(none)'}`);
  }
  return { exitCode: EXIT_BY_CODE[env.code] ?? 1, stdout: render(env, json) };
}
