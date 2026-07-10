export type ReasonCode =
  | 'OK'
  | 'usage_error'
  | 'not_a_git_repo'
  | 'bare_repo_unsupported'
  | 'team_root_not_found'
  | 'rev_conflict'
  | 'unsupported_schema_version'
  | 'schema_invalid'
  | 'duplicate_payload'
  | 'lock_timeout'
  | 'run_not_found'
  | 'task_not_found'
  | 'run_not_active'
  | 'run_paused'
  | 'cross_run_conflict'
  | 'agent_not_registered'
  | 'agent_claim_limit'
  | 'no_claimable_task'
  | 'task_already_claimed'
  | 'deps_blocked'
  | 'capability_mismatch'
  | 'path_conflict'
  | 'requires_approval'
  | 'parallel_limit_reached'
  | 'invalid_transition'
  | 'claim_not_found'
  | 'not_claim_owner'
  | 'evidence_invalid'
  | 'io_error';

/** Internal error carrying a contract reason code (docs/17 §3); converted to an envelope at the primitive layer (docs/20 §3 R2). */
export class GatewayError extends Error {
  constructor(
    public readonly code: ReasonCode,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}
