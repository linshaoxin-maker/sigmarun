import { createHash } from 'node:crypto';
import { z } from 'zod';
import { scanForSecrets } from '@sigmarun/storage';

export const TASK_TYPES = ['implementation', 'investigation', 'review', 'verification', 'integration', 'docs'] as const;

const PathsSchema = z.object({
  allow: z.array(z.string()).optional(),
  avoid: z.array(z.string()).optional(),
  requires_approval: z.array(z.string()).optional(),
}).passthrough();

const TaskSchema = z.object({
  client_task_key: z.string().min(1),
  title: z.string().min(1),
  type: z.enum(TASK_TYPES),
  objective: z.string().min(1),
  context: z.array(z.string()).optional(),
  acceptance: z.array(z.string()).min(1),
  depends_on: z.array(z.string()).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  weight: z.number().positive().optional(),
  suggested_role: z.string().optional(),
  paths: PathsSchema.optional(),
  required_checks: z.array(z.string()).optional(),
  review: z.object({ required: z.boolean().optional(), focus: z.array(z.string()).optional() }).passthrough().optional(),
}).passthrough();

/** team.plan_payload.v1 — docs/09 §3–5. */
export const PayloadSchema = z.object({
  schema_version: z.literal('team.plan_payload.v1'),
  source: z.object({
    tool: z.string(),
    command: z.string(),
    prompt: z.string(),
    agent_id: z.string().optional(),
    created_at: z.string().optional(),
  }).passthrough(),
  run: z.object({
    title: z.string().min(1),
    mode: z.enum(['feature', 'bugfix', 'debug', 'review', 'integration', 'spike', 'docs']),
    goal: z.string().min(1),
    base_branch: z.string().optional(),
    worktree_root: z.string().optional(),
    policy: z.record(z.unknown()).optional(),
  }).passthrough(),
  plan: z.object({ summary: z.string().min(1) }).passthrough(),
  tasks: z.array(TaskSchema).min(1),
  task_graph: z.array(z.object({ from: z.string(), to: z.string(), kind: z.string() }).passthrough()).optional(),
  publication: z.object({ initial_status: z.enum(['draft', 'ready']).optional(), requires_user_confirm: z.boolean().optional() }).passthrough().optional(),
}).passthrough();

export type PlanPayload = z.infer<typeof PayloadSchema>;

/** Runtime fields a planner must never forge. @contract docs/09 §9 */
const FORBIDDEN_TASK_FIELDS = [
  'run_id', 'task_id', 'owner_agent_id', 'claim_id', 'status', 'progress',
  'evidence', 'review_result', 'verification_result', 'integration_result',
];

export interface ValidationIssue { path: string; message: string }
export interface ValidationWarning { code: string; message: string }

function isBadPath(p: string): boolean {
  return p.startsWith('/') || p.includes('..') || /^[A-Za-z]:[\\/]/.test(p);
}

function findCycle(nodes: string[], edges: Array<[string, string]>): string[] | null {
  const adj = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const [a, b] of edges) adj.get(a)?.push(b);
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const dfs = (n: string): string[] | null => {
    state.set(n, 1);
    stack.push(n);
    for (const m of adj.get(n) ?? []) {
      if (state.get(m) === 1) return [...stack.slice(stack.indexOf(m)), m];
      if (!state.get(m)) {
        const c = dfs(m);
        if (c) return c;
      }
    }
    state.set(n, 2);
    stack.pop();
    return null;
  };
  for (const n of nodes) if (!state.get(n)) {
    const c = dfs(n);
    if (c) return c;
  }
  return null;
}

/**
 * Mechanical payload validation — structural and reference checks only, no semantic quality judgement.
 * @contract docs/09 §8.1 must-reject / §8.2 warnings · AUD-021 cycle (P0-inline) · docs/24 §4.1 secrets warn-only
 */
export function validatePayload(raw: unknown): { errors: ValidationIssue[]; warnings: ValidationWarning[]; payload?: PlanPayload } {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationWarning[] = [];

  const parsed = PayloadSchema.safeParse(raw);
  if (!parsed.success) {
    for (const i of parsed.error.issues) errors.push({ path: i.path.join('.'), message: i.message });
    return { errors, warnings };
  }
  const p = parsed.data;

  const keys = p.tasks.map((t) => t.client_task_key);
  for (const k of keys) {
    if (keys.filter((x) => x === k).length > 1 && !errors.some((e) => e.message.includes(k))) {
      errors.push({ path: 'tasks', message: `duplicate client_task_key: ${k}` });
    }
  }

  p.tasks.forEach((t, i) => {
    for (const f of FORBIDDEN_TASK_FIELDS) {
      if (f in t) errors.push({ path: `tasks.${i}.${f}`, message: `forbidden runtime field: ${f} (docs/09 §9)` });
    }
    for (const dep of t.depends_on ?? []) {
      if (!keys.includes(dep)) errors.push({ path: `tasks.${i}.depends_on`, message: `depends_on unknown key: ${dep}` });
    }
    const allPaths = [...(t.paths?.allow ?? []), ...(t.paths?.avoid ?? []), ...(t.paths?.requires_approval ?? [])];
    for (const pp of allPaths) {
      if (isBadPath(pp)) errors.push({ path: `tasks.${i}.paths`, message: `path must be repo-relative without "..": ${pp}` });
    }
    if (!t.paths?.allow?.length) warnings.push({ code: 'task_without_paths', message: `task ${t.client_task_key} has no paths.allow; path-conflict protection is weakened.` });
    if (!t.required_checks?.length) warnings.push({ code: 'task_without_checks', message: `task ${t.client_task_key} has no required_checks; verification will be unclear.` });
  });

  for (const e of p.task_graph ?? []) {
    if (!keys.includes(e.from) || !keys.includes(e.to)) {
      errors.push({ path: 'task_graph', message: `edge references unknown key: ${e.from} -> ${e.to}` });
    }
  }

  if (errors.length === 0) {
    const edges: Array<[string, string]> = [];
    p.tasks.forEach((t) => (t.depends_on ?? []).forEach((d) => edges.push([d, t.client_task_key])));
    (p.task_graph ?? []).filter((e) => e.kind === 'blocks').forEach((e) => edges.push([e.from, e.to]));
    const cycle = findCycle(keys, edges);
    if (cycle) errors.push({ path: 'task_graph', message: `dependency cycle detected: ${cycle.join(' -> ')} (AUD-021)` });
  }

  const secretText = [p.source.prompt, p.run.goal, p.plan.summary, ...p.tasks.flatMap((t) => t.context ?? [])].join('\n');
  const hits = scanForSecrets(secretText);
  if (hits.length > 0) {
    warnings.push({ code: 'secret_in_payload', message: `payload text matches secret patterns (${hits.map((h) => h.kind).join(', ')}); consider rewording and re-importing (docs/24 §4.1, warn-only).` });
  }

  return { errors, warnings, payload: errors.length === 0 ? p : undefined };
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Canonical payload fingerprint for D17 dedup. */
export function payloadHash(raw: unknown): string {
  return createHash('sha256').update(stableStringify(raw)).digest('hex');
}
