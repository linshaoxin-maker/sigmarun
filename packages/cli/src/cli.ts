import { readFileSync } from 'node:fs';
import { setVerbose } from '@sigmarun/storage';
import { initProject, doctorProject, importRun, publishTasks, runShow, readEvents, migrateState, backupList, restoreBackup, submitEvidence, integrateStart, integrateRecord, reportRun, exportRun, runPause, runResume, runCancel, runArchive, runReopen, taskAdd, taskCancel, taskDone, failEnvelope, type Envelope, type DoctorCheck, GATEWAY_VERSION } from '@sigmarun/core';
import { registerAgent, claimNext, heartbeat, releaseTask, reclaimTask, approvePaths, registerWorktree, adoptWorktree, reviewClaim, reviewDecide, resumeTask, unblockTask, blockTask, verifySubmit, listWorktrees, pruneWorktrees } from '@sigmarun/dispatch';
import { postMessage, listMessages, hydrateContext, validateGraph, showGraph, updateRunMemory, promoteMemory, memoryCandidates } from '@sigmarun/context';
import { installAdapters } from '@sigmarun/adapters';
import { statusRun, runList, taskShow, taskList, evidenceShow, agentList, watchOnce } from '@sigmarun/watch';
import { auditRun, repairRun } from '@sigmarun/audit';

const EXIT_BY_CODE: Record<string, number> = {
  OK: 0,
  usage_error: 2,
  lock_timeout: 3,
  schema_invalid: 4,
  evidence_invalid: 4,
  export_redaction_hit: 4,
  export_target_invalid: 4,
  path_escape_detected: 4,
  memory_entry_invalid: 4,
  rev_conflict: 6,
  duplicate_payload: 6,
  cross_run_conflict: 6,
  task_already_claimed: 6,
  path_conflict: 6,
  requires_approval: 6,
  not_claim_owner: 6,
  self_approval_forbidden: 6,
  no_claimable_task: 6,
  deps_blocked: 6,
  capability_mismatch: 6,
  parallel_limit_reached: 6,
  agent_claim_limit: 6,
  run_not_found: 5,
  backup_not_found: 5,
  task_not_found: 5,
  agent_not_registered: 5,
  claim_not_found: 5,
  run_not_active: 7,
  run_paused: 7,
  invalid_transition: 7,
  mode_mismatch: 7,
  gateway_too_old: 8,
  not_a_git_repo: 8,
  bare_repo_unsupported: 8,
  team_root_not_found: 8,
  io_error: 8,
  unsupported_schema_version: 8,
};

/** Read + parse a user-supplied JSON file, tolerating a leading UTF-8 BOM (editors add it). */
function readJsonFileBom(file: string): unknown {
  let raw = readFileSync(file, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return JSON.parse(raw);
}

/** `--name=value` flag lookup. */
function flag(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

/** Flags that carry a value (everything else is boolean). Drives the `--flag value` misuse diagnosis. */
const VALUE_FLAGS = new Set([
  'agent', 'task', 'role', 'tool', 'label', 'paths', 'evidence', 'review', 'verify', 'path', 'branch', 'status', 'owner',
  'from', 'type', 'body', 'to', 'reply-to', 'refs', 'file', 'entry', 'section', 'supersedes', 'tasks',
  'merge-commit', 'reason', 'interval', 'since', 'limit', 'note', 'team-root', 'msg',
]);

/**
 * The complete command surface, machine-reconciled against docs/17 §1 (D24): a command added
 * here without a docs row — or promised in docs without an entry here — is a red test, not a
 * drift discovered two audits later. Keep alphabetical within groups.
 */
export const COMMAND_SURFACE: string[] = [
  'init', 'doctor', 'adapter install',
  'run import', 'run list', 'run show', 'run pause', 'run resume', 'run cancel', 'run archive', 'run reopen',
  'task publish', 'task add', 'task list', 'task cancel', 'task show',
  'agent register', 'agent list',
  'claim-next', 'heartbeat', 'release', 'reclaim', 'approve-paths',
  'worktree register', 'worktree adopt', 'worktree list', 'worktree prune',
  'submit', 'done', 'block', 'unblock', 'resume', 'evidence show',
  'review claim', 'review approve', 'review request-changes', 'review block',
  'verify submit', 'integrate start', 'integrate record', 'report', 'export',
  'msg post', 'msg list', 'context hydrate', 'graph show', 'graph validate',
  'memory update', 'memory candidates', 'memory promote',
  'status', 'events', 'watch', 'audit run', 'repair', 'migrate', 'backup list', 'restore',
];

/** Command groups and their subcommands — used to answer `task lst` with the task menu, not "Unknown command: task". */
const GROUP_SUBCOMMANDS: Record<string, string> = {
  task: 'publish | add | list | cancel | show',
  run: 'import | list | show | pause | resume | cancel | archive | reopen',
  msg: 'post | list',
  worktree: 'register | adopt | list | prune',
  graph: 'show | validate',
  memory: 'update | candidates | promote',
  review: 'claim | approve | request-changes | block',
  integrate: 'start | record',
  adapter: 'install',
  agent: 'register | list',
  context: 'hydrate',
  evidence: 'show',
  backup: 'list',
  audit: 'run',
  verify: 'submit',
};

export interface CliResult {
  exitCode: number;
  stdout: string;
}

interface TimelineEvent { seq: number; ts: string | null; event: string; actor: { id: string }; task_id: string | null; claim_id: string | null; }

/** Compact ledger timeline for human mode; --json carries the full events (incl. payload). */
function renderTimeline(events: TimelineEvent[]): string[] {
  // MM-DD HH:MM:SS — a run can span days, and a bare clock time misreads across midnight.
  const hhmmss = (ts: string | null): string => {
    const m = ts && /(\d\d)-(\d\d)T(\d\d:\d\d:\d\d)/.exec(ts);
    return m ? `${m[1]}-${m[2]} ${m[3]}` : '??-?? --:--:--';
  };
  const seqW = Math.max(3, ...events.map((e) => String(e.seq).length));
  const evW = Math.min(22, Math.max(5, ...events.map((e) => e.event.length)));
  const out: string[] = [];
  for (const e of events) {
    const targetCol = [e.task_id, e.claim_id].filter(Boolean).join(' ');
    out.push(
      `  ${String(e.seq).padStart(seqW)}  ${hhmmss(e.ts)}  ${e.event.padEnd(evW)}  ${(e.actor?.id ?? '').padEnd(20)}  ${targetCol}`.trimEnd(),
    );
  }
  return out;
}

/**
 * Human-mode sections (remediation C3). The machine face (--json) is the contract; the human
 * face used to be one summary line for everything — `msg list` did not even show message
 * bodies, so "troubleshoot by calling the CLI directly" (docs/00 §1) meant --json + jq. Each
 * renderer keys off a data shape, so any command carrying that shape gets the section for free.
 */
function renderSections(data: Record<string, unknown> | undefined, lines: string[]): void {
  if (!data) return;
  const checks = data.checks as DoctorCheck[] | undefined;
  if (Array.isArray(checks)) for (const c of checks) lines.push(`  [${c.status}] ${c.name} — ${c.detail}`);
  const events = data.events as TimelineEvent[] | undefined;
  if (Array.isArray(events)) lines.push(...renderTimeline(events));

  const tasks = data.tasks as Array<{ task_id: string; title?: string; status: string; owner_agent_id?: string | null; depends_on?: string[] }> | undefined;
  if (Array.isArray(tasks) && tasks.length > 0 && tasks[0]?.task_id) {
    const stW = Math.max(...tasks.map((t) => t.status.length));
    for (const t of tasks) {
      const deps = t.depends_on?.length ? `  deps: ${t.depends_on.join(',')}` : '';
      lines.push(`  ${t.task_id}  ${t.status.padEnd(stW)}  ${(t.owner_agent_id ?? '-').padEnd(22)} ${t.title ?? ''}${deps}`.trimEnd());
    }
  }

  const messages = data.messages as Array<{ message_id: string; type: string; from_agent_id: string; task_id?: string | null; status?: string; body: string; in_reply_to?: string }> | undefined;
  if (Array.isArray(messages)) {
    for (const m of messages) {
      const target = m.task_id ? ` ${m.task_id}` : '';
      const reply = m.in_reply_to ? ` re:${m.in_reply_to}` : '';
      lines.push(`  ${m.message_id} [${m.type}${m.status === 'open' ? ', open' : ''}] ${m.from_agent_id}${target}${reply}: ${m.body}`);
    }
  }

  const agents = data.agents as Array<{ agent_id: string; label?: string | null; role?: string; current_task?: string | null; gate_kind?: string | null; last_heartbeat_min?: number; stale?: boolean }> | undefined;
  if (Array.isArray(agents)) {
    for (const a of agents) {
      const work = a.current_task ? `${a.gate_kind ? `${a.gate_kind} on ` : ''}${a.current_task}` : 'idle';
      lines.push(`  ${a.agent_id}${a.label ? ` (${a.label})` : ''}  ${a.role ?? ''}  ${work}  hb ${a.last_heartbeat_min}m${a.stale ? '  STALE' : ''}`);
    }
  }

  const needs = data.needs_user as Array<{ kind: string; detail: string; command: string }> | undefined;
  if (Array.isArray(needs) && needs.length > 0) {
    lines.push('  needs you:');
    for (const n of needs) {
      lines.push(`    [${n.kind}] ${n.detail}`);
      lines.push(`      -> ${n.command}`);
    }
  }
  const risks = data.risks as Array<Record<string, unknown> & { kind: string }> | undefined;
  if (Array.isArray(risks)) {
    for (const r of risks) {
      const rest = Object.entries(r).filter(([k]) => k !== 'kind').map(([k, v]) => `${k}=${String(v)}`).join(' ');
      lines.push(`  risk [${r.kind}] ${rest}`);
    }
  }

  const findings = data.findings as Array<{ rule_id: string; severity: string; message: string; next_action: string }> | undefined;
  if (Array.isArray(findings)) {
    for (const f of findings) {
      lines.push(`  [${f.severity}] ${f.rule_id} ${f.message}`);
      lines.push(`      -> ${f.next_action}`);
    }
  }

  // task show / evidence show detail blocks (small key-value summaries)
  const task = data.task as { task_id?: string; status?: string; objective?: string; acceptance?: string[]; depends_on?: string[] } | undefined;
  if (task?.task_id) {
    if (task.objective) lines.push(`  objective: ${task.objective}`);
    for (const a of task.acceptance ?? []) lines.push(`  accept: ${a}`);
    if (task.depends_on?.length) lines.push(`  deps: ${task.depends_on.join(', ')}`);
  }
}

function render(env: Envelope, json: boolean): string {
  if (json) return JSON.stringify(env);
  const lines = [env.message];
  renderSections(env.data as Record<string, unknown> | undefined, lines);
  for (const w of env.warnings) lines.push(`  warning: ${w.message}`);
  for (const a of env.next_actions) lines.push(`  next: ${a}`);
  return lines.join('\n');
}

/**
 * CLI front-end: parse argv, delegate to a primitive, print the envelope, map exit code.
 * @contract docs/17 §1 command table · §2 envelope · §2.2 exit-code map · docs/20 §3 (front ends hold no business rules)
 */
const HELP_TEXT = [
  'sigmarun — repo-local multi-agent collaboration gateway (.team/)',
  '',
  'Setup:      init [--example] | doctor [--fix] | adapter install --tool=claude-code|codex|all',
  'Lightweight: run import <payload.json> --lightweight  (tasks claimable now; no review/verify/integrate) -> claim-next -> done',
  'Plan:       run import <payload.json> [--lightweight] [--force] | task publish <RUN> [--tasks=..] [--force]',
  'Runs:       run list | run show <RUN> | run pause|resume|cancel|archive|reopen <RUN> | status <RUN> | watch <RUN> [--interval=s]',
  'Observe:    events <RUN> [--task=T] [--type=<event>] [--since=<seq>] [--limit=n] — read the append-only ledger (timeline; --json for full payload)',
  'Tasks:      task add <RUN> --file=<task.json> | task list <RUN> [--status --owner --type] | task cancel <RUN> <TASK> [--reason=..] | task show <RUN> <TASK> | graph show|validate <RUN>',
  'Dispatch:   agent register <RUN> --tool=<t> [--role=r] [--label=w] | agent list <RUN> | claim-next <RUN> --agent=<A> [--role=r] [--task=T] [--dry-run]',
  '            heartbeat <RUN> <TASK> --agent=<A> | release <RUN> <TASK> --agent=<A> | reclaim <RUN> <TASK> | approve-paths <RUN> <TASK> --paths=g1,g2',
  'Worktrees:  worktree register <RUN> <TASK> --agent=<A> --path=<p> --branch=<b> | worktree adopt <RUN> <TASK> --agent=<A> | worktree list <RUN> | worktree prune <RUN> [--dry-run]',
  'Deliver:    submit <RUN> <TASK> --agent=<A> --evidence=<draft.json> | evidence show <RUN> <TASK>',
  'Done (light): done <RUN> <TASK> --agent=<A> [--note=..] — complete a claimed task directly (lightweight runs)',
  'Gates:      review claim|approve|request-changes|block <RUN> <TASK> --agent=<A> [--review=<r.json>] | resume <RUN> <TASK> --agent=<A>',
  'Blocking:   block <RUN> <TASK> --agent=<A> --msg=<MSG-ID> (freeze the lease while a blocker awaits its answer) | unblock <RUN> <TASK> --agent=<A|user>',
  '            verify submit <RUN> --agent=<A> --verify=<v.json>   (draft: {target:{kind:task|run,..},checks:[{name,cmd,exit_code,output_file,status}],gates,skip_reasons,verdict,failures_mapped})',
  'Finish:     integrate start <RUN> | integrate record <RUN> <TASK> --merge-commit=<sha> | --failed --reason=".." | report <RUN> | export <RUN> --to=<dir> [--force]',
  'Context:    msg post <RUN> --from=<A|user> --type=<t> --body=".." [--task=T] [--reply-to=MSG] | msg list <RUN> [--open] [--type=t]',
  '            context hydrate <RUN> <TASK> --agent=<A> | memory update <RUN> --file=<md> | memory candidates <RUN> | memory promote <RUN> --entry=".." --section=<S> --from=<refs>',
  'Health:     audit run <RUN> | repair <RUN> | migrate [<RUN>] [--dry-run] — schema upgrade (auto on read; this rewrites + backs up)',
  'Recover:    backup list | restore <backup-id> [--dry-run] — roll back a repair/migrate; restore is itself reversible',
  '',
  'Every command accepts --json (single-envelope machine face) and --verbose (step trace to stderr). Exit codes: docs/17 §2.2.',
].join('\n');

export function runCli(argv: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; onTick?: (line: string) => void } = {}): CliResult {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    return { exitCode: 0, stdout: HELP_TEXT };
  }
  if (argv.includes('--version') || argv.includes('-v') || argv[0] === 'version') {
    return { exitCode: 0, stdout: GATEWAY_VERSION };
  }
  setVerbose(argv.includes('--verbose'));
  const json = argv.includes('--json');
  const force = argv.includes('--force');
  const args = argv.filter((a) => !a.startsWith('--'));
  const cmd = args[0];
  // Bare invocation is a request for orientation, not an error.
  if (!cmd) return { exitCode: 0, stdout: HELP_TEXT };
  // docs/16 §2: --team-root flag outranks TEAM_ROOT env and git discovery.
  const base = { cwd: opts.cwd, env: opts.env, teamRootFlag: flag(argv, 'team-root') };
  // `--agent X` (space) used to silently drop the value and read as a missing flag; name the fix.
  const bareValueFlag = argv.find((a) => /^--[a-z][a-z-]*$/.test(a) && VALUE_FLAGS.has(a.slice(2)));
  if (bareValueFlag) {
    const bad = failEnvelope(
      'usage_error',
      `${bareValueFlag} takes a value: write ${bareValueFlag}=<value> — flags use "=", not a space.`,
    );
    return { exitCode: EXIT_BY_CODE[bad.code] ?? 1, stdout: render(bad, json) };
  }
  let env: Envelope;
  if (cmd === 'init') {
    env = initProject({ ...base, example: argv.includes('--example') });
  } else if (cmd === 'doctor') {
    env = doctorProject({ ...base, fix: argv.includes('--fix') });
  } else if (cmd === 'task' && args[1] === 'publish') {
    const runId = args[2];
    if (!runId) {
      env = failEnvelope('usage_error', 'Usage: sigmarun task publish <RUN-ID> [--tasks=TASK-0001,...] [--force] [--json]');
    } else {
      const tasksFlag = argv.find((a) => a.startsWith('--tasks='));
      const taskIds = tasksFlag ? tasksFlag.slice('--tasks='.length).split(',').filter(Boolean) : undefined;
      env = publishTasks({ ...base, runId, taskIds, force });
    }
  } else if (cmd === 'run' && args[1] === 'import') {
    const file = args[2];
    if (!file) {
      env = failEnvelope('usage_error', 'Usage: sigmarun run import <payload.json> [--lightweight] [--force] [--json]');
    } else {
      try {
        const payload = readJsonFileBom(file);
        env = importRun({ ...base, payload, force, lightweight: argv.includes('--lightweight') });
      } catch (e) {
        env = failEnvelope('schema_invalid', `Payload file is not valid JSON: ${String(e)}`);
      }
    }
  } else if (cmd === 'agent' && args[1] === 'list') {
    const runId = args[2];
    env = !runId
      ? failEnvelope('usage_error', 'Usage: sigmarun agent list <RUN-ID> [--json]')
      : agentList({ ...base, runId });
  } else if (cmd === 'agent' && args[1] === 'register') {
    const runId = args[2];
    const tool = flag(argv, 'tool');
    if (!runId || !tool) {
      env = failEnvelope('usage_error', 'Usage: sigmarun agent register <RUN-ID> --tool=<tool> [--role=<role>] [--label=<window>] [--json]');
    } else {
      env = registerAgent({ ...base, runId, tool, role: flag(argv, 'role'), label: flag(argv, 'label') });
    }
  } else if (cmd === 'claim-next') {
    const runId = args[1];
    const agentId = flag(argv, 'agent');
    if (!runId || !agentId) {
      env = failEnvelope('usage_error', 'Usage: sigmarun claim-next <RUN-ID> --agent=<AGENT-ID> [--role=<role>] [--task=<TASK-ID>] [--dry-run] [--json]');
    } else {
      env = claimNext({
        ...base,
        runId,
        agentId,
        role: flag(argv, 'role'),
        taskId: flag(argv, 'task'),
        dryRun: argv.includes('--dry-run'),
      });
    }
  } else if (cmd === 'heartbeat' || cmd === 'release') {
    const runId = args[1];
    const taskId = args[2];
    const agentId = flag(argv, 'agent');
    if (!runId || !taskId || !agentId) {
      env = failEnvelope('usage_error', `Usage: sigmarun ${cmd} <RUN-ID> <TASK-ID> --agent=<AGENT-ID> [--json]`);
    } else if (cmd === 'heartbeat') {
      env = heartbeat({ ...base, runId, taskId, agentId });
    } else {
      env = releaseTask({ ...base, runId, taskId, agentId, reason: flag(argv, 'reason') });
    }
  } else if (cmd === 'reclaim') {
    const runId = args[1];
    const taskId = args[2];
    if (!runId || !taskId) {
      env = failEnvelope('usage_error', 'Usage: sigmarun reclaim <RUN-ID> <TASK-ID> [--force --agent=user] [--json]');
    } else {
      env = reclaimTask({ ...base, runId, taskId, force, agentId: flag(argv, 'agent') });
    }
  } else if (cmd === 'status' || cmd === 'progress') {
    const runId = args[1];
    env = !runId
      ? failEnvelope('usage_error', 'Usage: sigmarun status <RUN-ID> [--json]')
      : statusRun({ ...base, runId });
  } else if (cmd === 'events') {
    const runId = args[1];
    if (!runId) {
      env = failEnvelope('usage_error', 'Usage: sigmarun events <RUN-ID> [--task=<TASK-ID>] [--type=<event>] [--since=<seq>] [--limit=<n>] [--json]');
    } else {
      const sinceRaw = flag(argv, 'since');
      const limitRaw = flag(argv, 'limit');
      const since = sinceRaw !== undefined ? Number(sinceRaw) : undefined;
      const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
      if ((sinceRaw !== undefined && !Number.isFinite(since)) || (limitRaw !== undefined && !Number.isFinite(limit))) {
        env = failEnvelope('usage_error', '--since and --limit must be numbers (--limit=0 shows all).');
      } else {
        env = readEvents({
          ...base, runId,
          task: flag(argv, 'task'), type: flag(argv, 'type'),
          since, limit,
        });
      }
    }
  } else if (cmd === 'run' && args[1] === 'list') {
    env = runList({ ...base });
  } else if (cmd === 'task' && args[1] === 'list') {
    const runId = args[2];
    env = !runId
      ? failEnvelope('usage_error', 'Usage: sigmarun task list <RUN-ID> [--status=<s>] [--owner=<AGENT-ID>] [--type=<t>] [--json]')
      : taskList({ ...base, runId, status: flag(argv, 'status'), owner: flag(argv, 'owner'), type: flag(argv, 'type') });
  } else if (cmd === 'task' && args[1] === 'show') {
    const runId = args[2];
    const taskId = args[3];
    env = !runId || !taskId
      ? failEnvelope('usage_error', 'Usage: sigmarun task show <RUN-ID> <TASK-ID> [--json]')
      : taskShow({ ...base, runId, taskId });
  } else if (cmd === 'evidence' && args[1] === 'show') {
    const runId = args[2];
    const taskId = args[3];
    env = !runId || !taskId
      ? failEnvelope('usage_error', 'Usage: sigmarun evidence show <RUN-ID> <TASK-ID> [--json]')
      : evidenceShow({ ...base, runId, taskId });
  } else if (cmd === 'watch') {
    const runId = args[1];
    if (!runId) {
      env = failEnvelope('usage_error', 'Usage: sigmarun watch <RUN-ID> [--interval=30] [--once] [--force] [--json]');
    } else if (argv.includes('--once')) {
      env = watchOnce({ ...base, runId, force: argv.includes('--force') });
    } else {
      // looped mode: synchronous ticks until the run is terminal (D14 passive CLI — no daemon)
      const intervalSec = Number(flag(argv, 'interval') ?? 30);
      if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
        // NaN would coerce Atomics.wait's timeout to +Infinity and hang forever (review finding #10)
        env = failEnvelope('usage_error', `--interval must be a positive number of seconds, got "${flag(argv, 'interval')}".`);
      } else {
        // C4: stream one line per tick (NDJSON envelope under --json) — the loop used to swallow
        // every intermediate envelope and print only the terminal one: for a long run, silence.
        const emit = opts.onTick ?? ((line: string) => process.stdout.write(line + '\n'));
        const tickLine = (e: Envelope): string => {
          if (json) return JSON.stringify(e);
          const d = e.data as { swept?: unknown[]; progress?: { progress_pct?: number; needs_user?: unknown[] }; terminal?: boolean; run_status?: string };
          const stamp = new Date().toISOString().slice(11, 19);
          if (d.terminal) return `${stamp}  ${e.message}`;
          return `${stamp}  tick: ${(d.swept ?? []).length} reclaimed, progress ${d.progress?.progress_pct ?? '?'}%, ${(d.progress?.needs_user ?? []).length} need(s) you`;
        };
        // Hold the single-instance lock for the WHOLE loop: the first tick keeps it (holdLock), and
        // later ticks use force:true to skip re-locking. Previously the first tick released the lock
        // immediately and every later tick skipped it, so two `watch` processes could run at once and
        // the "already held" error never fired. On exit the lock lingers until the 60s stale takeover
        // self-heals it — same as a kill -9'd watcher.
        const forced = argv.includes('--force');
        env = watchOnce({ ...base, runId, force: forced, holdLock: !forced });
        emit(tickLine(env));
        while (env.ok && !(env.data as { terminal?: boolean }).terminal) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(5, intervalSec) * 1000);
          env = watchOnce({ ...base, runId, force: true });
          emit(tickLine(env));
        }
      }
    }
  } else if (cmd === 'audit' && args[1] === 'run') {
    const runId = args[2];
    env = !runId
      ? failEnvelope('usage_error', 'Usage: sigmarun audit run <RUN-ID> [--json]')
      : auditRun({ ...base, runId });
  } else if (cmd === 'repair') {
    const runId = args[1];
    env = !runId
      ? failEnvelope('usage_error', 'Usage: sigmarun repair <RUN-ID> [--json]')
      : repairRun({ ...base, runId });
  } else if (cmd === 'migrate') {
    env = migrateState({ ...base, runId: args[1], dryRun: argv.includes('--dry-run') });
  } else if (cmd === 'backup' && args[1] === 'list') {
    env = backupList({ ...base });
  } else if (cmd === 'restore') {
    const backupId = args[1];
    env = !backupId
      ? failEnvelope('usage_error', 'Usage: sigmarun restore <backup-id> [--dry-run] [--json] (list ids: sigmarun backup list)')
      : restoreBackup({ ...base, backupId, dryRun: argv.includes('--dry-run') });
  } else if (cmd === 'run' && ['pause', 'resume', 'cancel', 'archive', 'reopen'].includes(args[1] ?? '')) {
    const runId = args[2];
    if (!runId) {
      env = failEnvelope('usage_error', `Usage: sigmarun run ${args[1]} <RUN-ID> [--json]`);
    } else {
      const op = { pause: runPause, resume: runResume, cancel: runCancel, archive: runArchive, reopen: runReopen }[
        args[1] as 'pause' | 'resume' | 'cancel' | 'archive' | 'reopen'
      ];
      env = op({ ...base, runId });
    }
  } else if (cmd === 'task' && args[1] === 'add') {
    const runId = args[2];
    const file = flag(argv, 'file');
    if (!runId || !file) {
      env = failEnvelope('usage_error', 'Usage: sigmarun task add <RUN-ID> --file=<task.json> [--json]');
    } else {
      try {
        env = taskAdd({ ...base, runId, task: readJsonFileBom(file) as Record<string, unknown> });
      } catch (e) {
        env = failEnvelope('schema_invalid', `Task file is not valid JSON: ${String(e)}`);
      }
    }
  } else if (cmd === 'task' && args[1] === 'cancel') {
    const runId = args[2];
    const taskId = args[3];
    env = !runId || !taskId
      ? failEnvelope('usage_error', 'Usage: sigmarun task cancel <RUN-ID> <TASK-ID> [--reason=..] [--json]')
      : taskCancel({ ...base, runId, taskId, reason: flag(argv, 'reason') });
  } else if (cmd === 'done') {
    const runId = args[1];
    const taskId = args[2];
    const agentId = flag(argv, 'agent');
    env = !runId || !taskId || !agentId
      ? failEnvelope('usage_error', 'Usage: sigmarun done <RUN-ID> <TASK-ID> --agent=<AGENT-ID> [--note=...] [--json]')
      : taskDone({ ...base, runId, taskId, agentId, note: flag(argv, 'note') });
  } else if (cmd === 'worktree' && args[1] === 'list') {
    const runId = args[2];
    env = !runId
      ? failEnvelope('usage_error', 'Usage: sigmarun worktree list <RUN-ID> [--json]')
      : listWorktrees({ ...base, runId });
  } else if (cmd === 'worktree' && args[1] === 'prune') {
    const runId = args[2];
    env = !runId
      ? failEnvelope('usage_error', 'Usage: sigmarun worktree prune <RUN-ID> [--dry-run] [--json]')
      : pruneWorktrees({ ...base, runId, dryRun: argv.includes('--dry-run') });
  } else if (cmd === 'graph' && args[1] === 'show') {
    const runId = args[2];
    env = !runId
      ? failEnvelope('usage_error', 'Usage: sigmarun graph show <RUN-ID> [--json]')
      : showGraph({ ...base, runId });
  } else if (cmd === 'run' && args[1] === 'show') {
    const runId = args[2];
    if (!runId) {
      env = failEnvelope('usage_error', 'Usage: sigmarun run show <RUN-ID> [--json]');
    } else {
      env = runShow({ ...base, runId });
    }
  } else if (cmd === 'worktree' && (args[1] === 'register' || args[1] === 'adopt')) {
    const runId = args[2];
    const taskId = args[3];
    const agentId = flag(argv, 'agent');
    if (!runId || !taskId || !agentId) {
      env = failEnvelope('usage_error', `Usage: sigmarun worktree ${args[1]} <RUN-ID> <TASK-ID> --agent=<AGENT-ID>${args[1] === 'register' ? ' --path=<dir> --branch=<team/RUN/TASK-slug>' : ''} [--json]`);
    } else if (args[1] === 'register') {
      const path = flag(argv, 'path');
      const branch = flag(argv, 'branch');
      env = !path || !branch
        ? failEnvelope('usage_error', 'worktree register needs both --path and --branch.')
        : registerWorktree({ ...base, runId, taskId, agentId, path, branch });
    } else {
      env = adoptWorktree({ ...base, runId, taskId, agentId });
    }
  } else if (cmd === 'verify' && args[1] === 'submit') {
    const runId = args[2];
    const agentId = flag(argv, 'agent');
    const verifyFile = flag(argv, 'verify');
    env = !runId || !agentId || !verifyFile
      ? failEnvelope('usage_error', 'Usage: sigmarun verify submit <RUN-ID> --agent=<AGENT-ID> --verify=<verify.json> [--json]')
      : verifySubmit({ ...base, runId, agentId, verifyPath: verifyFile });
  } else if (cmd === 'integrate' && (args[1] === 'start' || args[1] === 'record')) {
    const runId = args[2];
    if (!runId) {
      env = failEnvelope('usage_error', `Usage: sigmarun integrate ${args[1]} <RUN-ID>${args[1] === 'record' ? ' <TASK-ID> --merge-commit=<sha> | --failed --reason=...' : ''} [--json]`);
    } else if (args[1] === 'start') {
      env = integrateStart({ ...base, runId });
    } else {
      const taskId = args[3];
      env = !taskId
        ? failEnvelope('usage_error', 'integrate record needs a TASK-ID.')
        : integrateRecord({
            ...base, runId, taskId,
            mergeCommit: flag(argv, 'merge-commit'),
            failed: argv.includes('--failed'),
            reason: flag(argv, 'reason'),
          });
    }
  } else if (cmd === 'report') {
    const runId = args[1];
    env = !runId
      ? failEnvelope('usage_error', 'Usage: sigmarun report <RUN-ID> [--json]')
      : reportRun({ ...base, runId });
  } else if (cmd === 'export') {
    const runId = args[1];
    env = !runId
      ? failEnvelope('usage_error', 'Usage: sigmarun export <RUN-ID> [--to=<dir>] [--full] [--force] [--json]')
      : exportRun({ ...base, runId, to: flag(argv, 'to'), full: argv.includes('--full'), force });
  } else if (cmd === 'review' && (args[1] === 'claim' || args[1] === 'approve' || args[1] === 'request-changes' || args[1] === 'block')) {
    const runId = args[2];
    const taskId = args[3];
    const agentId = flag(argv, 'agent');
    if (!runId || !taskId || !agentId) {
      env = failEnvelope('usage_error', `Usage: sigmarun review ${args[1]} <RUN-ID> <TASK-ID> --agent=<AGENT-ID>${args[1] === 'claim' ? '' : ' --review=<review.json>'} [--json]`);
    } else if (args[1] === 'claim') {
      env = reviewClaim({ ...base, runId, taskId, agentId });
    } else {
      const reviewFile = flag(argv, 'review');
      if (!reviewFile) {
        env = failEnvelope('usage_error', 'review approve/request-changes needs --review=<review.json>.');
      } else {
        try {
          const review = readJsonFileBom(reviewFile);
          const decision = args[1] === 'approve' ? 'approve' : args[1] === 'block' ? 'block' : 'request_changes';
          env = reviewDecide({ ...base, runId, taskId, agentId, decision, review: review as Parameters<typeof reviewDecide>[0]['review'] });
        } catch (e) {
          env = failEnvelope('schema_invalid', `Review file is not valid JSON: ${String(e)}`);
        }
      }
    }
  } else if (cmd === 'block') {
    const runId = args[1];
    const taskId = args[2];
    const agentId = flag(argv, 'agent');
    const msgId = flag(argv, 'msg');
    env = !runId || !taskId || !agentId || !msgId
      ? failEnvelope('usage_error', 'Usage: sigmarun block <RUN-ID> <TASK-ID> --agent=<AGENT-ID> --msg=<MSG-ID> (post the blocker first via msg post --type=blocker)')
      : blockTask({ ...base, runId, taskId, agentId, msgId });
  } else if (cmd === 'resume' || cmd === 'unblock') {
    const runId = args[1];
    const taskId = args[2];
    const agentId = flag(argv, 'agent');
    if (!runId || !taskId || !agentId) {
      env = failEnvelope('usage_error', `Usage: sigmarun ${cmd} <RUN-ID> <TASK-ID> --agent=<AGENT-ID> [--json]`);
    } else if (cmd === 'resume') {
      env = resumeTask({ ...base, runId, taskId, agentId });
    } else {
      env = unblockTask({ ...base, runId, taskId, agentId, reason: flag(argv, 'reason') });
    }
  } else if (cmd === 'submit') {
    const runId = args[1];
    const taskId = args[2];
    const agentId = flag(argv, 'agent');
    const evidence = flag(argv, 'evidence');
    if (!runId || !taskId || !agentId || !evidence) {
      env = failEnvelope('usage_error', 'Usage: sigmarun submit <RUN-ID> <TASK-ID> --agent=<AGENT-ID> --evidence=<draft.json> [--json]');
    } else {
      env = submitEvidence({ ...base, runId, taskId, agentId, evidencePath: evidence });
    }
  } else if (cmd === 'adapter' && args[1] === 'install') {
    const tool = flag(argv, 'tool');
    if (!tool) {
      env = failEnvelope('usage_error', 'Usage: sigmarun adapter install --tool=claude-code|codex|all (comma-separate for several) [--update] [--json]');
    } else {
      env = installAdapters({ ...base, tool, update: argv.includes('--update') });
    }
  } else if (cmd === 'msg' && args[1] === 'post') {
    const runId = args[2];
    const from = flag(argv, 'from');
    const type = flag(argv, 'type');
    const body = flag(argv, 'body');
    if (!runId || !from || !type || !body) {
      env = failEnvelope('usage_error', 'Usage: sigmarun msg post <RUN-ID> --from=<AGENT-ID> --type=<type> --body=<text> [--task=<TASK-ID>] [--to=<route>] [--reply-to=<MSG-ID>] [--refs=a,b] [--json]');
    } else {
      env = postMessage({
        ...base, runId, fromAgentId: from, type, body,
        taskId: flag(argv, 'task'), to: flag(argv, 'to'), inReplyTo: flag(argv, 'reply-to'),
        refs: flag(argv, 'refs')?.split(',').filter(Boolean),
      });
    }
  } else if (cmd === 'msg' && args[1] === 'list') {
    const runId = args[2];
    if (!runId) {
      env = failEnvelope('usage_error', 'Usage: sigmarun msg list <RUN-ID> [--task=<TASK-ID>] [--type=<type>] [--open] [--json]');
    } else {
      env = listMessages({ ...base, runId, taskId: flag(argv, 'task'), type: flag(argv, 'type'), open: argv.includes('--open') });
    }
  } else if (cmd === 'context' && args[1] === 'hydrate') {
    const runId = args[2];
    const taskId = args[3];
    if (!runId || !taskId) {
      env = failEnvelope('usage_error', 'Usage: sigmarun context hydrate <RUN-ID> <TASK-ID> [--agent=<AGENT-ID>] [--json]');
    } else {
      env = hydrateContext({ ...base, runId, taskId, agentId: flag(argv, 'agent') });
    }
  } else if (cmd === 'graph' && args[1] === 'validate') {
    const runId = args[2];
    if (!runId) {
      env = failEnvelope('usage_error', 'Usage: sigmarun graph validate <RUN-ID> [--json]');
    } else {
      env = validateGraph({ ...base, runId });
    }
  } else if (cmd === 'memory' && args[1] === 'promote') {
    const runId = args[2];
    const entry = flag(argv, 'entry');
    const section = flag(argv, 'section');
    const refs = flag(argv, 'from')?.split(',').filter(Boolean);
    if (!runId || !entry || !section || !refs || refs.length === 0) {
      env = failEnvelope('usage_error', 'Usage: sigmarun memory promote <RUN-ID> --entry="…" --section=Architecture|Interfaces|Constraints|Pitfalls --from=<MSG-ID|path,...> [--supersedes=MEM-xxxx] [--json]');
    } else {
      env = promoteMemory({ ...base, runId, entry, section, refs, supersedes: flag(argv, 'supersedes') });
    }
  } else if (cmd === 'memory' && args[1] === 'candidates') {
    const runId = args[2];
    env = !runId
      ? failEnvelope('usage_error', 'Usage: sigmarun memory candidates <RUN-ID> [--json]')
      : memoryCandidates({ ...base, runId });
  } else if (cmd === 'memory' && args[1] === 'update') {
    const runId = args[2];
    const file = flag(argv, 'file');
    if (!runId || !file) {
      env = failEnvelope('usage_error', 'Usage: sigmarun memory update <RUN-ID> --file=<memory.md> [--json]');
    } else {
      try {
        env = updateRunMemory({ ...base, runId, content: readFileSync(file, 'utf8') });
      } catch (e) {
        env = failEnvelope('io_error', `Cannot read memory file: ${String(e)}`);
      }
    }
  } else if (cmd === 'approve-paths') {
    const runId = args[1];
    const taskId = args[2];
    const paths = flag(argv, 'paths')?.split(',').filter(Boolean);
    if (!runId || !taskId || !paths || paths.length === 0) {
      env = failEnvelope('usage_error', 'Usage: sigmarun approve-paths <RUN-ID> <TASK-ID> --paths=<glob,...> [--json]');
    } else {
      env = approvePaths({ ...base, runId, taskId, paths });
    }
  } else if (GROUP_SUBCOMMANDS[cmd]) {
    env = failEnvelope('usage_error', `Unknown subcommand: "sigmarun ${[cmd, args[1]].filter(Boolean).join(' ')}".`, {
      nextActions: [`${cmd} subcommands: ${GROUP_SUBCOMMANDS[cmd]}`, 'See all commands: sigmarun help'],
    });
  } else {
    env = failEnvelope('usage_error', `Unknown command: ${cmd}`, {
      nextActions: ['See all commands: sigmarun help'],
    });
  }
  return { exitCode: EXIT_BY_CODE[env.code] ?? 1, stdout: render(env, json) };
}
