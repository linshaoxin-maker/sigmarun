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

const DEFAULT_NEXT_ACTIONS: Record<string, string[]> = {
  not_a_git_repo: ['Run this command inside a git repository.', 'Use `git init` to create one, then retry.'],
  bare_repo_unsupported: ['Use a non-bare working checkout of the repository.'],
  team_root_not_found: ['Run `sigmarun init` inside the target repository first.'],
  rev_conflict: ['Run `sigmarun doctor` and inspect the reported state files.'],
  unsupported_schema_version: ['Upgrade sigmarun, or migrate the on-disk state.'],
  io_error: ['Check filesystem permissions and free space, then retry.'],
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
  const actions = opts.nextActions ?? DEFAULT_NEXT_ACTIONS[code] ?? ['Run `sigmarun doctor` for diagnostics.'];
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
