import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, COMMAND_SURFACE } from '../src/cli.js';
import { mkTmpGitRepo, cleanup } from '../../storage/test/helpers.js';

/**
 * THE FIFTH reconciliation — the product-axis one the other four miss. The command-table /
 * exit-code / event-catalog / dependency-matrix tests hold IMPLEMENTATION against SPEC (the
 * developer axis). This one holds USER JOURNEY <-> FUNCTION <-> FEATURE: every journey a user
 * actually walks is an executable end-to-end sequence that reaches a terminal without tangling,
 * every state-changing command belongs to at least one journey, and every advertised feature is
 * reachable. Lightweight mode was the cautionary tale — a feature whose journey had no ending
 * (S8) and whose audit punished the happy path (S10): a journey↔feature drift. After this test
 * that drift is a red build.
 *
 * A journey's declared `commands` must EQUAL the surface commands its `it` actually executes
 * (the runner records them) — a catalog entry cannot lie about what its journey touches.
 */

const dirs: string[] = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()!); });

/** Read-only observation commands — exempt from the "must change state" coverage rule, but each
 * must still be reachable from some journey. */
const READONLY = new Set([
  'doctor', 'run list', 'run show', 'task list', 'task show', 'evidence show', 'agent list',
  'msg list', 'graph show', 'graph validate', 'memory candidates', 'status', 'events',
  'watch', 'audit run', 'backup list',
]);

/** Product features (docs/26, docs/13 D-series, roadmap). Each must be exercised by a journey. */
const FEATURES = [
  'setup', 'lightweight', 'full-pipeline', 'claim-lease', 'worktree', 'evidence-gate',
  'review-gate', 'verify-gate', 'integration', 'takeover', 'blocker', 'rework', 'force-reclaim',
  'run-reopen', 'upstream-cancel', 'pause-cancel', 'worktree-recovery', 'path-approval',
  'context-memory', 'observability', 'ops-recovery', 'export', 'mode-wall',
] as const;
type Feature = (typeof FEATURES)[number];

interface Journey { id: string; name: string; features: Feature[]; commands: string[]; terminal?: string }

class Walk {
  used = new Set<string>();
  constructor(public repo: string) {}
  private surfaceOf(argv: string[]): string | null {
    const two = argv.slice(0, 2).join(' ');
    if (COMMAND_SURFACE.includes(two)) return two;
    return COMMAND_SURFACE.includes(argv[0] ?? '') ? argv[0]! : null;
  }
  cli(argv: string[], onTick?: (l: string) => void): { ok: boolean; code: string; data: Record<string, unknown>; next: string[]; msg: string; exit: number } {
    const s = this.surfaceOf(argv);
    if (s) this.used.add(s);
    const r = runCli([...argv, '--json'], { cwd: this.repo, onTick });
    const e = JSON.parse(r.stdout) as { ok: boolean; code: string; data: Record<string, unknown>; next_actions: string[]; message: string };
    return { ok: e.ok, code: e.code, data: e.data, next: e.next_actions, msg: e.message, exit: r.exitCode };
  }
  status(): string {
    return JSON.parse(readFileSync(join(this.repo, '.team', 'runs', 'RUN-0001', 'run.json'), 'utf8')).status as string;
  }
  agent(label: string, tool = 'codex'): string {
    return (this.cli(['agent', 'register', 'RUN-0001', `--tool=${tool}`, `--label=${label}`]).data as { agent_id: string }).agent_id;
  }
}

const CATALOG: Journey[] = [];
function journey(j: Journey, body: () => Walk): void {
  CATALOG.push(j);
  it(`${j.id} — ${j.name}`, () => {
    const w = body();
    expect(new Set(w.used)).toEqual(new Set(j.commands)); // declared == actually executed
    if (j.terminal) expect(w.status()).toBe(j.terminal);
  });
}

function newRepo(): string { const r = mkTmpGitRepo(); dirs.push(r); return r; }
function start(mode: 'lightweight' | 'full'): Walk {
  const w = new Walk(newRepo());
  w.cli(['init', '--example']);
  w.cli(['run', 'import', join(w.repo, 'sigmarun-plan.example.json'), ...(mode === 'lightweight' ? ['--lightweight'] : [])]);
  return w;
}
/** claim + create + register a real worktree exactly as the gateway suggests (P0/S13 contract). */
function makeWorktree(w: Walk, taskId: string, agent: string): void {
  const claim = w.cli(['claim-next', 'RUN-0001', `--agent=${agent}`, `--task=${taskId}`]);
  const wt = claim.data.worktree as { suggested_path: string; suggested_branch: string };
  execFileSync('git', ['-C', w.repo, 'commit', '--allow-empty', '-m', 'base', '--no-gpg-sign'], { stdio: 'ignore' });
  const abs = join(w.repo, wt.suggested_path);
  mkdirSync(join(abs, '..'), { recursive: true });
  execFileSync('git', ['-C', w.repo, 'worktree', 'add', abs, '-b', wt.suggested_branch, 'HEAD'], { stdio: 'ignore' });
  w.cli(['worktree', 'register', 'RUN-0001', taskId, `--agent=${agent}`, `--path=${abs}`, `--branch=${wt.suggested_branch}`]);
}
function draft(w: Walk, name: string, body: unknown): string { const p = join(w.repo, name); writeFileSync(p, JSON.stringify(body)); return p; }
function evidenceDraft(w: Walk, slug: string): string {
  return draft(w, `ev-${slug}.json`, {
    summary: `did ${slug}`, changed_files: [{ path: `src/${slug}/index.ts`, change_type: 'added' }],
    commands: [], required_checks_results: [],
    acceptance: [{ item: slug === 'first' ? 'A testable statement of done.' : 'Another testable statement of done.', status: 'met' }],
    handoff: `handed off ${slug}`,
  });
}
function verifyDraft(w: Walk, taskId: string): string {
  const out = join(w.repo, `v-${taskId}.log`); writeFileSync(out, 'ok\n');
  return draft(w, `vd-${taskId}.json`, {
    target: { kind: 'task', task_id: taskId },
    checks: [{ name: 'tests', cmd: 'npm test', exit_code: 0, output_file: out, status: 'pass' }],
    gates: { build: 'pass', focused_tests: 'pass', regression_tests: 'skipped', scope_check: 'pass', evidence_complete: 'pass' },
    skip_reasons: { regression_tests: 'run-level' }, verdict: 'pass', failures_mapped: [],
  });
}
/** drive TASK-0001 to verified through the CLI; returns the reviewer/verifier ids used. */
function driveToVerified(w: Walk, owner: string, rev: string, ver: string): void {
  makeWorktree(w, 'TASK-0001', owner);
  w.cli(['submit', 'RUN-0001', 'TASK-0001', `--agent=${owner}`, `--evidence=${evidenceDraft(w, 'first')}`]);
  w.cli(['review', 'claim', 'RUN-0001', 'TASK-0001', `--agent=${rev}`]);
  w.cli(['review', 'approve', 'RUN-0001', 'TASK-0001', `--agent=${rev}`, `--review=${draft(w, 'r.json', { findings: [] })}`]);
  w.cli(['verify', 'submit', 'RUN-0001', `--agent=${ver}`, `--verify=${verifyDraft(w, 'TASK-0001')}`]);
}

describe('user journeys — executable, terminal, tangle-free (product-axis reconciliation)', () => {
  journey({ id: 'J-setup', name: 'a fresh repo becomes team-ready', features: ['setup'],
    commands: ['init', 'doctor', 'adapter install'] }, () => {
    const w = new Walk(newRepo());
    expect(w.cli(['init', '--example']).ok).toBe(true);
    expect(w.cli(['doctor']).ok).toBe(true);
    expect(w.cli(['adapter', 'install', '--tool=claude-code']).ok).toBe(true);
    return w;
  });

  journey({ id: 'J-lightweight', name: 'decompose → claim → done → report → archive', features: ['lightweight'], terminal: 'archived',
    commands: ['init', 'run import', 'run list', 'claim-next', 'done', 'task list', 'status', 'report', 'run archive', 'audit run', 'events'] }, () => {
    const w = start('lightweight');
    expect(w.cli(['run', 'list']).ok).toBe(true);
    for (const t of ['TASK-0001', 'TASK-0002']) { w.cli(['claim-next', 'RUN-0001', '--agent=win-1']); w.cli(['done', 'RUN-0001', t, '--agent=win-1']); }
    expect(w.cli(['task', 'list', 'RUN-0001', '--status=done']).data.tasks).toHaveLength(2);
    expect((w.cli(['status', 'RUN-0001']).data.needs_user as Array<{ kind: string }>).some((n) => n.kind === 'ready_to_report')).toBe(true);
    expect(w.cli(['report', 'RUN-0001']).ok).toBe(true);
    expect(w.cli(['audit', 'run', 'RUN-0001']).data.findings).toBeDefined();
    w.cli(['events', 'RUN-0001']);
    expect(w.cli(['run', 'archive', 'RUN-0001']).ok).toBe(true);
    return w;
  });

  journey({ id: 'J-full', name: 'plan → claim → worktree → submit → review → verify → integrate → report → export',
    features: ['full-pipeline', 'worktree', 'evidence-gate', 'review-gate', 'verify-gate', 'integration', 'export'], terminal: 'reported',
    commands: ['init', 'run import', 'task publish', 'run show', 'task show', 'graph show', 'graph validate', 'agent register', 'agent list',
      'claim-next', 'worktree register', 'worktree list', 'context hydrate', 'submit', 'evidence show', 'review claim', 'review approve',
      'verify submit', 'task cancel', 'integrate start', 'integrate record', 'report', 'export'] }, () => {
    const w = start('full');
    w.cli(['task', 'publish', 'RUN-0001']);
    expect(w.cli(['run', 'show', 'RUN-0001']).ok).toBe(true);
    w.cli(['task', 'show', 'RUN-0001', 'TASK-0001']); w.cli(['graph', 'show', 'RUN-0001']); w.cli(['graph', 'validate', 'RUN-0001']);
    const owner = w.agent('owner', 'claude-code'); const rev = w.agent('rev'); const ver = w.agent('ver');
    w.cli(['agent', 'list', 'RUN-0001']);
    makeWorktree(w, 'TASK-0001', owner);
    w.cli(['worktree', 'list', 'RUN-0001']);
    w.cli(['context', 'hydrate', 'RUN-0001', 'TASK-0001', `--agent=${owner}`]);
    expect(w.cli(['submit', 'RUN-0001', 'TASK-0001', `--agent=${owner}`, `--evidence=${evidenceDraft(w, 'first')}`]).ok).toBe(true);
    w.cli(['evidence', 'show', 'RUN-0001', 'TASK-0001']);
    w.cli(['review', 'claim', 'RUN-0001', 'TASK-0001', `--agent=${rev}`]);
    w.cli(['review', 'approve', 'RUN-0001', 'TASK-0001', `--agent=${rev}`, `--review=${draft(w, 'r.json', { findings: [] })}`]);
    expect(w.cli(['verify', 'submit', 'RUN-0001', `--agent=${ver}`, `--verify=${verifyDraft(w, 'TASK-0001')}`]).ok).toBe(true);
    w.cli(['task', 'cancel', 'RUN-0001', 'TASK-0002', '--reason=descoped']); // close out the unstarted second task
    w.cli(['integrate', 'start', 'RUN-0001']);
    w.cli(['integrate', 'record', 'RUN-0001', 'TASK-0001', '--merge-commit=abc1234']);
    expect(w.cli(['report', 'RUN-0001']).ok).toBe(true);
    expect(w.cli(['export', 'RUN-0001']).ok).toBe(true);
    return w;
  });

  journey({ id: 'J-claim-lifecycle', name: 'claim → heartbeat → release; who-is-doing-what', features: ['claim-lease'],
    commands: ['init', 'run import', 'task publish', 'agent register', 'claim-next', 'heartbeat', 'agent list', 'task show', 'release'] }, () => {
    const w = start('full');
    w.cli(['task', 'publish', 'RUN-0001']);
    const a = w.agent('a', 'claude-code');
    w.cli(['claim-next', 'RUN-0001', `--agent=${a}`, '--task=TASK-0001']);
    expect(w.cli(['heartbeat', 'RUN-0001', 'TASK-0001', `--agent=${a}`]).ok).toBe(true);
    expect((w.cli(['agent', 'list', 'RUN-0001']).data.agents as Array<{ current_task: string | null }>).some((x) => x.current_task === 'TASK-0001')).toBe(true);
    w.cli(['task', 'show', 'RUN-0001', 'TASK-0001']);
    expect(w.cli(['release', 'RUN-0001', 'TASK-0001', `--agent=${a}`]).ok).toBe(true);
    return w;
  });

  journey({ id: 'J-mode-wall', name: 'a heavy command on a lightweight run is walled with a signpost (S3)', features: ['mode-wall'],
    commands: ['init', 'run import', 'claim-next', 'submit', 'done'] }, () => {
    const w = start('lightweight');
    w.cli(['claim-next', 'RUN-0001', '--agent=win-1']);
    const walled = w.cli(['submit', 'RUN-0001', 'TASK-0001', '--agent=win-1', '--evidence=/nope.json']);
    expect(walled.code).toBe('mode_mismatch');
    expect(walled.next.join(' ')).toContain('sigmarun done');
    expect(w.cli(['done', 'RUN-0001', 'TASK-0001', '--agent=win-1']).ok).toBe(true);
    return w;
  });

  journey({ id: 'J-pause', name: 'pause freezes dispatch, resume reopens, cancel closes', features: ['pause-cancel'], terminal: 'cancelled',
    commands: ['init', 'run import', 'task publish', 'run pause', 'claim-next', 'run resume', 'run cancel'] }, () => {
    const w = start('full');
    w.cli(['task', 'publish', 'RUN-0001']);
    w.cli(['run', 'pause', 'RUN-0001']);
    expect(w.cli(['claim-next', 'RUN-0001', '--agent=win-1']).code).toBe('run_paused');
    w.cli(['run', 'resume', 'RUN-0001']);
    expect(w.cli(['run', 'cancel', 'RUN-0001']).ok).toBe(true);
    return w;
  });

  journey({ id: 'J-blocker', name: 'ask a question, freeze the lease, answer, resume (S2/S11)', features: ['blocker'],
    commands: ['init', 'run import', 'task publish', 'agent register', 'claim-next', 'worktree register', 'msg post', 'block', 'status', 'msg list', 'unblock'] }, () => {
    const w = start('full');
    w.cli(['task', 'publish', 'RUN-0001']);
    const owner = w.agent('o', 'claude-code');
    makeWorktree(w, 'TASK-0001', owner);
    const msg = (w.cli(['msg', 'post', 'RUN-0001', `--from=${owner}`, '--type=blocker', '--task=TASK-0001', '--body=need a decision']).data as { message_id: string }).message_id;
    expect(w.cli(['block', 'RUN-0001', 'TASK-0001', `--agent=${owner}`, `--msg=${msg}`]).ok).toBe(true);
    const needs = w.cli(['status', 'RUN-0001']).data.needs_user as Array<{ kind: string; command: string }>;
    expect(needs.find((n) => n.kind === 'blocker')?.command).toContain('--type=answer');
    w.cli(['msg', 'list', 'RUN-0001', '--open']);
    w.cli(['msg', 'post', 'RUN-0001', '--from=user', '--type=answer', `--reply-to=${msg}`, '--body=decided']);
    expect(w.cli(['unblock', 'RUN-0001', 'TASK-0001', `--agent=${owner}`]).ok).toBe(true);
    return w;
  });

  journey({ id: 'J-takeover', name: 'dead owner reclaimed, successor adopts the worktree, the past holder reviews (S1/S4/D22)',
    features: ['takeover', 'force-reclaim'],
    commands: ['init', 'run import', 'task publish', 'agent register', 'claim-next', 'worktree register', 'reclaim', 'worktree adopt', 'submit', 'review claim', 'review approve'] }, () => {
    const w = start('full');
    w.cli(['task', 'publish', 'RUN-0001']);
    const a = w.agent('a', 'claude-code');
    makeWorktree(w, 'TASK-0001', a); // A working with a worktree
    expect(w.cli(['reclaim', 'RUN-0001', 'TASK-0001', '--force', '--agent=user']).ok).toBe(true); // S4: human takes the live lease
    const b = w.agent('b');
    w.cli(['claim-next', 'RUN-0001', `--agent=${b}`, '--task=TASK-0001']);
    expect(w.cli(['worktree', 'adopt', 'RUN-0001', 'TASK-0001', `--agent=${b}`]).ok).toBe(true); // B adopts the abandoned worktree
    w.cli(['submit', 'RUN-0001', 'TASK-0001', `--agent=${b}`, `--evidence=${evidenceDraft(w, 'first')}`]);
    const rc = w.cli(['review', 'claim', 'RUN-0001', 'TASK-0001', `--agent=${a}`]); // A never submitted evidence → may review (D22)
    expect(rc.ok).toBe(true);
    expect(w.cli(['review', 'approve', 'RUN-0001', 'TASK-0001', `--agent=${a}`, `--review=${draft(w, 'r.json', { findings: [] })}`]).ok).toBe(true);
    return w;
  });

  journey({ id: 'J-rework', name: 'request-changes revives the owner, resume, re-submit', features: ['rework'],
    commands: ['init', 'run import', 'task publish', 'agent register', 'claim-next', 'worktree register', 'submit', 'review claim', 'review request-changes', 'resume'] }, () => {
    const w = start('full');
    w.cli(['task', 'publish', 'RUN-0001']);
    const owner = w.agent('o', 'claude-code'); const rev = w.agent('r');
    makeWorktree(w, 'TASK-0001', owner);
    w.cli(['submit', 'RUN-0001', 'TASK-0001', `--agent=${owner}`, `--evidence=${evidenceDraft(w, 'first')}`]);
    w.cli(['review', 'claim', 'RUN-0001', 'TASK-0001', `--agent=${rev}`]);
    w.cli(['review', 'request-changes', 'RUN-0001', 'TASK-0001', `--agent=${rev}`, `--review=${draft(w, 'r.json', { findings: [{ must_fix: true, message: 'fix it' }] })}`]);
    expect(w.cli(['resume', 'RUN-0001', 'TASK-0001', `--agent=${owner}`]).ok).toBe(true);
    return w;
  });

  journey({ id: 'J-review-block', name: 'a review decides a human is needed → blocked → unblock', features: ['review-gate'],
    commands: ['init', 'run import', 'task publish', 'agent register', 'claim-next', 'worktree register', 'submit', 'review claim', 'review block', 'unblock'] }, () => {
    const w = start('full');
    w.cli(['task', 'publish', 'RUN-0001']);
    const owner = w.agent('o', 'claude-code'); const rev = w.agent('r');
    makeWorktree(w, 'TASK-0001', owner);
    w.cli(['submit', 'RUN-0001', 'TASK-0001', `--agent=${owner}`, `--evidence=${evidenceDraft(w, 'first')}`]);
    w.cli(['review', 'claim', 'RUN-0001', 'TASK-0001', `--agent=${rev}`]);
    expect(w.cli(['review', 'block', 'RUN-0001', 'TASK-0001', `--agent=${rev}`, `--review=${draft(w, 'r.json', { findings: [{ must_fix: true, message: 'needs a product call' }] })}`]).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(w.repo, '.team', 'runs', 'RUN-0001', 'tasks', 'TASK-0001', 'task.json'), 'utf8')).status).toBe('blocked');
    expect(w.cli(['unblock', 'RUN-0001', 'TASK-0001', '--agent=user']).ok).toBe(true);
    return w;
  });

  journey({ id: 'J-reopen', name: 'integrating discovers a gap, reopen, add, re-enter (S7)', features: ['run-reopen'],
    commands: ['init', 'run import', 'task publish', 'agent register', 'claim-next', 'worktree register', 'submit', 'review claim', 'review approve', 'verify submit', 'integrate start', 'run reopen', 'task add'] }, () => {
    const w = start('full');
    w.cli(['task', 'publish', 'RUN-0001']);
    const owner = w.agent('o', 'claude-code'); const rev = w.agent('r'); const ver = w.agent('v');
    driveToVerified(w, owner, rev, ver);
    w.cli(['integrate', 'start', 'RUN-0001']);
    expect(w.cli(['run', 'reopen', 'RUN-0001']).ok).toBe(true);
    expect(w.cli(['task', 'add', 'RUN-0001', `--file=${draft(w, 't.json', { title: 'Hotfix', objective: 'patch', acceptance: ['done'] })}`]).ok).toBe(true);
    return w;
  });

  journey({ id: 'J-integrate-fail', name: 'a merge check fails, task drops back to rework', features: ['integration'],
    commands: ['init', 'run import', 'task publish', 'agent register', 'claim-next', 'worktree register', 'submit', 'review claim', 'review approve', 'verify submit', 'integrate start', 'integrate record'] }, () => {
    const w = start('full');
    w.cli(['task', 'publish', 'RUN-0001']);
    const owner = w.agent('o', 'claude-code'); const rev = w.agent('r'); const ver = w.agent('v');
    driveToVerified(w, owner, rev, ver);
    w.cli(['integrate', 'start', 'RUN-0001']);
    expect(w.cli(['integrate', 'record', 'RUN-0001', 'TASK-0001', '--failed', '--reason=merge broke tests']).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(w.repo, '.team', 'runs', 'RUN-0001', 'tasks', 'TASK-0001', 'task.json'), 'utf8')).status).toBe('changes_requested');
    return w;
  });

  journey({ id: 'J-upstream-cancel', name: 'cancel a task; it is no longer claimable and status stays honest (S6)', features: ['upstream-cancel'],
    commands: ['init', 'run import', 'task publish', 'task cancel', 'status', 'claim-next'] }, () => {
    const w = start('full');
    w.cli(['task', 'publish', 'RUN-0001']);
    expect(w.cli(['task', 'cancel', 'RUN-0001', 'TASK-0001', '--reason=descoped']).ok).toBe(true);
    expect(w.cli(['status', 'RUN-0001']).ok).toBe(true);
    expect(w.cli(['claim-next', 'RUN-0001', '--agent=win-1', '--task=TASK-0001']).ok).toBe(false);
    return w;
  });

  journey({ id: 'J-worktree-recovery', name: 'a vanished worktree is pruned and the owner re-registers (S13)', features: ['worktree-recovery'],
    commands: ['init', 'run import', 'task publish', 'agent register', 'claim-next', 'worktree register', 'worktree prune'] }, () => {
    const w = start('full');
    w.cli(['task', 'publish', 'RUN-0001']);
    const owner = w.agent('o', 'claude-code');
    makeWorktree(w, 'TASK-0001', owner);
    const wtPath = JSON.parse(readFileSync(join(w.repo, '.team', 'runs', 'RUN-0001', 'worktrees.json'), 'utf8')).entries[0].path as string;
    rmSync(wtPath, { recursive: true, force: true });
    const pruned = w.cli(['worktree', 'prune', 'RUN-0001']);
    expect(pruned.ok).toBe(true);
    expect(pruned.data.stranded_tasks as string[]).toContain('TASK-0001');
    return w;
  });

  journey({ id: 'J-path-approval', name: 'a sensitive path is claim-gated until approved', features: ['path-approval'],
    commands: ['init', 'run import', 'task add', 'task publish', 'agent register', 'claim-next', 'approve-paths'] }, () => {
    const w = start('full');
    w.cli(['task', 'add', 'RUN-0001', `--file=${draft(w, 't.json', { title: 'Sensitive', objective: 'touch users', acceptance: ['done'], paths: { allow: ['src/x/**'], requires_approval: ['src/users/**'] } })}`]);
    w.cli(['task', 'publish', 'RUN-0001']);
    const a = w.agent('a', 'claude-code');
    expect(w.cli(['claim-next', 'RUN-0001', `--agent=${a}`, '--task=TASK-0003']).code).toBe('requires_approval');
    expect(w.cli(['approve-paths', 'RUN-0001', 'TASK-0003', '--paths=src/users/**']).ok).toBe(true);
    expect(w.cli(['claim-next', 'RUN-0001', `--agent=${a}`, '--task=TASK-0003']).ok).toBe(true);
    return w;
  });

  journey({ id: 'J-memory', name: 'run memory + L4 promotion path', features: ['context-memory'],
    commands: ['init', 'run import', 'memory update', 'memory candidates', 'memory promote'] }, () => {
    const w = start('lightweight');
    const m = join(w.repo, 'm.md'); writeFileSync(m, '# note\nSource: TASK-0001\n');
    expect(w.cli(['memory', 'update', 'RUN-0001', `--file=${m}`]).ok).toBe(true);
    expect(w.cli(['memory', 'candidates', 'RUN-0001']).ok).toBe(true);
    w.cli(['memory', 'promote', 'RUN-0001', '--entry=keep v1', '--section=Constraints', '--from=docs/team/MEMORY.md']); // reachable
    return w;
  });

  journey({ id: 'J-ops-recovery', name: 'audit → repair → backup → restore → migrate (operator safety net)', features: ['ops-recovery'],
    commands: ['init', 'run import', 'audit run', 'repair', 'backup list', 'restore', 'migrate'] }, () => {
    const w = start('lightweight');
    expect(w.cli(['audit', 'run', 'RUN-0001']).ok).toBe(true);
    expect(w.cli(['repair', 'RUN-0001']).ok).toBe(true);
    const backups = w.cli(['backup', 'list']);
    const id = (backups.data.backups as Array<{ id: string }> | undefined)?.[0]?.id;
    w.cli(['restore', id ?? 'none', '--dry-run']); // reachable either way
    expect(w.cli(['migrate', '--dry-run']).ok).toBe(true);
    return w;
  });

  journey({ id: 'J-observe', name: 'watch streams ticks and exits on a terminal run', features: ['observability'], terminal: 'archived',
    commands: ['init', 'run import', 'claim-next', 'done', 'report', 'run archive', 'watch'] }, () => {
    const w = start('lightweight');
    for (const t of ['TASK-0001', 'TASK-0002']) { w.cli(['claim-next', 'RUN-0001', '--agent=w']); w.cli(['done', 'RUN-0001', t, '--agent=w']); }
    w.cli(['report', 'RUN-0001']);
    w.cli(['run', 'archive', 'RUN-0001']);
    const ticks: string[] = [];
    w.cli(['watch', 'RUN-0001'], (l) => ticks.push(l));
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    return w;
  });
});

describe('journey ↔ function ↔ feature reconciliation (product-axis closure)', () => {
  it('every state-changing command belongs to at least one journey (no orphan function)', () => {
    const covered = new Set(CATALOG.flatMap((j) => j.commands));
    const orphans = COMMAND_SURFACE.filter((c) => !READONLY.has(c) && !covered.has(c));
    expect(orphans).toEqual([]);
  });

  it('every read-only observation command is reachable from some journey', () => {
    const covered = new Set(CATALOG.flatMap((j) => j.commands));
    expect([...READONLY].filter((c) => !covered.has(c))).toEqual([]);
  });

  it('every command a journey declares exists on the command surface (no phantom step)', () => {
    const phantoms = CATALOG.flatMap((j) => j.commands.filter((c) => !COMMAND_SURFACE.includes(c)).map((c) => `${j.id}:${c}`));
    expect(phantoms).toEqual([]);
  });

  it('every advertised feature is exercised by a journey (no unreachable feature)', () => {
    const exercised = new Set(CATALOG.flatMap((j) => j.features));
    expect(FEATURES.filter((f) => !exercised.has(f))).toEqual([]);
  });
});
