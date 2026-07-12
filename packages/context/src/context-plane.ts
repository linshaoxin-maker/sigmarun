import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GatewayError,
  tryAcquireLock,
  runLockPath,
  readJsonState,
  resolveTeamRoot,
  scanForSecrets,
  writeJsonStateAtomic,
  type ResolveOptions,
} from '@sigmarun/storage';
import { appendEvent, failEnvelope, okEnvelope, type Envelope, type EnvelopeWarning } from '@sigmarun/core';

/** docs/12 §6 message type enum. */
export const MESSAGE_TYPES = [
  'question',
  'answer',
  'blocker',
  'handoff',
  'context_update',
  'decision',
  'risk',
  'finding',
  'request_changes',
  'note',
] as const;

export interface PostMessageOptions extends ResolveOptions {
  runId: string;
  fromAgentId: string;
  type: string;
  body: string;
  taskId?: string;
  to?: string;
  inReplyTo?: string;
  refs?: string[];
}

export interface ListMessagesOptions extends ResolveOptions {
  runId: string;
  taskId?: string;
  type?: string;
  open?: boolean;
}

export interface HydrateOptions extends ResolveOptions {
  runId: string;
  taskId: string;
  agentId?: string;
}

export interface GraphValidateOptions extends ResolveOptions {
  runId: string;
}

export interface MemoryUpdateOptions extends ResolveOptions {
  runId: string;
  content: string;
}

interface MessageLine {
  message_id: string;
  run_id: string;
  task_id: string | null;
  from_agent_id: string;
  to: string;
  type: string;
  in_reply_to?: string;
  visibility: string;
  body: string;
  created_at: string;
  status: string;
  refs: string[];
}

interface RunCtx {
  repoRoot: string;
  runDir: string;
  runId: string;
}

function openRun(opts: ResolveOptions & { runId: string }): RunCtx | GatewayError {
  try {
    const resolved = resolveTeamRoot(opts);
    const runDir = join(resolved.teamRoot, 'runs', opts.runId);
    if (!existsSync(join(runDir, 'run.json'))) {
      return new GatewayError('run_not_found', `Run ${opts.runId} does not exist under .team/runs/.`);
    }
    return { repoRoot: resolved.repoRoot, runDir, runId: opts.runId };
  } catch (err) {
    return err as GatewayError;
  }
}

function readMessages(runDir: string): MessageLine[] {
  const file = join(runDir, 'context', 'messages.jsonl');
  if (!existsSync(file)) return [];
  // messages.jsonl is appended non-atomically; a torn tail (crash/ENOSPC mid-append)
  // must not crash readers. Skip unparseable lines, same discipline as readEventsSafe.
  const out: MessageLine[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as MessageLine);
    } catch {
      // torn/corrupt line — skip it
    }
  }
  return out;
}

/** M23: open questions are derived — a question is open until an answer replies to it. */
function openQuestions(messages: MessageLine[]): MessageLine[] {
  const answered = new Set(messages.filter((m) => m.type === 'answer' && m.in_reply_to).map((m) => m.in_reply_to as string));
  return messages.filter((m) => m.type === 'question' && !answered.has(m.message_id));
}

function relevantToTask(m: MessageLine, taskId: string): boolean {
  return m.to === 'run' || m.to === `task:${taskId}` || m.task_id === taskId;
}

// ---------- msg post ----------

export function postMessage(opts: PostMessageOptions): Envelope {
  const startedAt = Date.now();
  const ctx = openRun(opts);
  if (ctx instanceof GatewayError) return failEnvelope(ctx.code, ctx.message, { startedAt });
  const { runDir, runId } = ctx;

  if (!(MESSAGE_TYPES as readonly string[]).includes(opts.type)) {
    return failEnvelope('schema_invalid', `Unknown message type "${opts.type}". Allowed: ${MESSAGE_TYPES.join(', ')}.`, { startedAt });
  }
  if (!opts.body || opts.body.trim().length === 0) {
    return failEnvelope('schema_invalid', 'Message body must not be empty.', { startedAt });
  }
  // Smoke-test L3: the human answering a blocker must not need to borrow an agent identity.
  if (opts.fromAgentId !== 'user' && !existsSync(join(runDir, 'agents', `${opts.fromAgentId}.json`))) {
    return failEnvelope('agent_not_registered', `Agent ${opts.fromAgentId} is not registered on ${runId}.`, {
      nextActions: [`Register first: sigmarun agent register ${runId} --tool=<tool> --label=<window>`, 'Posting as the human? Use --from=user.'],
      startedAt,
    });
  }

  const release = tryAcquireLock(runLockPath(runDir));
  if (release instanceof GatewayError) return failEnvelope(release.code, release.message, { startedAt });

  try {
    const warnings: EnvelopeWarning[] = [];
    const hits = scanForSecrets(opts.body);
    if (hits.length > 0) {
      warnings.push({
        code: 'secret_in_message',
        message: `Body matches ${hits.length} secret pattern(s) (${hits.map((h) => h.kind).join(', ')}). Remove credentials; full redaction lands with the evidence pipeline.`,
      });
    }
    const countersFile = join(runDir, 'counters.json');
    const counters = readJsonState(countersFile);
    const cdoc = counters.doc as Record<string, unknown>;
    const n = Number(cdoc.next_msg ?? 1);
    const messageId = `MSG-${String(n).padStart(4, '0')}`;
    const line: MessageLine = {
      message_id: messageId,
      run_id: runId,
      task_id: opts.taskId ?? null,
      from_agent_id: opts.fromAgentId,
      to: opts.to ?? 'run',
      type: opts.type,
      ...(opts.inReplyTo ? { in_reply_to: opts.inReplyTo } : {}),
      visibility: 'run',
      body: opts.body,
      created_at: new Date().toISOString(),
      status: opts.type === 'question' || opts.type === 'blocker' ? 'open' : 'resolved',
      refs: opts.refs ?? [],
    };
    mkdirSync(join(runDir, 'context'), { recursive: true });
    appendFileSync(join(runDir, 'context', 'messages.jsonl'), JSON.stringify(line) + '\n', 'utf8');
    writeJsonStateAtomic(countersFile, { ...cdoc, next_msg: n + 1 }, { expectedRev: counters.rev });
    // INV-011: messages are collaboration context, not audit events — no events.jsonl mirror.
    return okEnvelope({
      message: `Posted ${messageId} (${opts.type}) to ${line.to}.`,
      data: { message_id: messageId, to: line.to, type: opts.type },
      warnings,
      startedAt,
    });
  } catch (err) {
    if (err instanceof GatewayError) return failEnvelope(err.code, err.message, { startedAt });
    throw err;
  } finally {
    release();
  }
}

// ---------- msg list ----------

export function listMessages(opts: ListMessagesOptions): Envelope {
  const startedAt = Date.now();
  const ctx = openRun(opts);
  if (ctx instanceof GatewayError) return failEnvelope(ctx.code, ctx.message, { startedAt });
  let messages = readMessages(ctx.runDir);
  if (opts.open) messages = openQuestions(messages);
  if (opts.taskId) messages = messages.filter((m) => m.task_id === opts.taskId || m.to === `task:${opts.taskId}`);
  if (opts.type) messages = messages.filter((m) => m.type === opts.type);
  return okEnvelope({
    message: `${messages.length} message(s) on ${ctx.runId}${opts.open ? ' (open questions)' : ''}.`,
    data: { messages },
    startedAt,
  });
}

// ---------- context hydrate ----------

export function hydrateContext(opts: HydrateOptions): Envelope {
  const startedAt = Date.now();
  const ctx = openRun(opts);
  if (ctx instanceof GatewayError) return failEnvelope(ctx.code, ctx.message, { startedAt });
  const { repoRoot, runDir, runId } = ctx;
  const taskDir = join(runDir, 'tasks', opts.taskId);
  if (!existsSync(join(taskDir, 'task.json'))) {
    return failEnvelope('task_not_found', `Task ${opts.taskId} does not exist on ${runId}.`, { startedAt });
  }

  const task = readJsonState(join(taskDir, 'task.json')).doc as {
    paths?: { avoid?: string[]; requires_approval?: string[] };
    previous_attempts?: unknown[];
  };

  // must_read assembly order: own brief -> run memory -> L4 project memory (D19) -> upstream handoffs.
  const mustRead: string[] = [`tasks/${opts.taskId}/task.md`];
  if (existsSync(join(runDir, 'context', 'run-memory.md'))) mustRead.push('context/run-memory.md');
  const projectMemoryPath = (() => {
    try {
      const project = readJsonState(join(runDir, '..', '..', 'project.json')).doc as { project_memory_path?: string };
      return project.project_memory_path ?? 'docs/team/MEMORY.md';
    } catch {
      return 'docs/team/MEMORY.md';
    }
  })();
  if (existsSync(join(repoRoot, projectMemoryPath))) mustRead.push(projectMemoryPath);

  const graph = readJsonState(join(runDir, 'task-graph.json')).doc as {
    edges?: Array<{ from: string; to: string; kind: string }>;
  };
  const upstream = (graph.edges ?? [])
    .filter((e) => e.to === opts.taskId && (e.kind === 'blocks' || e.kind === 'produces_context_for'))
    .map((e) => e.from);
  for (const u of [...new Set(upstream)].sort()) {
    const handoff = `context/tasks/${u}.md`;
    const evidence = `evidence/${u}/evidence.md`;
    if (existsSync(join(runDir, handoff))) mustRead.push(handoff);
    if (existsSync(join(runDir, evidence))) mustRead.push(evidence);
  }

  const all = readMessages(runDir);
  const messages = all.filter((m) => relevantToTask(m, opts.taskId));
  const open = openQuestions(all).filter((m) => relevantToTask(m, opts.taskId));

  const risks: string[] = [];
  for (const g of task.paths?.avoid ?? []) risks.push(`Avoid ${g} (declared avoid path).`);
  for (const g of task.paths?.requires_approval ?? []) risks.push(`${g} requires approval before changes (run: sigmarun approve-paths).`);

  const release = tryAcquireLock(runLockPath(runDir));
  if (release instanceof GatewayError) return failEnvelope(release.code, release.message, { startedAt });
  try {
    appendEvent(runDir, {
      event: 'context_hydrated',
      actor: opts.agentId ? { type: 'agent', id: opts.agentId } : { type: 'user', id: 'user' },
      run_id: runId,
      task_id: opts.taskId,
      payload: { must_read: mustRead },
    });
  } finally {
    release();
  }

  return okEnvelope({
    message: `Context pack for ${opts.taskId}: ${mustRead.length} must-read file(s), ${messages.length} message(s), ${open.length} open question(s).`,
    data: {
      run_id: runId,
      task_id: opts.taskId,
      must_read: mustRead,
      messages,
      open_questions: open,
      risks,
      previous_attempts: task.previous_attempts ?? [],
    },
    nextActions: ['Read every must_read file before writing code (AUD-028 will check the ack).'],
    startedAt,
  });
}

// ---------- graph validate ----------

export function validateGraph(opts: GraphValidateOptions): Envelope {
  const startedAt = Date.now();
  const ctx = openRun(opts);
  if (ctx instanceof GatewayError) return failEnvelope(ctx.code, ctx.message, { startedAt });
  const { runDir, runId } = ctx;
  const graph = readJsonState(join(runDir, 'task-graph.json')).doc as {
    nodes?: Array<{ task_id: string }>;
    edges?: Array<{ edge_id?: string; from: string; to: string; kind: string }>;
  };
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  const nodeIds = new Set(nodes.map((n) => n.task_id));
  const issues: Array<Record<string, unknown>> = [];

  // AUD-022: dangling edges — endpoint not in nodes[] or task directory missing.
  for (const e of edges) {
    for (const end of [e.from, e.to]) {
      if (!nodeIds.has(end)) {
        issues.push({ rule: 'AUD-022', edge_id: e.edge_id ?? null, detail: `Edge points at unknown task ${end}.` });
      } else if (!existsSync(join(runDir, 'tasks', end))) {
        issues.push({ rule: 'AUD-022', edge_id: e.edge_id ?? null, detail: `Task directory tasks/${end}/ is missing.` });
      }
    }
  }

  // AUD-021: cycle over blocks edges (defense in depth for files edited behind the CLI).
  const adj = new Map<string, string[]>();
  for (const e of edges.filter((e) => e.kind === 'blocks')) {
    adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
  }
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const dfs = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const next of adj.get(id) ?? []) {
      const s = state.get(next) ?? 0;
      if (s === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (s === 0) {
        const found = dfs(next);
        if (found) return found;
      }
    }
    state.set(id, 2);
    stack.pop();
    return null;
  };
  for (const id of nodeIds) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = dfs(id);
      if (cycle) {
        issues.push({ rule: 'AUD-021', cycle, detail: `Dependency cycle: ${cycle.join(' -> ')}.` });
        break;
      }
    }
  }

  if (issues.length > 0) {
    return failEnvelope('schema_invalid', `task-graph.json has ${issues.length} issue(s) on ${runId}.`, {
      data: { issues },
      nextActions: ['Repair the graph or the missing task directories, then re-run graph validate.'],
      startedAt,
    });
  }
  return okEnvelope({
    message: `Graph on ${runId} is healthy: ${nodes.length} node(s), ${edges.length} edge(s), no cycles, no dangling edges.`,
    data: { nodes: nodes.length, edges: edges.length, issues: [] },
    startedAt,
  });
}

// ---------- memory update ----------

export function updateRunMemory(opts: MemoryUpdateOptions): Envelope {
  const startedAt = Date.now();
  const ctx = openRun(opts);
  if (ctx instanceof GatewayError) return failEnvelope(ctx.code, ctx.message, { startedAt });
  const { runDir, runId } = ctx;
  if (!opts.content || opts.content.trim().length === 0) {
    return failEnvelope('schema_invalid', 'Run memory content must not be empty.', { startedAt });
  }
  const hits = scanForSecrets(opts.content);
  if (hits.length > 0) {
    return failEnvelope(
      'schema_invalid',
      `Run memory rejected: content matches ${hits.length} secret pattern(s) (${hits.map((h) => h.kind).join(', ')}).`,
      { nextActions: ['Remove the credential material and retry; memory must never store secrets.'], startedAt },
    );
  }
  const warnings: EnvelopeWarning[] = [];
  if (!/Source:/.test(opts.content)) {
    warnings.push({
      code: 'memory_without_sources',
      message: 'No "Source:" references found; compressed memory should cite its origins (docs/12 §7).',
    });
  }
  mkdirSync(join(runDir, 'context'), { recursive: true });
  const target = join(runDir, 'context', 'run-memory.md');
  const tmp = target + '.tmp';
  writeFileSync(tmp, opts.content, 'utf8');
  renameSync(tmp, target);
  return okEnvelope({
    message: `Run memory updated for ${runId} (${opts.content.length} chars).`,
    data: { path: 'context/run-memory.md' },
    warnings,
    startedAt,
  });
}

/** Read-only DAG view: nodes with derived status + edges (status stays derived, 13 §5.5). */
export function showGraph(opts: GraphValidateOptions): Envelope {
  const startedAt = Date.now();
  const ctx = openRun(opts);
  if (ctx instanceof GatewayError) return failEnvelope(ctx.code, ctx.message, { startedAt });
  const graph = readJsonState(join(ctx.runDir, 'task-graph.json')).doc as {
    nodes?: Array<{ task_id: string; title: string; type: string }>;
    edges?: Array<{ edge_id?: string; from: string; to: string; kind: string; required?: boolean }>;
  };
  const rows = (readJsonState(join(ctx.runDir, 'team-task-list.json')).doc as { tasks: Array<{ task_id: string; status: string }> }).tasks;
  const statusOf = new Map(rows.map((r) => [r.task_id, r.status]));
  const nodes = (graph.nodes ?? []).map((n) => ({ ...n, status: statusOf.get(n.task_id) ?? 'unknown' }));
  return okEnvelope({
    message: `Graph on ${ctx.runId}: ${nodes.length} node(s), ${(graph.edges ?? []).length} edge(s).`,
    data: { nodes, edges: graph.edges ?? [] },
    startedAt,
  });
}
