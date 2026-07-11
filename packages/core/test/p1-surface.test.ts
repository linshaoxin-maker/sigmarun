import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPause, runResume, runCancel, runArchive, taskAdd, taskCancel, publishTasks } from '@sigmarun/core';
import { claimNext, listWorktrees } from '@sigmarun/dispatch';
import { showGraph } from '@sigmarun/context';
import { auditRun } from '@sigmarun/audit';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault, setupWorking } from '../../dispatch/test/fixture.js';

let repo: string;
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
const readJson = (rel: string) => JSON.parse(readFileSync(join(runDir(), rel), 'utf8'));
const events = () => readFileSync(join(runDir(), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('run lifecycle ops (docs/15 §2.3; events #3/#4/#5/#6)', () => {
  it('pause freezes the claim queue; resume reopens it', () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const agent = registerDefault(repo);
    expect(runPause({ cwd: repo, runId: 'RUN-0001' }).ok).toBe(true);
    const denied = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent });
    expect(denied.code).toBe('run_paused');
    expect(runResume({ cwd: repo, runId: 'RUN-0001' }).ok).toBe(true);
    expect(claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent }).ok).toBe(true);
    const names = events().map((e) => e.event);
    expect(names).toContain('run_paused');
    expect(names).toContain('run_resumed');
    expect(runResume({ cwd: repo, runId: 'RUN-0001' }).code).toBe('invalid_transition'); // active -> resume refused
  });

  it('cancel cascades live claims and non-terminal tasks (BDD-007-09)', async () => {
    repo = mkClaimRepo([{ key: 'a' }, { key: 'b' }]);
    const agent = registerDefault(repo);
    await setupWorking(repo, agent); // TASK-0001 working with task+path claims
    const env = runCancel({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);
    const data = env.data as { cancelled_tasks: string[]; cascaded_claim_ids: string[] };
    expect(data.cancelled_tasks).toEqual(['TASK-0001', 'TASK-0002']);
    expect(data.cascaded_claim_ids.length).toBeGreaterThanOrEqual(2); // task + path claim
    expect(readJson('run.json').status).toBe('cancelled');
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('cancelled');
    expect(readJson('claims/task-claims.json').claims[0].status).toBe('cancelled');
    const cancelEvent = events().find((e) => e.event === 'run_cancelled');
    expect(cancelEvent.payload.cascaded_claim_ids).toEqual(data.cascaded_claim_ids);
    expect(events().filter((e) => e.event === 'task_cancelled').length).toBe(2);
    // terminal: nothing works anymore
    expect(publishTasks({ cwd: repo, runId: 'RUN-0001' }).code).toBe('run_not_active');
    expect(runCancel({ cwd: repo, runId: 'RUN-0001' }).code).toBe('invalid_transition');
  });

  it('reported runs cannot cancel — only archive (2026-07-10 adjudication)', async () => {
    const { readJsonState, writeJsonStateAtomic } = await import('@sigmarun/storage');
    repo = mkClaimRepo([{ key: 'a' }]);
    const runFile = join(runDir(), 'run.json');
    const { doc, rev } = readJsonState(runFile);
    (doc as { status: string }).status = 'reported';
    writeJsonStateAtomic(runFile, doc, { expectedRev: rev });

    const denied = runCancel({ cwd: repo, runId: 'RUN-0001' });
    expect(denied.code).toBe('invalid_transition');
    expect(denied.next_actions.some((a) => a.includes('archive'))).toBe(true);
    const archived = runArchive({ cwd: repo, runId: 'RUN-0001' });
    expect(archived.ok).toBe(true);
    expect(readJson('run.json').status).toBe('archived');
    expect(events().some((e) => e.event === 'run_archived')).toBe(true);
  });
});

describe('task add / cancel (docs/15 §3.3; event #19)', () => {
  it('adds a draft task with graph node + blocks edges; deps must exist', () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const env = taskAdd({
      cwd: repo, runId: 'RUN-0001',
      task: { title: 'Follow-up hardening', objective: 'Harden the thing.', acceptance: ['hardened.'], depends_on: ['TASK-0001'], paths: { allow: ['src/h/**'] } },
    });
    expect(env.ok).toBe(true);
    expect((env.data as { task_id: string }).task_id).toBe('TASK-0002');
    expect(readJson('tasks/TASK-0002/task.json').status).toBe('draft');
    const graph = readJson('task-graph.json');
    expect(graph.nodes.some((n: { task_id: string }) => n.task_id === 'TASK-0002')).toBe(true);
    expect(graph.edges.some((e: { from: string; to: string }) => e.from === 'TASK-0001' && e.to === 'TASK-0002')).toBe(true);
    expect(events().some((e) => e.event === 'task_created' && e.task_id === 'TASK-0002')).toBe(true);

    const bad = taskAdd({ cwd: repo, runId: 'RUN-0001', task: { title: 'x', objective: 'y', acceptance: ['z'], depends_on: ['TASK-0999'] } });
    expect(bad.code).toBe('schema_invalid');
    // published run accepts adds too; it lands as draft awaiting explicit publish
    publishTasks({ cwd: repo, runId: 'RUN-0001', taskIds: ['TASK-0002'] });
    expect(readJson('tasks/TASK-0002/task.json').status).toBe('ready');
  });

  it('cancel cascades the task claims and refuses frozen states', async () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const agent = registerDefault(repo);
    await setupWorking(repo, agent);
    const env = taskCancel({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001' });
    expect(env.ok).toBe(true);
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('cancelled');
    expect(readJson('claims/task-claims.json').claims[0].status).toBe('cancelled');
    expect(readJson('claims/path-claims.json').claims[0].status).toBe('cancelled');
    expect(events().some((e) => e.event === 'task_cancelled' && e.task_id === 'TASK-0001')).toBe(true);
    expect(taskCancel({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001' }).code).toBe('invalid_transition'); // already terminal
  });
});

describe('worktree list + graph show (read-only query surface)', () => {
  it('lists worktree entries with liveness; graph nodes carry derived status', async () => {
    repo = mkClaimRepo([{ key: 'a' }, { key: 'b', deps: ['a'] }]);
    const agent = registerDefault(repo);
    await setupWorking(repo, agent);

    const wt = listWorktrees({ cwd: repo, runId: 'RUN-0001' });
    const entries = (wt.data as { entries: Array<{ worktree_id: string; status: string; exists: boolean }> }).entries;
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ worktree_id: 'WT-TASK-0001', status: 'active', exists: true });

    const graph = showGraph({ cwd: repo, runId: 'RUN-0001' });
    const nodes = (graph.data as { nodes: Array<{ task_id: string; status: string }> }).nodes;
    expect(nodes.find((n) => n.task_id === 'TASK-0001')?.status).toBe('working');
    expect(nodes.find((n) => n.task_id === 'TASK-0002')?.status).toBe('ready');
  });
});

describe('AUD-024/025/027/034 — the context + replay batch goes live', () => {
  it('blocked without a blocker message errors; stale open question warns (ttl 0)', async () => {
    const { readJsonState, writeJsonStateAtomic } = await import('@sigmarun/storage');
    const { postMessage } = await import('@sigmarun/context');
    repo = mkClaimRepo([{ key: 'a' }], { policy: { context: { question_ttl_hours: 0 } } });
    const agent = registerDefault(repo);

    // hand-block the task WITHOUT a blocker message (the audit's target: direct edits / crashed flows)
    const taskFile = join(runDir(), 'tasks', 'TASK-0001', 'task.json');
    const t = readJsonState(taskFile);
    (t.doc as { status: string }).status = 'blocked';
    writeJsonStateAtomic(taskFile, t.doc, { expectedRev: t.rev });

    postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: agent, type: 'question', body: 'anyone?', refs: ['nope/missing.md'] });

    const env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    const findings = (env.data as { findings: Array<{ rule_id: string; severity: string }> }).findings;
    expect(findings.some((f) => f.rule_id === 'AUD-024' && f.severity === 'error')).toBe(true);
    expect(findings.some((f) => f.rule_id === 'AUD-025' && f.severity === 'warn')).toBe(true);
    expect(findings.some((f) => f.rule_id === 'AUD-027' && f.severity === 'warn')).toBe(true);
    // AUD-034: hand-blocked without event -> replay mismatch (ledger says draft)
    expect(findings.some((f) => f.rule_id === 'AUD-034' && f.severity === 'error')).toBe(true);
    const skipped = (env.data as { rules_skipped: unknown[] }).rules_skipped;
    expect(skipped).toEqual([]); // the full 40-rule catalog is live
  });

  it('a healthy gateway-driven run replays clean under AUD-034', async () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const agent = registerDefault(repo);
    await setupWorking(repo, agent);
    const env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    const findings = (env.data as { findings: Array<{ rule_id: string }> }).findings;
    expect(findings.filter((f) => f.rule_id === 'AUD-034')).toEqual([]);
  });
});
