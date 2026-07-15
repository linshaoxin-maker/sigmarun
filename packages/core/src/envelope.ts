import type { ReasonCode } from '@sigmarun/storage';

export const GATEWAY_VERSION = '0.1.0';
export const ENVELOPE_VERSION = 'team.envelope.v1';

export interface EnvelopeWarning {
  code: string;
  message: string;
  refs?: string[];
}

export interface EnvelopeMeta {
  gateway_version: string;
  envelope_version: string;
  elapsed_ms: number;
  run_id?: string;
}

/** Uniform CLI/MCP return shape. @contract docs/17 §2 — machine face is English only (D16). */
export interface Envelope<T = unknown> {
  ok: boolean;
  code: ReasonCode | 'OK';
  message: string;
  data: T;
  warnings: EnvelopeWarning[];
  next_actions: string[];
  meta: EnvelopeMeta;
}

/**
 * Per-code default guidance (remediation C5; S12). A call site that knows more passes explicit
 * nextActions and wins. The old fallback sent every unlisted failure to `sigmarun doctor` —
 * which checks the ENVIRONMENT only and reads all-green precisely when the failure is about
 * run/task/claim state: a dead end dressed as a next step. Codes with no entry get no advice —
 * an empty list is honest, invented advice is not.
 */
const DEFAULT_NEXT_ACTIONS: Record<string, string[]> = {
  // environment — doctor's actual jurisdiction
  not_a_git_repo: ['Run this command inside a git repository.', 'Use `git init` to create one, then retry.'],
  bare_repo_unsupported: ['Use a non-bare working checkout of the repository.'],
  team_root_not_found: ['Run `sigmarun init` inside the target repository first.'],
  io_error: ['Check filesystem permissions and free space, then retry.'],
  lock_timeout: ['Another sigmarun command holds the run lock; retry in a few seconds.', 'A crashed holder is seized automatically ~30s after its last activity.'],
  // run / task state
  run_paused: ['Resume the run: sigmarun run resume <RUN>'],
  run_not_active: ['See where the run stands: sigmarun run show <RUN>'],
  invalid_transition: ['See where the task/run actually is: sigmarun status <RUN>'],
  mode_mismatch: ['See the run mode: sigmarun run show <RUN> — lightweight runs complete via `done`; full runs via the pipeline.'],
  // claims & gates
  claim_not_found: ['See live claims and the owner: sigmarun task show <RUN> <TASK>'],
  not_claim_owner: ['Only the claim holder may do this; see the owner: sigmarun task show <RUN> <TASK>'],
  task_already_claimed: ['Pick other work: sigmarun claim-next <RUN> --agent=<A>'],
  no_claimable_task: ['See the queue: sigmarun status <RUN>'],
  deps_blocked: ['See what blocks it: sigmarun task show <RUN> <TASK>'],
  path_conflict: ['Wait for the holder to submit, or pick other work: sigmarun claim-next <RUN> --agent=<A>'],
  requires_approval: ['Ask the human to grant the paths: sigmarun approve-paths <RUN> <TASK> --paths=<globs>'],
  agent_claim_limit: ['Submit or release your current task first.'],
  parallel_limit_reached: ['Wait for an in-flight task to finish, or raise max_parallel_tasks in the run policy.'],
  capability_mismatch: ['Claim with the matching role, or pick other work: sigmarun claim-next <RUN> --agent=<A>'],
  self_approval_forbidden: ['Another identity must take this gate: sigmarun claim-next <RUN> --agent=<other> --role=reviewer'],
  agent_not_registered: ['Register first: sigmarun agent register <RUN> --tool=<tool> --label=<window>'],
  // lookups
  run_not_found: ['List runs: sigmarun run list'],
  task_not_found: ['List the run tasks: sigmarun run show <RUN>'],
  backup_not_found: ['List restore points: sigmarun backup list'],
  // validation & conflicts
  schema_invalid: ['Fix exactly the listed items and retry.'],
  evidence_invalid: ['Fix exactly the listed items and re-run sigmarun submit.'],
  duplicate_payload: ['Inspect the existing run named in the message, or pass --force to import a duplicate on purpose.'],
  cross_run_conflict: ['See the overlapping run in data; renegotiate paths or finish the other run first.'],
  path_escape_detected: ['Keep the path inside the allowed root named in the message.'],
  export_target_invalid: ['Choose a target outside .team/ that is not gitignored, or pass --to=<dir>.'],
  export_redaction_hit: ['Remove the flagged secrets from the run artifacts, then re-export.'],
  memory_entry_invalid: ['Fix the listed refs/size issues and re-run memory promote.'],
  // integrity & versioning
  rev_conflict: ['State changed underneath this command (direct edit or crash residue): sigmarun audit run <RUN>, then sigmarun repair <RUN> if findings confirm.'],
  unsupported_schema_version: ['Upgrade sigmarun to a version that understands this on-disk schema.'],
  gateway_too_old: ['Upgrade the gateway: npm i -g sigmarun@latest'],
  usage_error: ['See all commands: sigmarun help'],
};

function meta(startedAt: number): EnvelopeMeta {
  return {
    gateway_version: GATEWAY_VERSION,
    envelope_version: ENVELOPE_VERSION,
    elapsed_ms: Math.max(0, Date.now() - startedAt),
  };
}

export function okEnvelope<T>(opts: {
  message: string;
  data?: T;
  warnings?: EnvelopeWarning[];
  nextActions?: string[];
  startedAt?: number;
}): Envelope<T> {
  return {
    ok: true,
    code: 'OK',
    message: opts.message,
    data: (opts.data ?? {}) as T,
    warnings: opts.warnings ?? [],
    next_actions: opts.nextActions ?? [],
    meta: meta(opts.startedAt ?? Date.now()),
  };
}

export function failEnvelope(
  code: ReasonCode,
  message: string,
  opts: { data?: unknown; nextActions?: string[]; startedAt?: number } = {},
): Envelope {
  const actions = opts.nextActions ?? DEFAULT_NEXT_ACTIONS[code] ?? [];
  return {
    ok: false,
    code,
    message,
    data: opts.data ?? {},
    warnings: [],
    next_actions: actions,
    meta: meta(opts.startedAt ?? Date.now()),
  };
}
