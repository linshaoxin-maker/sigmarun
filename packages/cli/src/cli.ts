import { readFileSync } from 'node:fs';
import { initProject, doctorProject, importRun, publishTasks, runShow, readEvents, submitEvidence, integrateStart, integrateRecord, reportRun, exportRun, runPause, runResume, runCancel, runArchive, taskAdd, taskCancel, failEnvelope, type Envelope, type DoctorCheck, GATEWAY_VERSION } from '@sigmarun/core';
import { registerAgent, claimNext, heartbeat, releaseTask, reclaimTask, approvePaths, registerWorktree, adoptWorktree, reviewClaim, reviewDecide, resumeTask, unblockTask, verifySubmit, listWorktrees } from '@sigmarun/dispatch';
import { postMessage, listMessages, hydrateContext, validateGraph, showGraph, updateRunMemory, promoteMemory, memoryCandidates } from '@sigmarun/context';
import { installAdapters } from '@sigmarun/adapters';
import { statusRun, runList, taskShow, evidenceShow, watchOnce } from '@sigmarun/watch';
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
  task_not_found: 5,
  agent_not_registered: 5,
  claim_not_found: 5,
  run_not_active: 7,
  run_paused: 7,
  invalid_transition: 7,
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

export interface CliResult {
  exitCode: number;
  stdout: string;
}

interface TimelineEvent { seq: number; ts: string | null; event: string; actor: { id: string }; task_id: string | null; claim_id: string | null; }

/** Compact ledger timeline for human mode; --json carries the full events (incl. payload). */
function renderTimeline(events: TimelineEvent[]): string[] {
  const hhmmss = (ts: string | null): string => (ts && /\dT(\d\d:\d\d:\d\d)/.exec(ts)?.[1]) || '--:--:--';
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

function render(env: Envelope, json: boolean): string {
  if (json) return JSON.stringify(env);
  const lines = [env.message];
  const checks = (env.data as { checks?: DoctorCheck[] } | undefined)?.checks;
  if (checks) for (const c of checks) lines.push(`  [${c.status}] ${c.name} — ${c.detail}`);
  const events = (env.data as { events?: TimelineEvent[] } | undefined)?.events;
  if (events && Array.isArray(events)) lines.push(...renderTimeline(events));
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
  'Setup:      init | doctor [--fix] | adapter install --tool=claude-code|codex',
  'Plan:       run import <payload.json> [--force] | task publish <RUN> [--tasks=..] [--force]',
  'Runs:       run list | run show <RUN> | run pause|resume|cancel|archive <RUN> | status <RUN> | watch <RUN> [--interval=s]',
  'Observe:    events <RUN> [--task=T] [--type=<event>] [--since=<seq>] [--limit=n] — read the append-only ledger (timeline; --json for full payload)',
  'Tasks:      task add <RUN> --file=<task.json> | task cancel <RUN> <TASK> [--reason=..] | task show <RUN> <TASK> | graph show|validate <RUN>',
  'Dispatch:   agent register <RUN> --tool=<t> [--role=r] [--label=w] | claim-next <RUN> --agent=<A> [--role=r] [--task=T] [--dry-run]',
  '            heartbeat <RUN> <TASK> --agent=<A> | release <RUN> <TASK> --agent=<A> | reclaim <RUN> <TASK> | approve-paths <RUN> <TASK> --paths=g1,g2',
  'Worktrees:  worktree register <RUN> <TASK> --agent=<A> --path=<p> --branch=<b> | worktree adopt <RUN> <TASK> --agent=<A> | worktree list <RUN>',
  'Deliver:    submit <RUN> <TASK> --agent=<A> --evidence=<draft.json> | evidence show <RUN> <TASK>',
  'Gates:      review claim|approve|request-changes|block <RUN> <TASK> --agent=<A> [--review=<r.json>] | resume <RUN> <TASK> --agent=<A> | unblock <RUN> <TASK>',
  '            verify submit <RUN> --agent=<A> --verify=<v.json>   (draft: {target:{kind:task|run,..},checks:[{name,cmd,exit_code,output_file,status}],gates,skip_reasons,verdict,failures_mapped})',
  'Finish:     integrate start <RUN> | integrate record <RUN> <TASK> --merge-commit=<sha> | --failed --reason=".." | report <RUN> | export <RUN> --to=<dir> [--force]',
  'Context:    msg post <RUN> --from=<A|user> --type=<t> --body=".." [--task=T] [--reply-to=MSG] | msg list <RUN> [--open] [--type=t]',
  '            context hydrate <RUN> <TASK> --agent=<A> | memory update <RUN> --file=<md> | memory candidates <RUN> | memory promote <RUN> --entry=".." --section=<S> --from=<refs>',
  'Health:     audit run <RUN> | repair <RUN>',
  '',
  'Every command accepts --json (single-envelope machine face, team.envelope.v1). Exit codes: docs/17 §2.2.',
].join('\n');

export function runCli(argv: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): CliResult {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    return { exitCode: 0, stdout: HELP_TEXT };
  }
  if (argv.includes('--version') || argv.includes('-v') || argv[0] === 'version') {
    return { exitCode: 0, stdout: GATEWAY_VERSION };
  }
  const json = argv.includes('--json');
  const force = argv.includes('--force');
  const args = argv.filter((a) => !a.startsWith('--'));
  const cmd = args[0];
  let env: Envelope;
  if (cmd === 'init') {
    env = initProject({ cwd: opts.cwd, env: opts.env });
  } else if (cmd === 'doctor') {
    env = doctorProject({ cwd: opts.cwd, env: opts.env, fix: argv.includes('--fix') });
  } else if (cmd === 'task' && args[1] === 'publish') {
    const runId = args[2];
    if (!runId) {
      env = failEnvelope('usage_error', 'Usage: sigmarun task publish <RUN-ID> [--tasks=TASK-0001,...] [--force] [--json]');
    } else {
      const tasksFlag = argv.find((a) => a.startsWith('--tasks='));
      const taskIds = tasksFlag ? tasksFlag.slice('--tasks='.length).split(',').filter(Boolean) : undefined;
      env = publishTasks({ cwd: opts.cwd, env: opts.env, runId, taskIds, force });
    }
  } else if (cmd === 'run' && args[1] === 'import') {
    const file = args[2];
    if (!file) {
      env = failEnvelope('usage_error', 'Usage: sigmarun run import <payload.json> [--force] [--json]');
    } else {
      try {
        const payload = readJsonFileBom(file);
        env = importRun({ cwd: opts.cwd, env: opts.env, payload, force });
      } catch (e) {
        env = failEnvelope('schema_invalid', `Payload file is not valid JSON: ${String(e)}`);
      }
    }
  } else if (cmd === 'agent' && args[1] === 'register') {
    const runId = args[2];
    const tool = flag(argv, 'tool');
    if (!runId || !tool) {
      env = failEnvelope('usage_error', 'Usage: sigmarun agent register <RUN-ID> --tool=<tool> [--role=<role>] [--label=<window>] [--json]');
    } else {
      env = registerAgent({ cwd: opts.cwd, env: opts.env, runId, tool, role: flag(argv, 'role'), label: flag(argv, 'label') });
    }
  } else if (cmd === 'claim-next') {
    const runId = args[1];
    const agentId = flag(argv, 'agent');
    if (!runId || !agentId) {
      env = failEnvelope('usage_error', 'Usage: sigmarun claim-next <RUN-ID> --agent=<AGENT-ID> [--role=<role>] [--task=<TASK-ID>] [--dry-run] [--json]');
    } else {
      env = claimNext({
        cwd: opts.cwd,
        env: opts.env,
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
      env = heartbeat({ cwd: opts.cwd, env: opts.env, runId, taskId, agentId });
    } else {
      env = releaseTask({ cwd: opts.cwd, env: opts.env, runId, taskId, agentId, reason: flag(argv, 'reason') });
    }
  } else if (cmd === 'reclaim') {
    const runId = args[1];
    const taskId = args[2];
    if (!runId || !taskId) {
      env = failEnvelope('usage_error', 'Usage: sigmarun reclaim <RUN-ID> <TASK-ID> [--json]');
    } else {
      env = reclaimTask({ cwd: opts.cwd, env: opts.env, runId, taskId });
    }
  } else if (cmd === 'status' || cmd === 'progress') {
    const runId = args[1];
    env = !runId
      ? failEnvelope('usage_error', 'Usage: sigmarun status <RUN-ID> [--json]')
      : statusRun({ cwd: opts.cwd, env: opts.env, runId });
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
          cwd: opts.cwd, env: opts.env, runId,
          task: flag(argv, 'task'), type: flag(argv, 'type'),
          since, limit,
        });
      }
    }
  } else if (cmd === 'run' && args[1] === 'list') {
    env = runList({ cwd: opts.cwd, env: opts.env });
  } else if (cmd === 'task' && args[1] === 'show') {
    const runId = args[2];
    const taskId = args[3];
    env = !runId || !taskId
      ? failEnvelope('usage_error', 'Usage: sigmarun task show <RUN-ID> <TASK-ID> [--json]')
      : taskShow({ cwd: opts.cwd, env: opts.env, runId, taskId });
  } else if (cmd === 'evidence' && args[1] === 'show') {
    const runId = args[2];
    const taskId = args[3];
    env = !runId || !taskId
      ? failEnvelope('usage_error', 'Usage: sigmarun evidence show <RUN-ID> <TASK-ID> [--json]')
      : evidenceShow({ cwd: opts.cwd, env: opts.env, runId, taskId });
  } else if (cmd === 'watch') {
    const runId = args[1];
    if (!runId) {
      env = failEnvelope('usage_error', 'Usage: sigmarun watch <RUN-ID> [--interval=30] [--once] [--force] [--json]');
    } else if (argv.includes('--once')) {
      env = watchOnce({ cwd: opts.cwd, env: opts.env, runId, force: argv.includes('--force') });
    } else {
      // looped mode: synchronous ticks until the run is terminal (D14 passive CLI — no daemon)
      const intervalSec = Number(flag(argv, 'interval') ?? 30);
      if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
        // NaN would coerce Atomics.wait's timeout to +Infinity and hang forever (review finding #10)
        env = failEnvelope('usage_error', `--interval must be a positive number of seconds, got "${flag(argv, 'interval')}".`);
      } else {
        env = watchOnce({ cwd: opts.cwd, env: opts.env, runId, force: argv.includes('--force') });
        while (env.ok && !(env.data as { terminal?: boolean }).terminal) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(5, intervalSec) * 1000);
          env = watchOnce({ cwd: opts.cwd, env: opts.env, runId, force: true });
        }
      }
    }
  } else if (cmd === 'audit' && args[1] === 'run') {
    const runId = args[2];
    env = !runId
      ? failEnvelope('usage_error', 'Usage: sigmarun audit run <RUN-ID> [--json]')
      : auditRun({ cwd: opts.cwd, env: opts.env, runId });
  } else if (cmd === 'repair') {
    const runId = args[1];
    env = !runId
      ? failEnvelope('usage_error', 'Usage: sigmarun repair <RUN-ID> [--json]')
      : repairRun({ cwd: opts.cwd, env: opts.env, runId });
  } else if (cmd === 'run' && ['pause', 'resume', 'cancel', 'archive'].includes(args[1] ?? '')) {
    const runId = args[2];
    if (!runId) {
      env = failEnvelope('usage_error', `Usage: sigmarun run ${args[1]} <RUN-ID> [--json]`);
    } else {
      const op = { pause: runPause, resume: runResume, cancel: runCancel, archive: runArchive }[args[1] as 'pause' | 'resume' | 'cancel' | 'archive'];
      env = op({ cwd: opts.cwd, env: opts.env, runId });
    }
  } else if (cmd === 'task' && args[1] === 'add') {
    const runId = args[2];
    const file = flag(argv, 'file');
    if (!runId || !file) {
      env = failEnvelope('usage_error', 'Usage: sigmarun task add <RUN-ID> --file=<task.json> [--json]');
    } else {
      try {
        env = taskAdd({ cwd: opts.cwd, env: opts.env, runId, task: readJsonFileBom(file) as Record<string, unknown> });
      } catch (e) {
        env = failEnvelope('schema_invalid', `Task file is not valid JSON: ${String(e)}`);
      }
    }
  } else if (cmd === 'task' && args[1] === 'cancel') {
    const runId = args[2];
    const taskId = args[3];
    env = !runId || !taskId
      ? failEnvelope('usage_error', 'Usage: sigmarun task cancel <RUN-ID> <TASK-ID> [--json]')
      : taskCancel({ cwd: opts.cwd, env: opts.env, runId, taskId });
  } else if (cmd === 'worktree' && args[1] === 'list') {
    const runId = args[2];
    env = !runId
      ? failEnvelope('usage_error', 'Usage: sigmarun worktree list <RUN-ID> [--json]')
      : listWorktrees({ cwd: opts.cwd, env: opts.env, runId });
  } else if (cmd === 'graph' && args[1] === 'show') {
    const runId = args[2];
    env = !runId
      ? failEnvelope('usage_error', 'Usage: sigmarun graph show <RUN-ID> [--json]')
      : showGraph({ cwd: opts.cwd, env: opts.env, runId });
  } else if (cmd === 'run' && args[1] === 'show') {
    const runId = args[2];
    if (!runId) {
      env = failEnvelope('usage_error', 'Usage: sigmarun run show <RUN-ID> [--json]');
    } else {
      env = runShow({ cwd: opts.cwd, env: opts.env, runId });
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
        : registerWorktree({ cwd: opts.cwd, env: opts.env, runId, taskId, agentId, path, branch });
    } else {
      env = adoptWorktree({ cwd: opts.cwd, env: opts.env, runId, taskId, agentId });
    }
  } else if (cmd === 'verify' && args[1] === 'submit') {
    const runId = args[2];
    const agentId = flag(argv, 'agent');
    const verifyFile = flag(argv, 'verify');
    env = !runId || !agentId || !verifyFile
      ? failEnvelope('usage_error', 'Usage: sigmarun verify submit <RUN-ID> --agent=<AGENT-ID> --verify=<verify.json> [--json]')
      : verifySubmit({ cwd: opts.cwd, env: opts.env, runId, agentId, verifyPath: verifyFile });
  } else if (cmd === 'integrate' && (args[1] === 'start' || args[1] === 'record')) {
    const runId = args[2];
    if (!runId) {
      env = failEnvelope('usage_error', `Usage: sigmarun integrate ${args[1]} <RUN-ID>${args[1] === 'record' ? ' <TASK-ID> --merge-commit=<sha> | --failed --reason=...' : ''} [--json]`);
    } else if (args[1] === 'start') {
      env = integrateStart({ cwd: opts.cwd, env: opts.env, runId });
    } else {
      const taskId = args[3];
      env = !taskId
        ? failEnvelope('usage_error', 'integrate record needs a TASK-ID.')
        : integrateRecord({
            cwd: opts.cwd, env: opts.env, runId, taskId,
            mergeCommit: flag(argv, 'merge-commit'),
            failed: argv.includes('--failed'),
            reason: flag(argv, 'reason'),
          });
    }
  } else if (cmd === 'report') {
    const runId = args[1];
    env = !runId
      ? failEnvelope('usage_error', 'Usage: sigmarun report <RUN-ID> [--json]')
      : reportRun({ cwd: opts.cwd, env: opts.env, runId });
  } else if (cmd === 'export') {
    const runId = args[1];
    env = !runId
      ? failEnvelope('usage_error', 'Usage: sigmarun export <RUN-ID> [--to=<dir>] [--full] [--force] [--json]')
      : exportRun({ cwd: opts.cwd, env: opts.env, runId, to: flag(argv, 'to'), full: argv.includes('--full'), force });
  } else if (cmd === 'review' && (args[1] === 'claim' || args[1] === 'approve' || args[1] === 'request-changes' || args[1] === 'block')) {
    const runId = args[2];
    const taskId = args[3];
    const agentId = flag(argv, 'agent');
    if (!runId || !taskId || !agentId) {
      env = failEnvelope('usage_error', `Usage: sigmarun review ${args[1]} <RUN-ID> <TASK-ID> --agent=<AGENT-ID>${args[1] === 'claim' ? '' : ' --review=<review.json>'} [--json]`);
    } else if (args[1] === 'claim') {
      env = reviewClaim({ cwd: opts.cwd, env: opts.env, runId, taskId, agentId });
    } else {
      const reviewFile = flag(argv, 'review');
      if (!reviewFile) {
        env = failEnvelope('usage_error', 'review approve/request-changes needs --review=<review.json>.');
      } else {
        try {
          const review = readJsonFileBom(reviewFile);
          const decision = args[1] === 'approve' ? 'approve' : args[1] === 'block' ? 'block' : 'request_changes';
          env = reviewDecide({ cwd: opts.cwd, env: opts.env, runId, taskId, agentId, decision, review: review as Parameters<typeof reviewDecide>[0]['review'] });
        } catch (e) {
          env = failEnvelope('schema_invalid', `Review file is not valid JSON: ${String(e)}`);
        }
      }
    }
  } else if (cmd === 'resume' || cmd === 'unblock') {
    const runId = args[1];
    const taskId = args[2];
    const agentId = flag(argv, 'agent');
    if (!runId || !taskId || !agentId) {
      env = failEnvelope('usage_error', `Usage: sigmarun ${cmd} <RUN-ID> <TASK-ID> --agent=<AGENT-ID> [--json]`);
    } else if (cmd === 'resume') {
      env = resumeTask({ cwd: opts.cwd, env: opts.env, runId, taskId, agentId });
    } else {
      env = unblockTask({ cwd: opts.cwd, env: opts.env, runId, taskId, agentId, reason: flag(argv, 'reason') });
    }
  } else if (cmd === 'submit') {
    const runId = args[1];
    const taskId = args[2];
    const agentId = flag(argv, 'agent');
    const evidence = flag(argv, 'evidence');
    if (!runId || !taskId || !agentId || !evidence) {
      env = failEnvelope('usage_error', 'Usage: sigmarun submit <RUN-ID> <TASK-ID> --agent=<AGENT-ID> --evidence=<draft.json> [--json]');
    } else {
      env = submitEvidence({ cwd: opts.cwd, env: opts.env, runId, taskId, agentId, evidencePath: evidence });
    }
  } else if (cmd === 'adapter' && args[1] === 'install') {
    const tool = flag(argv, 'tool');
    if (!tool) {
      env = failEnvelope('usage_error', 'Usage: sigmarun adapter install --tool=claude-code|codex [--update] [--json]');
    } else {
      env = installAdapters({ cwd: opts.cwd, env: opts.env, tool, update: argv.includes('--update') });
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
        cwd: opts.cwd, env: opts.env, runId, fromAgentId: from, type, body,
        taskId: flag(argv, 'task'), to: flag(argv, 'to'), inReplyTo: flag(argv, 'reply-to'),
        refs: flag(argv, 'refs')?.split(',').filter(Boolean),
      });
    }
  } else if (cmd === 'msg' && args[1] === 'list') {
    const runId = args[2];
    if (!runId) {
      env = failEnvelope('usage_error', 'Usage: sigmarun msg list <RUN-ID> [--task=<TASK-ID>] [--type=<type>] [--open] [--json]');
    } else {
      env = listMessages({ cwd: opts.cwd, env: opts.env, runId, taskId: flag(argv, 'task'), type: flag(argv, 'type'), open: argv.includes('--open') });
    }
  } else if (cmd === 'context' && args[1] === 'hydrate') {
    const runId = args[2];
    const taskId = args[3];
    if (!runId || !taskId) {
      env = failEnvelope('usage_error', 'Usage: sigmarun context hydrate <RUN-ID> <TASK-ID> [--agent=<AGENT-ID>] [--json]');
    } else {
      env = hydrateContext({ cwd: opts.cwd, env: opts.env, runId, taskId, agentId: flag(argv, 'agent') });
    }
  } else if (cmd === 'graph' && args[1] === 'validate') {
    const runId = args[2];
    if (!runId) {
      env = failEnvelope('usage_error', 'Usage: sigmarun graph validate <RUN-ID> [--json]');
    } else {
      env = validateGraph({ cwd: opts.cwd, env: opts.env, runId });
    }
  } else if (cmd === 'memory' && args[1] === 'promote') {
    const runId = args[2];
    const entry = flag(argv, 'entry');
    const section = flag(argv, 'section');
    const refs = flag(argv, 'from')?.split(',').filter(Boolean);
    if (!runId || !entry || !section || !refs || refs.length === 0) {
      env = failEnvelope('usage_error', 'Usage: sigmarun memory promote <RUN-ID> --entry="…" --section=Architecture|Interfaces|Constraints|Pitfalls --from=<MSG-ID|path,...> [--supersedes=MEM-xxxx] [--json]');
    } else {
      env = promoteMemory({ cwd: opts.cwd, env: opts.env, runId, entry, section, refs, supersedes: flag(argv, 'supersedes') });
    }
  } else if (cmd === 'memory' && args[1] === 'candidates') {
    const runId = args[2];
    env = !runId
      ? failEnvelope('usage_error', 'Usage: sigmarun memory candidates <RUN-ID> [--json]')
      : memoryCandidates({ cwd: opts.cwd, env: opts.env, runId });
  } else if (cmd === 'memory' && args[1] === 'update') {
    const runId = args[2];
    const file = flag(argv, 'file');
    if (!runId || !file) {
      env = failEnvelope('usage_error', 'Usage: sigmarun memory update <RUN-ID> --file=<memory.md> [--json]');
    } else {
      try {
        env = updateRunMemory({ cwd: opts.cwd, env: opts.env, runId, content: readFileSync(file, 'utf8') });
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
      env = approvePaths({ cwd: opts.cwd, env: opts.env, runId, taskId, paths });
    }
  } else {
    env = failEnvelope('usage_error', `Unknown command: ${cmd ?? '(none)'}`);
  }
  return { exitCode: EXIT_BY_CODE[env.code] ?? 1, stdout: render(env, json) };
}
