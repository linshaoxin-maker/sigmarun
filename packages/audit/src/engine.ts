import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GatewayError, readJsonState, resolveTeamRoot, type ResolveOptions } from '@sigmarun/storage';
import { failEnvelope, fileInScope, okEnvelope, pathsOverlapConservative, type Envelope } from '@sigmarun/core';

export interface AuditOptions extends ResolveOptions {
  runId: string;
}

export interface Finding {
  rule_id: string;
  severity: 'error' | 'warn';
  message: string;
  next_action: string;
  refs: string[];
}

interface Ctx {
  repoRoot: string;
  runDir: string;
  runId: string;
  run: Record<string, unknown>;
  rows: Array<{ task_id: string; status: string; weight: number }>;
  taskClaims: Array<{ claim_id: string; task_id: string; agent_id: string; status: string; lease_until: string }>;
  pathClaims: Array<{ claim_id: string; task_id: string; agent_id: string; status: string; paths: { allow?: string[] } }>;
  approvals: Array<{ task_id: string; paths: string[]; status: string }>;
  events: Array<{ seq: number; event: string; task_id?: string }>;
  taskDetail: (taskId: string) => Record<string, unknown> | null;
  evidence: (taskId: string) => Record<string, unknown> | null;
}

const ACTIVE = (c: { status: string }) => c.status === 'active';

/** docs/18 §4 — rules whose data planes exist today. The rest are registered skips (docs/18 §7 honesty over coverage). */
const SKIPPED: Array<{ rule_id: string; reason: string }> = [
  ...['AUD-005', 'AUD-006', 'AUD-007', 'AUD-008', 'AUD-009', 'AUD-010', 'AUD-012'].map((r) => ({
    rule_id: r,
    reason: 'review/verify record planes land with FEAT-009/010',
  })),
  ...['AUD-015', 'AUD-016', 'AUD-017', 'AUD-018', 'AUD-019', 'AUD-020'].map((r) => ({
    rule_id: r,
    reason: 'review/verify record planes land with FEAT-009/010',
  })),
  ...['AUD-023', 'AUD-024', 'AUD-025', 'AUD-026', 'AUD-027', 'AUD-028'].map((r) => ({
    rule_id: r,
    reason: 'context/report reconciliation batch lands after the submit/review loop closes (FEAT-009/010)',
  })),
  { rule_id: 'AUD-032', reason: 'rev_after is not yet emitted by write transactions (implementation debt, backlog)' },
  { rule_id: 'AUD-034', reason: 'event replay engine is a P1 item' },
];

type Rule = { id: string; check: (ctx: Ctx) => Finding[] };

const finding = (rule_id: string, severity: 'error' | 'warn', message: string, next_action: string, refs: string[] = []): Finding => ({
  rule_id,
  severity,
  message,
  next_action,
  refs,
});

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
    id: 'AUD-011',
    check: (ctx) => {
      const gated = new Set(['submitted', 'reviewing', 'approved', 'verified', 'integrated', 'done']);
      const out: Finding[] = [];
      for (const row of ctx.rows.filter((r) => gated.has(r.status))) {
        const ev = ctx.evidence(row.task_id);
        if (!ev) {
          out.push(finding('AUD-011', 'error', `${row.task_id} is ${row.status} but evidence.json is missing (INV-007).`,
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
  const eventsFile = join(runDir, 'events.jsonl');
  const readEvents = () =>
    existsSync(eventsFile)
      ? readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { seq: number; event: string })
      : [];
  const events = readEvents();
  const snapshotSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;

  const detailCache = new Map<string, Record<string, unknown> | null>();
  const ctx: Ctx = {
    repoRoot,
    runDir,
    runId: opts.runId,
    run: readJsonState(join(runDir, 'run.json')).doc as Record<string, unknown>,
    rows: (readJsonState(join(runDir, 'team-task-list.json')).doc as { tasks: Ctx['rows'] }).tasks,
    taskClaims: readClaims('claims/task-claims.json'),
    pathClaims: readClaims('claims/path-claims.json'),
    approvals: (() => {
      const f = join(runDir, 'claims', 'path-approvals.json');
      return existsSync(f) ? ((readJsonState(f).doc as { approvals: Ctx['approvals'] }).approvals ?? []) : [];
    })(),
    events,
    taskDetail: (taskId) => {
      if (!detailCache.has(taskId)) {
        const f = join(runDir, 'tasks', taskId, 'task.json');
        detailCache.set(taskId, existsSync(f) ? (readJsonState(f).doc as Record<string, unknown>) : null);
      }
      return detailCache.get(taskId)!;
    },
    evidence: (taskId) => {
      const f = join(runDir, 'evidence', taskId, 'evidence.json');
      return existsSync(f) ? (readJsonState(f).doc as Record<string, unknown>) : null;
    },
  };

  const findings: Finding[] = [];
  const rulesRun: string[] = [];
  for (const rule of RULES) {
    rulesRun.push(rule.id);
    try {
      findings.push(...rule.check(ctx));
    } catch (e) {
      findings.push(finding(rule.id, 'warn', `Rule crashed while checking: ${String(e)}.`, 'Inspect the state files this rule reads.', []));
    }
  }

  const after = readEvents();
  const concurrent = (after.length > 0 ? after[after.length - 1]!.seq : 0) !== snapshotSeq;
  const errors = findings.filter((f) => f.severity === 'error').length;
  return okEnvelope({
    message: `Audit of ${opts.runId} (snapshot seq ${snapshotSeq}): ${findings.length} finding(s) — ${errors} error, ${findings.length - errors} warn; ${rulesRun.length} rule(s) run, ${SKIPPED.length} skipped.`,
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
