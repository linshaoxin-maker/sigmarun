import { z } from 'zod';

export const SUPPORTED_MAJOR = 1;

/** Parse a schema id of the form team.<object>.v<major> (docs/21 §3.1). */
export function parseSchemaId(id: string): { object: string; major: number } | null {
  const m = /^team\.([a-z_]+)\.v(\d+)$/.exec(id);
  if (!m) return null;
  return { object: m[1]!, major: Number(m[2]) };
}

/** team.project.v1 — docs/02 §6; passthrough keeps unknown fields (docs/21 §4.2). */
export const ProjectSchema = z
  .object({
    schema_version: z.string(),
    rev: z.number(),
    project_id: z.string(),
    team_dir: z.string(),
    min_gateway_version: z.string(),
    default_base_branch: z.string(),
    default_worktree_root: z.string(),
    default_checks: z.array(z.string()),
    project_memory_path: z.string(),
    tooling: z
      .object({
        supports_claude_code: z.boolean(),
        supports_codex: z.boolean(),
        supports_cursor: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

/** team.counters.v1 — docs/21 §2 #20 internal bookkeeping. */
export const CountersSchema = z
  .object({
    schema_version: z.string(),
    rev: z.number(),
    next_run: z.number(),
  })
  .passthrough();
