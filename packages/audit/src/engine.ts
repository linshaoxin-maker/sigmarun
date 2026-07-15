import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GatewayError, readJsonState, resolveTeamRoot, scanForSecrets, type ResolveOptions } from '@sigmarun/storage';
import { collectStateRevs, failEnvelope, fileInScope, okEnvelope, pathsOverlapConservative, readEventsSafe, type Envelope } from '@sigmarun/core';
import { foldLedger } from './replay.js';

export interface AuditOptions extends ResolveOptions {
  runId: string;
}

export interface Finding {
  rule_id: string;
  severity: 'error' | 'warn' | 'info';
  message: string;
  next_action: string;
  refs: string[];
}

interface Ctx {
  repoRoot: string;
  runDir: string;
  runId: string;
  run: Record<string, unknown>;
  /** D21 lightweight profile: evidence-chain rules (AUD-011/016/017/019) downgrade to info —
   * direct completion is the sanctioned shape there, not a violation. All other rules unchanged. */
  lightweight: boolean;
  rows: Array<{ task_id: string; status: string; weight: number }>;
  taskClaims: Array<{ claim_id: string; task_id: string; agent_id: string; status: string; lease_until: string }>;
  pathClaims: Array<{ claim_id: string; task_id: string; agent_id: string; status: string; paths: { allow?: string[] } }>;
  reviewClaims: Array<{ claim_id: string; task_id: string; reviewer_agent_id: string; status: string }>;
  approvals: Array<{ task_id: string; paths: string[]; status: string }>;
  events: Array<{ seq: number; event: string; task_id?: string; payload?: Record<string, unknown> }>;
  messages: Array<{ message_id: string; type: string; task_id: string | null; created_at: string; refs?: string[]; in_reply_to?: string }>;
  answered: Set<string>;
  taskDetail: (taskId: string) => Record<string, unknown> | null;
  evidence: (taskId: string) => Record<string, unknown> | null;
  reviews: (taskId: string) => Array<Record<string, unknown>>;
  verifications: Array<Record<string, unknown>>;
}

const ACTIVE = (c: { status: string }) => c.status === 'active';
const TASK_CLAIM_TERMINAL = new Set(['released', 'reclaimed', 'cancelled']);

/** docs/18 §4 — rules whose data planes exist today. The rest are registered skips (docs/18 §7 honesty over coverage). */
const SKIPPED: Array<{ rule_id: string; reason: string }> = []; // all 40 catalog rules are live (docs/18 §4)

type Rule = { id: string; check: (ctx: Ctx) => Finding[] };

const finding = (rule_id: string, severity: 'error' | 'warn' | 'info', message: string, next_action: string, refs: string[] = []): Finding => ({
  rule_id,
  severity,
  message,
  next_action,
  refs,
});

function taskStatus(ctx: Ctx, taskId: string, fallback: string): string {
  return String(ctx.taskDetail(taskId)?.status ?? fallback);
}

function activePathClaims(ctx: Ctx, taskId: string): Ctx['pathClaims'] {
  return ctx.pathClaims.filter((c) => c.task_id === taskId && ACTIVE(c));
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

const RULES: Rule[] = [
  {
    id: 'AUD-001',
    check: (ctx) => {
      const byTask = new Map<string, string[]>();
      for (const c of ctx.taskClaims.filter((c) => !['released', 'reclaimed', 'cancelled'].includes(c.status))) {
        byTask.set(c.task_id, [...(byTask.get(c.task_id) ?? []), c.claim_id]);
      }
      return [...byTask.entries()]
        .filter(([, ids]) => ids.length > 1)
        .map(([task, ids]) =>
          finding('AUD-001', 'error', `${task} has ${ids.length} unterminated claims: ${ids.join(', ')} (INV-003).`,
            `Run sigmarun reclaim ${ctx.runId} ${task} to adjudicate the keeper; check events for ordering.`, ids),
        );
    },
  },
  {
    id: 'AUD-002',
    check: (ctx) => {
      const out: Finding[] = [];
      const active = ctx.pathClaims.filter(ACTIVE);
      const policy = ((ctx.run.default_policy as { path_conflict_policy?: string } | undefined)?.path_conflict_policy) ?? 'block';
      for (let i = 0; i < active.length; i++) {
        for (let j = i + 1; j < active.length; j++) {
          const a = active[i]!;
          const b = active[j]!;
          if (a.task_id === b.task_id) continue;
          const hit = (a.paths.allow ?? []).some((ga) => (b.paths.allow ?? []).some((gb) => pathsOverlapConservative(ga, gb)));
          if (hit) {
            out.push(
              finding('AUD-002', policy === 'block' ? 'error' : 'warn',
                `Path claims of ${a.task_id} and ${b.task_id} overlap (INV-004).`,
                'Wait for the earlier holder to submit, or approve an explicit exception.', [a.claim_id, b.claim_id]),
            );
          }
        }
      }
      return out;
    },
  },
  {
    id: 'AUD-003',
    check: (ctx) => {
      const now = Date.now();
      return ctx.taskClaims
        .filter(ACTIVE)
        .filter((c) => now > Date.parse(c.lease_until))
        .filter((c) => (ctx.taskDetail(c.task_id)?.status as string) !== 'blocked')
        .map((c) =>
          finding('AUD-003', 'warn',
            `${c.claim_id} (${c.task_id}) lease expired ${Math.round((now - Date.parse(c.lease_until)) / 60_000)} min ago.`,
            `Past 3x TTL the sweep reclaims it automatically (D9); or run sigmarun reclaim ${ctx.runId} ${c.task_id}.`, [c.claim_id]),
        );
    },
  },
  {
    id: 'AUD-004',
    check: (ctx) => {
      const out: Finding[] = [];
      for (const c of ctx.pathClaims.filter(ACTIVE)) {
        const detail = ctx.taskDetail(c.task_id);
        const needed = ((detail?.paths as { requires_approval?: string[] } | undefined)?.requires_approval) ?? [];
        if (needed.length === 0) continue;
        const granted = ctx.approvals.filter((a) => a.task_id === c.task_id && a.status === 'granted').flatMap((a) => a.paths);
        const missing = needed.filter((g) => !granted.includes(g));
        if (missing.length > 0) {
          out.push(
            finding('AUD-004', 'error', `${c.task_id} touches approval-gated paths without a grant: ${missing.join(', ')}.`,
              `Run sigmarun approve-paths ${ctx.runId} ${c.task_id} --paths=${missing.join(',')}.`, [c.claim_id]),
          );
        }
      }
      return out;
    },
  },
  {
    id: 'AUD-005',
    check: (ctx) => {
      const out: Finding[] = [];
      for (const row of ctx.rows) {
        const status = taskStatus(ctx, row.task_id, row.status);
        if (!['draft', 'ready'].includes(status)) continue;
        const held = ctx.taskClaims.filter((c) => c.task_id === row.task_id && !TASK_CLAIM_TERMINAL.has(c.status));
        for (const c of held) {
          out.push(finding('AUD-005', 'error', `${row.task_id} is ${status} but still has unterminated claim ${c.claim_id}.`,
            `Reclaim or release ${c.claim_id}; then restore ${row.task_id} to a consistent state.`, [c.claim_id]));
        }
      }
      return out;
    },
  },
  {
    id: 'AUD-006',
    check: (ctx) => {
      const out: Finding[] = [];
      for (const row of ctx.rows) {
        const status = taskStatus(ctx, row.task_id, row.status);
        if (!['claimed', 'working', 'blocked'].includes(status)) continue;
        const activeClaims = ctx.taskClaims.filter((c) => c.task_id === row.task_id && ACTIVE(c));
        const allow = ((ctx.taskDetail(row.task_id)?.paths as { allow?: string[] } | undefined)?.allow) ?? [];
        const activePaths = activePathClaims(ctx, row.task_id);
        if (activeClaims.length !== 1 || (allow.length > 0 && activePaths.length === 0)) {
          out.push(finding('AUD-006', 'error',
            `${row.task_id} is ${status} but active task/path claim counts are ${activeClaims.length}/${activePaths.length}.`,
            'Use the event ledger to identify the real owner, then reclaim or re-claim the task.', [row.task_id]));
        }
      }
      return out;
    },
  },
  {
    id: 'AUD-007',
    check: (ctx) => {
      const out: Finding[] = [];
      const holdPaths = ((ctx.run.default_policy as { path_release_on_submit?: string } | undefined)?.path_release_on_submit ?? 'hold') === 'hold';
      for (const row of ctx.rows) {
        const status = taskStatus(ctx, row.task_id, row.status);
        if (!['submitted', 'reviewing', 'approved'].includes(status)) continue;
        const submittedClaims = ctx.taskClaims.filter((c) => c.task_id === row.task_id && c.status === 'submitted');
        const allow = ((ctx.taskDetail(row.task_id)?.paths as { allow?: string[] } | undefined)?.allow) ?? [];
        const activePaths = activePathClaims(ctx, row.task_id);
        if (submittedClaims.length !== 1 || (holdPaths && allow.length > 0 && activePaths.length === 0)) {
          out.push(finding('AUD-007', 'error',
            `${row.task_id} is ${status} but submitted claim/path hold state is inconsistent.`,
            'Inspect the submit transaction; restore the submitted claim and held path claim or roll the task back.', [row.task_id]));
        }
      }
      return out;
    },
  },
  {
    id: 'AUD-008',
    check: (ctx) =>
      ctx.rows
        .filter((r) => taskStatus(ctx, r.task_id, r.status) === 'changes_requested')
        .filter((r) => !ctx.taskClaims.some((c) => c.task_id === r.task_id && ['submitted', 'active'].includes(c.status)))
        .map((r) =>
          finding('AUD-008', 'error', `${r.task_id} is changes_requested but no submitted/active owner claim can resume it.`,
            'Revive the submitted owner claim or reclaim and assign the rework explicitly.', [r.task_id]),
        ),
  },
  {
    id: 'AUD-009',
    check: (ctx) => {
      const terminal = new Set(['verified', 'integrated', 'done']);
      const out: Finding[] = [];
      for (const row of ctx.rows) {
        const status = taskStatus(ctx, row.task_id, row.status);
        if (!terminal.has(status)) continue;
        const held = ctx.taskClaims.filter((c) => c.task_id === row.task_id && ['active', 'submitted'].includes(c.status));
        for (const c of held) {
          out.push(finding('AUD-009', 'error', `${row.task_id} is ${status} but claim ${c.claim_id} is still ${c.status}.`,
            'Release terminal task claims after verifying the integration/release events.', [c.claim_id]));
        }
      }
      return out;
    },
  },
  {
    id: 'AUD-010',
    check: (ctx) => {
      const out: Finding[] = [];
      for (const row of ctx.rows) {
        if (taskStatus(ctx, row.task_id, row.status) !== 'cancelled') continue;
        const bad = ctx.taskClaims.filter((c) => c.task_id === row.task_id && !['cancelled', 'released', 'reclaimed'].includes(c.status));
        for (const c of bad) {
          out.push(finding('AUD-010', 'error', `${row.task_id} is cancelled but claim ${c.claim_id} is still ${c.status}.`,
            'Cascade-cancel or release the claim before considering the task closed.', [c.claim_id]));
        }
      }
      return out;
    },
  },
  {
    id: 'AUD-011',
    check: (ctx) => {
      const gated = new Set(['submitted', 'reviewing', 'approved', 'verified', 'integrated', 'done']);
      const out: Finding[] = [];
      for (const row of ctx.rows.filter((r) => gated.has(r.status))) {
        const ev = ctx.evidence(row.task_id);
        if (!ev) {
          out.push(ctx.lightweight
            ? finding('AUD-011', 'info', `${row.task_id} is ${row.status} with no evidence — expected in a lightweight run (D21 INV-007 waiver).`,
                'No action: lightweight tasks complete without an evidence gate.', [row.task_id])
            : finding('AUD-011', 'error', `${row.task_id} is ${row.status} but evidence.json is missing (INV-007).`,
                `Owner must re-run sigmarun submit; if the state was hand-edited, roll it back.`, [row.task_id]));
          continue;
        }
        const handoffRef = ev.handoff_ref as string | undefined;
        if (!handoffRef || !existsSync(join(ctx.runDir, handoffRef))) {
          out.push(finding('AUD-011', 'error', `${row.task_id} evidence handoff_ref is missing on disk (INV-010).`,
            'Re-submit with handoff content.', [row.task_id]));
        }
      }
      return out;
    },
  },
  {
    id: 'AUD-012',
    check: (ctx) => {
      const out: Finding[] = [];
      for (const row of ctx.rows) {
        const ev = ctx.evidence(row.task_id);
        if (!ev) continue;
        const commands = (ev.commands as Array<{ cmd_id?: string; exit_code?: number; output_ref?: string | null }> | undefined) ?? [];
        const byCmd = new Map(commands.map((c) => [c.cmd_id, c]));
        const results = (ev.required_checks_results as Array<{ check?: string; cmd_ref?: string; status?: string; note?: string }> | undefined) ?? [];
        for (const required of ((ctx.taskDetail(row.task_id)?.required_checks as string[] | undefined) ?? [])) {
          if (!results.some((r) => r.check === required)) {
            out.push(finding('AUD-012', 'error', `${row.task_id} required check "${required}" has no result.`,
              'Owner must re-run the missing check and submit new evidence.', [row.task_id]));
          }
        }
        for (const r of results) {
          if (!r.check || !['pass', 'fail', 'skipped'].includes(r.status ?? '')) {
            out.push(finding('AUD-012', 'error', `${row.task_id} has malformed check result "${r.check ?? '(missing)'}".`,
              'Re-submit evidence with a valid check status.', [row.task_id]));
            continue;
          }
          if (r.status === 'skipped') {
            if (!r.note) {
              out.push(finding('AUD-012', 'error', `${row.task_id} skipped check "${r.check}" has no note.`,
                'Explain the skip or run the check before submitting.', [row.task_id]));
            }
            continue;
          }
          const cmd = r.cmd_ref ? byCmd.get(r.cmd_ref) : undefined;
          const outputRef = cmd?.output_ref ?? null;
          if (!cmd || (r.status === 'pass' && cmd.exit_code !== 0) || !outputRef || !existsSync(join(ctx.runDir, 'evidence', row.task_id, outputRef))) {
            out.push(finding('AUD-012', 'error', `${row.task_id} check "${r.check}" is untrusted (cmd=${r.cmd_ref ?? '(missing)'}).`,
              'Re-run the command, preserve its output_ref, and re-submit evidence.', [row.task_id]));
          }
        }
      }
      return out;
    },
  },
  {
    id: 'AUD-013',
    check: (ctx) => {
      const out: Finding[] = [];
      for (const row of ctx.rows) {
        const ev = ctx.evidence(row.task_id);
        if (!ev) continue;
        const detail = ctx.taskDetail(row.task_id);
        const want = (detail?.acceptance as string[]) ?? [];
        const got = (ev.acceptance as Array<{ item: string; status: string }>) ?? [];
        const misaligned =
          got.length !== want.length ||
          want.some((item, i) => got[i]?.item !== item) ||
          got.some((g) => !['met', 'unmet', 'partial'].includes(g.status));
        if (misaligned) {
          out.push(finding('AUD-013', 'error', `${row.task_id} acceptance coverage does not match the task item-by-item.`,
            'Owner re-submits with acceptance aligned to task.json.', [row.task_id]));
        }
      }
      return out;
    },
  },
  {
    id: 'AUD-014',
    check: (ctx) => {
      const out: Finding[] = [];
      for (const row of ctx.rows) {
        const ev = ctx.evidence(row.task_id);
        if (!ev) continue;
        const globs = ctx.pathClaims
          .filter((c) => c.task_id === row.task_id && !['released', 'reclaimed', 'cancelled'].includes(c.status))
          .flatMap((c) => c.paths.allow ?? []);
        if (globs.length === 0) continue;
        const offside = ((ev.changed_files as Array<{ path: string }>) ?? []).filter((f) => !fileInScope(f.path, globs));
        if (offside.length > 0) {
          out.push(finding('AUD-014', 'warn', `${row.task_id} has ${offside.length} out-of-scope change(s): ${offside.map((f) => f.path).join(', ')}.`,
            'Reviewer scrutinises; split a new task or widen the claim explicitly.', [row.task_id]));
        }
      }
      return out;
    },
  },
  {
    id: 'AUD-015',
    check: (ctx) => {
      const out: Finding[] = [];
      for (const row of ctx.rows) {
        const owners = new Set(ctx.taskClaims.filter((c) => c.task_id === row.task_id).map((c) => c.agent_id));
        const attempts = (ctx.taskDetail(row.task_id)?.previous_attempts as Array<{ agent_id?: string }> | undefined) ?? [];
        for (const a of attempts) if (a.agent_id) owners.add(a.agent_id);
        if (owners.size === 0) continue;
        for (const review of ctx.reviews(row.task_id)) {
          const reviewer = review.reviewer_agent_id as string | null | undefined;
          if (!reviewer || !owners.has(reviewer)) continue;
          out.push(
            finding('AUD-015', 'error',
              `${review.review_id as string} reviewer ${reviewer} is a historical owner of ${row.task_id} (INV-008).`,
              `Void ${review.review_id as string}; another reviewer must claim and decide again.`, [String(review.review_id ?? row.task_id)]),
          );
        }
      }
      return out;
    },
  },
  {
    id: 'AUD-016',
    check: (ctx) => {
      const gated = new Set(['approved', 'verified', 'integrated', 'done']);
      return ctx.rows
        .filter((r) => gated.has(r.status))
        .filter((r) => ctx.reviews(r.task_id).length === 0)
        .map((r) =>
          ctx.lightweight
            ? finding('AUD-016', 'info', `${r.task_id} is ${r.status} with no review record — expected in a lightweight run (D21).`,
                'No action: lightweight runs have no review gate.', [r.task_id])
            : finding('AUD-016', 'error', `${r.task_id} is ${r.status} but has no review record (including skipped_by_policy).`,
                'Restore a valid review record or roll the task status back before continuing.', [r.task_id]),
        );
    },
  },
  {
    id: 'AUD-017',
    check: (ctx) => {
      const gated = new Set(['verified', 'integrated', 'done']);
      return ctx.rows
        .filter((r) => gated.has(r.status))
        .filter((r) =>
          !ctx.verifications.some((v) => {
            const target = v.target as { kind?: string; task_id?: string } | undefined;
            return target?.kind === 'task' && target.task_id === r.task_id && v.verdict === 'pass';
          }),
        )
        .map((r) =>
          ctx.lightweight
            ? finding('AUD-017', 'info', `${r.task_id} is ${r.status} with no verification record — expected in a lightweight run (D21).`,
                'No action: lightweight runs have no verification gate.', [r.task_id])
            : finding('AUD-017', 'error', `${r.task_id} is ${r.status} but has no passing task verification record.`,
                `Run sigmarun verify submit ${ctx.runId} --agent=<verifier> --verify=<file>, or roll the task status back.`, [r.task_id]),
        );
    },
  },
  {
    id: 'AUD-018',
    check: (ctx) => {
      const out: Finding[] = [];
      for (const root of [join(ctx.runDir, 'evidence'), join(ctx.runDir, 'verification', 'outputs')]) {
        for (const file of walkFiles(root)) {
          if (!/\.(log|txt|out|md)$/i.test(file)) continue;
          const hits = scanForSecrets(readFileSync(file, 'utf8'));
          if (hits.length > 0) {
            const rel = file.slice(ctx.runDir.length + 1);
            out.push(finding('AUD-018', 'error', `${rel} contains unredacted secret-like text (${hits.map((h) => h.kind).join(', ')}).`,
              'Remove the raw secret, fix the redaction pipeline if needed, then re-submit or re-verify.', [rel]));
          }
        }
      }
      return out;
    },
  },
  {
    id: 'AUD-019',
    check: (ctx) => {
      const policyAllowsSkip =
        (ctx.run.default_policy as { require_review?: boolean } | undefined)?.require_review === false;
      return ctx.events
        .filter((e) => e.event === 'review_skipped' && e.task_id)
        .map((e) => {
          const review = (ctx.taskDetail(e.task_id!)?.review as { required?: boolean } | undefined) ?? {};
          // 15 §9 / 18 §4.C: a task-mandated review can never be skipped (error). A skip while the
          // CURRENT policy still demands review is equally anomalous — submit only emits the event
          // under require_review=false, so either policy was edited afterwards or the event was
          // forged. Only the policy-legal skip (policy off, task not mandating) is plain history.
          const anomalous = review.required === true || !policyAllowsSkip;
          const sev = ctx.lightweight ? 'info' : anomalous ? 'error' : 'warn';
          return finding('AUD-019', sev,
            `${e.task_id} review was skipped (task.review.required=${review.required === undefined ? 'unset' : String(review.required)}, run require_review=${String(!policyAllowsSkip)}).`,
            ctx.lightweight ? 'No action: lightweight runs have no review gate.' : anomalous ? 'Restore the task to submitted and run an independent review.' : 'Keep the skip as audit history; no action if policy was intentional.',
            [`seq:${e.seq}`]);
        });
    },
  },
  {
    id: 'AUD-020',
    check: (ctx) => {
      const byTaskKind = new Map<string, string[]>();
      for (const c of ctx.reviewClaims.filter(ACTIVE)) {
        const key = `${c.task_id}\u0000${(c as { kind?: string }).kind ?? 'review'}`;
        byTaskKind.set(key, [...(byTaskKind.get(key) ?? []), c.claim_id]);
      }
      return [...byTaskKind.entries()]
        .filter(([, ids]) => ids.length > 1)
        .map(([key, ids]) => {
          const [task, kind] = key.split('\u0000');
          return finding('AUD-020', 'error', `${task} has ${ids.length} active ${kind} claims: ${ids.join(', ')}.`,
            'Keep the first valid claim and release the duplicates after checking events order.', ids);
        });
    },
  },
  {
    id: 'AUD-021',
    check: (ctx) => {
      const graph = readJsonState(join(ctx.runDir, 'task-graph.json')).doc as {
        edges?: Array<{ from: string; to: string; kind: string }>;
        nodes?: Array<{ task_id: string }>;
      };
      const adj = new Map<string, string[]>();
      for (const e of (graph.edges ?? []).filter((e) => e.kind === 'blocks')) {
        adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
      }
      const state = new Map<string, number>();
      const stack: string[] = [];
      const dfs = (id: string): string[] | null => {
        state.set(id, 1);
        stack.push(id);
        for (const nxt of adj.get(id) ?? []) {
          const s = state.get(nxt) ?? 0;
          if (s === 1) return [...stack.slice(stack.indexOf(nxt)), nxt];
          if (s === 0) {
            const c = dfs(nxt);
            if (c) return c;
          }
        }
        state.set(id, 2);
        stack.pop();
        return null;
      };
      for (const n of graph.nodes ?? []) {
        if ((state.get(n.task_id) ?? 0) === 0) {
          const cycle = dfs(n.task_id);
          if (cycle) {
            return [finding('AUD-021', 'error', `Dependency cycle: ${cycle.join(' -> ')}.`, 'Repair the graph (sigmarun graph validate locates it).', cycle)];
          }
        }
      }
      return [];
    },
  },
  {
    id: 'AUD-022',
    check: (ctx) => {
      const graph = readJsonState(join(ctx.runDir, 'task-graph.json')).doc as {
        edges?: Array<{ edge_id?: string; from: string; to: string }>;
        nodes?: Array<{ task_id: string }>;
      };
      const nodeIds = new Set((graph.nodes ?? []).map((n) => n.task_id));
      const out: Finding[] = [];
      for (const e of graph.edges ?? []) {
        for (const end of [e.from, e.to]) {
          if (!nodeIds.has(end) || !existsSync(join(ctx.runDir, 'tasks', end))) {
            out.push(finding('AUD-022', 'error', `${e.edge_id ?? 'edge'} points at missing task ${end}.`,
              'Run sigmarun graph validate; repair the graph or restore the task directory.', [e.edge_id ?? end]));
          }
        }
      }
      return out;
    },
  },
  {
    id: 'AUD-029',
    check: (ctx) => {
      const wtFile = join(ctx.runDir, 'worktrees.json');
      if (!existsSync(wtFile)) return [];
      const entries = (readJsonState(wtFile).doc as { entries: Array<{ worktree_id: string; path: string; status: string }> }).entries;
      return entries
        .filter((e) => e.status === 'active' && (!existsSync(e.path) || !existsSync(join(e.path, '.git'))))
        .map((e) =>
          finding('AUD-029', 'error', `${e.worktree_id} worktree path is gone: ${e.path}.`,
            'Reclaim the task per docs/16 §8 and mark the entry removed.', [e.worktree_id]),
        );
    },
  },
  {
    id: 'AUD-030',
    check: (ctx) => {
      try {
        const tracked = execFileSync('git', ['-C', ctx.repoRoot, 'ls-files', '.team'], { encoding: 'utf8' }).trim();
        if (tracked.length > 0) {
          return [finding('AUD-030', 'error', `Repository tracks .team/ files (D4 violation): ${tracked.split('\n').slice(0, 3).join(', ')}…`,
            'Run git rm -r --cached .team/ and confirm .gitignore contains .team/.', [])];
        }
      } catch {
        /* not a git failure worth a finding */
      }
      return [];
    },
  },
  {
    id: 'AUD-031',
    check: (ctx) => {
      const runsDir = join(ctx.runDir, '..');
      const myGlobs = ctx.rows.flatMap((r) => ((ctx.taskDetail(r.task_id)?.paths as { allow?: string[] })?.allow) ?? []);
      const out: Finding[] = [];
      for (const entry of readdirSync(runsDir)) {
        if (entry === ctx.runId) continue;
        const rf = join(runsDir, entry, 'run.json');
        if (!existsSync(rf)) continue;
        const status = (readJsonState(rf).doc as { status: string }).status;
        if (!['active', 'integrating'].includes(status)) continue;
        const listFile = join(runsDir, entry, 'team-task-list.json');
        if (!existsSync(listFile)) continue;
        const otherGlobs = (readJsonState(listFile).doc as { tasks: Array<{ paths?: { allow?: string[] } }> }).tasks.flatMap(
          (t) => t.paths?.allow ?? [],
        );
        const hits = myGlobs.filter((a) => otherGlobs.some((b) => pathsOverlapConservative(a, b)));
        if (hits.length > 0) {
          out.push(finding('AUD-031', 'warn', `${ctx.runId} and ${entry} overlap on: ${[...new Set(hits)].join(', ')} (D7).`,
            'Coordinate the integration order; the later integrator owns conflict resolution.', [entry]));
        }
      }
      return out;
    },
  },
  {
    id: 'AUD-032',
    check: (ctx) => {
      const latest = ctx.events[ctx.events.length - 1];
      if (!latest) return [];
      const revAfter = latest.payload?.rev_after;
      if (typeof revAfter !== 'object' || revAfter === null) {
        // A ledger where NO event carries rev_after predates the feature — that is
        // migration territory (docs/21), not tamper evidence. Mixed ledgers stay errors.
        const anyStamped = ctx.events.some((e) => typeof e.payload?.rev_after === 'object' && e.payload?.rev_after !== null);
        return [
          finding('AUD-032', anyStamped ? 'error' : 'warn',
            anyStamped
              ? `latest event seq ${latest.seq} has no rev_after snapshot while earlier events do; direct_state_edit_suspected cannot be evaluated.`
              : `ledger predates rev_after stamping (no event carries it); AUD-032 cannot run until new transactions land.`,
            anyStamped
              ? 'Run sigmarun repair after inspecting the latest transaction; then re-run audit.'
              : 'Any new gateway write will start stamping rev_after; no action needed for legacy history.',
            [`seq:${latest.seq}`]),
        ];
      }
      const snapshot = revAfter as Record<string, unknown>;
      const current = collectStateRevs(ctx.runDir);
      const mismatches: string[] = [];
      for (const [rel, rev] of Object.entries(current)) {
        // counters.json legitimately moves without a ledger entry: msg post allocates
        // MSG ids but never events (INV-011). Smoke-test regression: a message as the
        // run's last action made every audit scream direct_state_edit_suspected.
        if (rel === 'counters.json') continue;
        if (snapshot[rel] !== rev) mismatches.push(`${rel}: event=${String(snapshot[rel] ?? '(missing)')} current=${rev}`);
      }
      for (const [rel, rev] of Object.entries(snapshot)) {
        if (!rel.endsWith('.json') || typeof rev !== 'number') continue;
        if (!(rel in current)) mismatches.push(`${rel}: event=${rev} current=(missing)`);
      }
      return mismatches.length > 0
        ? [
            finding('AUD-032', 'error',
              `direct_state_edit_suspected after latest event seq ${latest.seq}: ${mismatches.slice(0, 6).join('; ')}.`,
              'Treat current state as untrusted: inspect the listed files, then repair or replay from the event ledger.', [`seq:${latest.seq}`]),
          ]
        : [];
    },
  },
  {
    id: 'AUD-033',
    check: (ctx) => {
      const out: Finding[] = [];
      for (let i = 1; i < ctx.events.length; i++) {
        const prev = ctx.events[i - 1]!.seq;
        const cur = ctx.events[i]!.seq;
        if (cur !== prev + 1) {
          out.push(finding('AUD-033', 'error', `events.jsonl breaks at seq ${prev} -> ${cur} (gap or duplicate).`,
            'Treat as tampering or a half-write; correlate with AUD-032 and escalate to a human.', []));
        }
      }
      const metaFile = join(ctx.runDir, 'events.meta.json');
      if (ctx.events.length > 0 && existsSync(metaFile)) {
        const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as { next_seq: number };
        const max = ctx.events[ctx.events.length - 1]!.seq;
        if (meta.next_seq !== max + 1) {
          out.push(finding('AUD-033', 'error', `events.meta.json next_seq=${meta.next_seq} disagrees with max seq ${max}.`,
            `Run sigmarun repair ${ctx.runId} to roll the counter forward.`, []));
        }
      }
      return out;
    },
  },
  {
    id: 'AUD-035',
    check: (ctx) => {
      const pf = join(ctx.runDir, 'progress.json');
      if (!existsSync(pf)) return [];
      const stored = JSON.parse(readFileSync(pf, 'utf8')) as { counts?: Record<string, number>; weight_total?: number };
      const counts: Record<string, number> = {};
      let weightTotal = 0;
      for (const r of ctx.rows) {
        counts[r.status] = (counts[r.status] ?? 0) + 1;
        // Match computeProgress exactly (docs/03 §9: cancelled leaves the denominator). AUD-035
        // used to sum every row, so any run with a cancelled task warned forever (the remedy
        // `status` just rewrote the same excluding-cancelled value — state-machine review Finding 3).
        if (r.status === 'cancelled') continue;
        weightTotal += r.weight ?? 1;
      }
      const drift =
        weightTotal !== (stored.weight_total ?? weightTotal) ||
        Object.keys({ ...counts, ...(stored.counts ?? {}) }).some((k) => (counts[k] ?? 0) !== (stored.counts?.[k] ?? 0));
      return drift
        ? [finding('AUD-035', 'warn', 'progress.json disagrees with a fresh recompute (INV-006).',
            `Run sigmarun status ${ctx.runId} to rebuild the derived file.`, [])]
        : [];
    },
  },
];

/** Locate the L4 project memory file (docs/25 §3.1); null when it does not exist yet. */
function memoryFile(ctx: Ctx): { path: string; rel: string; text: string } | null {
  const project = readJsonState(join(ctx.runDir, '..', '..', 'project.json')).doc as { project_memory_path?: string };
  const rel = project.project_memory_path ?? 'docs/team/MEMORY.md';
  const path = join(ctx.repoRoot, rel);
  if (!existsSync(path)) return null;
  return { path, rel, text: readFileSync(path, 'utf8') };
}

const MEMORY_RULES: Rule[] = [
  {
    id: 'AUD-036',
    check: (ctx) => {
      const mem = memoryFile(ctx);
      if (!mem) return [];
      const out: Finding[] = [];
      const lines = mem.text.split('\n');
      lines.forEach((l, i) => {
        const m = /^- \[(MEM-\d{4})\]/.exec(l);
        if (m && !(lines[i + 1] ?? '').trim().startsWith('⟨')) {
          out.push(finding('AUD-036', 'error', `${m[1]} has no provenance stamp (INV-012 project level).`,
            'Re-establish it via sigmarun memory promote --supersedes, or delete the line.', [m[1]!]));
        }
      });
      return out;
    },
  },
  {
    id: 'AUD-037',
    check: (ctx) => {
      const mem = memoryFile(ctx);
      if (!mem) return [];
      const lines = mem.text.split('\n').length;
      const kb = Buffer.byteLength(mem.text, 'utf8') / 1024;
      return lines > 200 || kb > 25
        ? [finding('AUD-037', 'warn', `Project memory oversize (${lines} lines / ${kb.toFixed(1)}KB; limits 200/25KB).`,
            'Merge or retire entries via --supersedes (they move to the Superseded section).', [mem.rel])]
        : [];
    },
  },
  {
    id: 'AUD-038',
    check: (ctx) => {
      const mem = memoryFile(ctx);
      if (!mem) return [];
      const ids = new Set([...mem.text.matchAll(/^- \[(MEM-\d{4})\]/gm)].map((m) => m[1]));
      const out: Finding[] = [];
      for (const m of mem.text.matchAll(/supersedes (MEM-\d{4})/g)) {
        if (!ids.has(m[1])) {
          out.push(finding('AUD-038', 'error', `Supersede chain broken: ${m[1]} does not exist in the file.`,
            'Fix the supersedes pointer or restore the old entry.', [m[1]!]));
        }
      }
      return out;
    },
  },
  {
    id: 'AUD-039',
    check: (ctx) => {
      const project = readJsonState(join(ctx.runDir, '..', '..', 'project.json')).doc as { project_memory_path?: string };
      const rel = project.project_memory_path ?? 'docs/team/MEMORY.md';
      const resolved = join(ctx.repoRoot, rel);
      const teamRoot = join(ctx.runDir, '..', '..');
      return resolved.startsWith(teamRoot)
        ? [finding('AUD-039', 'error', `Project memory sits inside .team/ (${rel}) and will vanish with it (D4).`,
            'Move it to a git-tracked path and update project.json.', [rel])]
        : [];
    },
  },
  {
    id: 'AUD-040',
    check: (ctx) => {
      const cap = ((ctx.run.default_policy as { max_active_claims_per_agent?: number } | undefined)?.max_active_claims_per_agent) ?? 1;
      const byAgent = new Map<string, number>();
      for (const c of ctx.taskClaims.filter(ACTIVE)) byAgent.set(c.agent_id, (byAgent.get(c.agent_id) ?? 0) + 1);
      return [...byAgent.entries()]
        .filter(([, n]) => n > cap)
        .map(([agent, n]) =>
          finding('AUD-040', 'error', `${agent} holds ${n} active claims (cap ${cap}; M36/D17 bypass suspected).`,
            'Check label-idempotent registration; release or reclaim the surplus claims.', [agent]),
        );
    },
  },
];
RULES.push(...MEMORY_RULES);

/** Messages, handoffs, and replay reconciliation (AUD-023..028, 034) — the last catalog batch. */
const CONTEXT_RULES: Rule[] = [
  {
    id: 'AUD-023',
    check: (ctx) => {
      const graph = readJsonState(join(ctx.runDir, 'task-graph.json')).doc as {
        edges?: Array<{ edge_id?: string; from: string; to: string; kind: string; required?: boolean; context_refs?: string[] }>;
      };
      const DOWN = new Set(['ready', 'claimed', 'working']);
      const UP = new Set(['submitted', 'reviewing', 'approved', 'verified', 'integrated', 'done']);
      const out: Finding[] = [];
      for (const e of (graph.edges ?? []).filter((e) => e.required && ['blocks', 'produces_context_for'].includes(e.kind))) {
        const refs = e.context_refs ?? [];
        if (refs.length === 0) continue;
        if (!UP.has(taskStatus(ctx, e.from, ''))) continue;
        if (!DOWN.has(taskStatus(ctx, e.to, ''))) continue;
        const missing = refs.filter((r) => !existsSync(join(ctx.runDir, r.split('#')[0]!)));
        if (missing.length > 0) {
          out.push(finding('AUD-023', 'warn', `${e.to} required context refs are missing: ${missing.join(', ')}.`,
            'Upstream owner restores the handoff files or fixes the refs.', [e.edge_id ?? e.to]));
        }
      }
      return out;
    },
  },
  {
    id: 'AUD-024',
    check: (ctx) => {
      const out: Finding[] = [];
      const openBlockers = ctx.messages.filter((m) => (m.type === 'blocker' || m.type === 'question') && !ctx.answered.has(m.message_id));
      const DONEISH = new Set(['submitted', 'reviewing', 'approved', 'verified', 'integrated', 'done']);
      for (const row of ctx.rows) {
        const status = taskStatus(ctx, row.task_id, row.status);
        const taskBlockers = openBlockers.filter((m) => m.task_id === row.task_id && m.type === 'blocker');
        if (status === 'blocked' && taskBlockers.length === 0 && !openBlockers.some((m) => m.task_id === row.task_id)) {
          out.push(finding('AUD-024', 'error', `${row.task_id} is blocked but carries no open blocker/question message.`,
            `Post the blocker (sigmarun msg post --type=blocker) or unblock: sigmarun unblock ${ctx.runId} ${row.task_id}.`, [row.task_id]));
        }
        if (DONEISH.has(status) && taskBlockers.length > 0) {
          out.push(finding('AUD-024', 'warn', `${row.task_id} is ${status} but still has ${taskBlockers.length} open blocker message(s).`,
            'Answer or resolve the blocker messages so status stops lying.', taskBlockers.map((m) => m.message_id)));
        }
      }
      return out;
    },
  },
  {
    id: 'AUD-025',
    check: (ctx) => {
      const ttlHours = Number(((ctx.run.default_policy as { context?: { question_ttl_hours?: number } } | undefined)?.context?.question_ttl_hours) ?? 24);
      const now = Date.now();
      return ctx.messages
        .filter((m) => (m.type === 'question' || m.type === 'blocker') && !ctx.answered.has(m.message_id))
        .filter((m) => now - Date.parse(m.created_at) > ttlHours * 3_600_000)
        .map((m) =>
          finding('AUD-025', 'warn',
            `${m.message_id}${m.task_id ? ` (${m.task_id})` : ''} has waited ${Math.round((now - Date.parse(m.created_at)) / 3_600_000)}h without an answer (TTL ${ttlHours}h).`,
            'Assign an answerer or escalate to the user.', [m.message_id]),
        );
    },
  },
  {
    id: 'AUD-026',
    check: (ctx) => {
      const out: Finding[] = [];
      // context/tasks/*.md are handoff mirrors the gateway writes at submit — their provenance
      // IS the linked evidence record, so demanding per-bullet Source: refs there is pure noise
      // (smoke-test L19: every healthy real-agent run warned). Rule scope: memory files only.
      const candidates: string[] = ['context/run-memory.md'];
      for (const rel of candidates) {
        const abs = join(ctx.runDir, rel);
        if (!existsSync(abs)) continue;
        const text = readFileSync(abs, 'utf8');
        // Only agent-written content needs provenance: the import skeleton has headers and
        // "(none yet)" placeholders but no bullet entries — those are fine.
        const hasEntries = text.split('\n').some((l) => l.trimStart().startsWith('- '));
        if (!hasEntries) continue;
        if (!/Source[s]?:|refs:/i.test(text)) {
          out.push(finding('AUD-026', 'warn', `${rel} carries content without source refs (INV-012).`,
            'Rewrite it via sigmarun memory update with Source: lines.', [rel]));
        }
      }
      return out;
    },
  },
  {
    id: 'AUD-027',
    check: (ctx) => {
      const ids = new Set(ctx.messages.map((m) => m.message_id));
      const out: Finding[] = [];
      for (const m of ctx.messages) {
        for (const ref of m.refs ?? []) {
          const ok = /^MSG-\d{4}$/.test(ref)
            ? ids.has(ref)
            : existsSync(join(ctx.runDir, ref.split('#')[0]!)) || existsSync(join(ctx.repoRoot, ref.split('#')[0]!));
          if (!ok) {
            out.push(finding('AUD-027', 'warn', `${m.message_id} references a missing ${ref}.`,
              'Sender fixes the ref; downstream must not rely on it.', [m.message_id]));
          }
        }
      }
      return out;
    },
  },
  {
    id: 'AUD-028',
    check: (ctx) => {
      const graph = readJsonState(join(ctx.runDir, 'task-graph.json')).doc as {
        edges?: Array<{ from: string; to: string; kind: string; required?: boolean }>;
      };
      const withUpstream = new Set(
        (graph.edges ?? []).filter((e) => e.required !== false && ['blocks', 'produces_context_for'].includes(e.kind)).map((e) => e.to),
      );
      const out: Finding[] = [];
      for (const row of ctx.rows.filter((r) => withUpstream.has(r.task_id))) {
        const ev = ctx.evidence(row.task_id);
        if (!ev) continue; // pre-submit tasks are AUD-023 territory
        const hydrate = [...ctx.events].reverse().find((e) => e.event === 'context_hydrated' && e.task_id === row.task_id) as
          | { payload?: { must_read?: string[] } }
          | undefined;
        if (!hydrate) {
          out.push(finding('AUD-028', 'warn', `${row.task_id} has required upstream context but no context_hydrated event (M22).`,
            'Owner re-reads the upstream handoff and acks it on the next submit.', [row.task_id]));
          continue;
        }
        const acked = new Set((ev.context_ack as string[] | undefined) ?? []);
        const missing = (hydrate.payload?.must_read ?? []).filter((m) => !acked.has(m));
        if (missing.length > 0) {
          out.push(finding('AUD-028', 'warn', `${row.task_id} did not acknowledge upstream handoff item(s): ${missing.join(', ')}.`,
            'Owner re-reads and acks on the next submit; reviewer scrutinises.', [row.task_id]));
        }
      }
      return out;
    },
  },
  {
    id: 'AUD-034',
    check: (ctx) => {
      const expectations = foldLedger(ctx.events as never);
      const out: Finding[] = [];
      for (const [taskId, expect] of expectations) {
        const actual = taskStatus(ctx, taskId, '(missing)');
        if (actual !== expect.status) {
          out.push(finding('AUD-034', 'error',
            `${taskId} is ${actual} but the event chain replays to ${expect.status} — a transition happened without its event.`,
            `Inspect events for ${taskId}; the ledger is authoritative — run sigmarun repair ${ctx.runId} to roll state to it.`, [taskId]));
        }
      }
      return out;
    },
  },
];
RULES.push(...CONTEXT_RULES);


/** Read-only batch audit — findings are data, exit stays 0 (docs/18 §7). */
export function auditRun(opts: AuditOptions): Envelope {
  const startedAt = Date.now();
  let repoRoot: string;
  let teamRoot: string;
  try {
    const resolved = resolveTeamRoot(opts);
    repoRoot = resolved.repoRoot;
    teamRoot = resolved.teamRoot;
  } catch (err) {
    const ge = err as GatewayError;
    return failEnvelope(ge.code, ge.message, { startedAt });
  }
  const runDir = join(teamRoot, 'runs', opts.runId);
  if (!existsSync(join(runDir, 'run.json'))) {
    return failEnvelope('run_not_found', `Run ${opts.runId} does not exist under .team/runs/.`, { startedAt });
  }

  const readClaims = <T>(rel: string): T[] => {
    const f = join(runDir, rel);
    return existsSync(f) ? ((readJsonState(f).doc as { claims: T[] }).claims ?? []) : [];
  };
  const readEvents = () => readEventsSafe(runDir);
  const safe = readEvents();
  const events = safe.events as Ctx['events'];
  const snapshotSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;

  const detailCache = new Map<string, Record<string, unknown> | null>();
  const evidenceCache = new Map<string, Record<string, unknown> | null>();
  const reviewCache = new Map<string, Array<Record<string, unknown>>>();
  const runDoc = readJsonState(join(runDir, 'run.json')).doc as Record<string, unknown>;
  const ctx: Ctx = {
    repoRoot,
    runDir,
    runId: opts.runId,
    run: runDoc,
    lightweight: runDoc.lightweight === true,
    rows: (readJsonState(join(runDir, 'team-task-list.json')).doc as { tasks: Ctx['rows'] }).tasks,
    taskClaims: readClaims('claims/task-claims.json'),
    pathClaims: readClaims('claims/path-claims.json'),
    reviewClaims: readClaims('claims/review-claims.json'),
    approvals: (() => {
      const f = join(runDir, 'claims', 'path-approvals.json');
      return existsSync(f) ? ((readJsonState(f).doc as { approvals: Ctx['approvals'] }).approvals ?? []) : [];
    })(),
    events,
    messages: (() => {
      const f = join(runDir, 'context', 'messages.jsonl');
      if (!existsSync(f)) return [];
      return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean) as Ctx['messages'];
    })(),
    answered: new Set<string>(),
    taskDetail: (taskId) => {
      if (!detailCache.has(taskId)) {
        const f = join(runDir, 'tasks', taskId, 'task.json');
        detailCache.set(taskId, existsSync(f) ? (readJsonState(f).doc as Record<string, unknown>) : null);
      }
      return detailCache.get(taskId)!;
    },
    evidence: (taskId) => {
      if (!evidenceCache.has(taskId)) {
        const f = join(runDir, 'evidence', taskId, 'evidence.json');
        evidenceCache.set(taskId, existsSync(f) ? (readJsonState(f).doc as Record<string, unknown>) : null);
      }
      return evidenceCache.get(taskId)!;
    },
    reviews: (taskId) => {
      if (!reviewCache.has(taskId)) {
        const dir = join(runDir, 'reviews', taskId);
        const records = existsSync(dir)
          ? readdirSync(dir)
              .filter((f) => f.endsWith('.json'))
              .sort()
              .map((f) => readJsonState(join(dir, f)).doc as Record<string, unknown>)
          : [];
        reviewCache.set(taskId, records);
      }
      return reviewCache.get(taskId)!;
    },
    verifications: (() => {
      const dir = join(runDir, 'verification');
      return existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => f.endsWith('.json'))
            .sort()
            .map((f) => readJsonState(join(dir, f)).doc as Record<string, unknown>)
        : [];
    })(),
  };

  for (const m of ctx.messages) {
    if (m.type === 'answer' && m.in_reply_to) ctx.answered.add(m.in_reply_to);
  }

  const findings: Finding[] = [];
  if (safe.corrupt_lines.length > 0) {
    findings.push(
      finding('AUD-033', 'error', `events.jsonl has ${safe.corrupt_lines.length} unparseable line(s) at ${safe.corrupt_lines.join(', ')} (torn write or tampering).`,
        `Run sigmarun repair ${opts.runId}; if the tail line is torn, restore it from the backup or truncate it manually.`, []),
    );
  }
  const rulesRun: string[] = [];
  for (const rule of RULES) {
    rulesRun.push(rule.id);
    try {
      findings.push(...rule.check(ctx));
    } catch (e) {
      findings.push(finding(rule.id, 'warn', `Rule crashed while checking: ${String(e)}.`, 'Inspect the state files this rule reads.', []));
    }
  }

  const after = readEvents().events;
  const concurrent = (after.length > 0 ? (after[after.length - 1]! as { seq: number }).seq : 0) !== snapshotSeq;
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warns = findings.filter((f) => f.severity === 'warn').length;
  return okEnvelope({
    message: `Audit of ${opts.runId} (snapshot seq ${snapshotSeq}): ${findings.length} finding(s) — ${errors} error, ${warns} warn, ${findings.length - errors - warns} info; ${rulesRun.length} rule(s) run, ${SKIPPED.length} skipped.`,
    data: {
      findings,
      rules_run: rulesRun,
      rules_skipped: SKIPPED,
      snapshot_seq: snapshotSeq,
      concurrent_writes_detected: concurrent,
    },
    nextActions: errors > 0 ? ['Fix errors first; findings carry their own next_action.'] : [],
    startedAt,
  });
}
