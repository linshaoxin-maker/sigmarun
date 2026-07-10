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
