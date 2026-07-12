import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonState, writeJsonStateAtomic } from '@sigmarun/storage';
import { claimNext } from '@sigmarun/dispatch';
import { postMessage } from '@sigmarun/context';
import { statusRun, runList, taskShow, evidenceShow } from '@sigmarun/watch';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault, setupWorking } from '../../dispatch/test/fixture.js';
import { validDraft } from '../../core/test/submit-fixture.js';

let repo: string;
let agent: string;
beforeEach(() => {
  repo = mkClaimRepo([
    { key: 'a' },
    { key: 'b', paths: { allow: ['src/b/**'], requires_approval: ['src/users/**'] } },
  ]);
  agent = registerDefault(repo);
});
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');

function expireLease(minutes: number): void {
  const file = join(runDir(), 'claims', 'task-claims.json');
  const { doc, rev } = readJsonState(file);
  (doc as { claims: Array<{ lease_until: string }> }).claims[0].lease_until = new Date(Date.now() - minutes * 60_000).toISOString();
  writeJsonStateAtomic(file, doc, { expectedRev: rev });
}

describe('status (Slice 7 acceptance; M32 Needs-user; INV-006 derived progress)', () => {
  it('reports status counts, weight-based progress, and writes progress.json', () => {
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent });
    const env = statusRun({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);
    const data = env.data as { counts: Record<string, number>; progress_pct: number; weight_total: number };
    expect(data.counts.claimed).toBe(1);
    expect(data.counts.ready).toBe(1);
    expect(data.progress_pct).toBe(3); // docs/03 §9: claimed 0.05 x w1 over total 2 -> 2.5 -> round
    expect(data.weight_total).toBe(2);
    const derived = JSON.parse(readFileSync(join(runDir(), 'progress.json'), 'utf8'));
    expect(derived.schema_version).toBe('team.progress.v1');
    expect(derived.counts.claimed).toBe(1);
  });

  it('progress counts done weight; stale lease is a risk unless the task is blocked', () => {
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent });
    expireLease(10);
    let env = statusRun({ cwd: repo, runId: 'RUN-0001' });
    let risks = (env.data as { risks: Array<{ kind: string; task_id: string }> }).risks;
    expect(risks.some((r) => r.kind === 'stale_lease' && r.task_id === 'TASK-0001')).toBe(true);

    const taskFile = join(runDir(), 'tasks', 'TASK-0001', 'task.json');
    const t = readJsonState(taskFile);
    (t.doc as { status: string }).status = 'blocked';
    writeJsonStateAtomic(taskFile, t.doc, { expectedRev: t.rev });
    env = statusRun({ cwd: repo, runId: 'RUN-0001' });
    risks = (env.data as { risks: Array<{ kind: string }> }).risks;
    expect(risks.some((r) => r.kind === 'stale_lease')).toBe(false); // docs/15 §5.1 exemption
  });

  it('S9 fractions: blocked keeps its pre-block value, cancelled leaves the denominator', async () => {
    const { submitEvidence, taskCancel } = await import('@sigmarun/core');
    const { registerAgent, reviewClaim, reviewDecide } = await import('@sigmarun/dispatch');
    await setupWorking(repo, agent);
    submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: validDraft(repo) });
    const reviewer = (registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'codex', role: 'reviewer', label: 'w-rev' }).data as { agent_id: string }).agent_id;
    reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer });
    const blocked = reviewDecide({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer, decision: 'block', review: { findings: [] } });
    expect(blocked.ok).toBe(true);
    let env = statusRun({ cwd: repo, runId: 'RUN-0001' });
    // blocked keeps reviewing's 0.7 (docs/03 S9): (0.7*1 + 0*1) / 2 -> 35%
    expect((env.data as { progress_pct: number }).progress_pct).toBe(35);

    taskCancel({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0002', reason: 'descoped' });
    env = statusRun({ cwd: repo, runId: 'RUN-0001' });
    // cancelled row leaves the denominator: 0.7 / 1 -> 70%
    const data = env.data as { progress_pct: number; weight_total: number };
    expect(data.weight_total).toBe(1);
    expect(data.progress_pct).toBe(70);

    // AUD-035 must agree with computeProgress on the cancelled-excluded denominator, or it
    // warns forever on any run with a cancelled task (state-machine review Finding 3).
    const { auditRun } = await import('@sigmarun/audit');
    const audit = auditRun({ cwd: repo, runId: 'RUN-0001' });
    const findings = (audit.data as { findings: Array<{ rule_id: string }> }).findings;
    expect(findings.filter((f) => f.rule_id === 'AUD-035')).toEqual([]);
  });

  it('unresolved blockers are risks; Needs-user lists approval/blocker/reclaim with commands (M32)', () => {
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent });
    postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: agent, type: 'blocker', body: 'schema undecided', taskId: 'TASK-0001' });
    expireLease(120); // way past 3xTTL -> reclaim confirmation
    const env = statusRun({ cwd: repo, runId: 'RUN-0001' });
    const data = env.data as {
      risks: Array<{ kind: string }>;
      needs_user: Array<{ kind: string; command: string }>;
    };
    expect(data.risks.some((r) => r.kind === 'unresolved_blocker')).toBe(true);
    const kinds = data.needs_user.map((n) => n.kind);
    expect(kinds).toContain('blocker');
    expect(kinds).toContain('approval_pending'); // task b requires_approval, no grant
    expect(kinds).toContain('reclaim_confirm');
    for (const n of data.needs_user) expect(n.command).toContain('sigmarun');
  });

  it('run list / task show / evidence show mirror the facts', async () => {
    await setupWorking(repo, agent);
    const { submitEvidence } = await import('@sigmarun/core');
    submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: validDraft(repo) });

    const list = runList({ cwd: repo });
    expect((list.data as { runs: Array<{ run_id: string; status: string }> }).runs[0]).toMatchObject({ run_id: 'RUN-0001', status: 'active' });

    const task = taskShow({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001' });
    const tdata = task.data as { task: { status: string }; claims: Array<{ status: string }>; evidence: { revision: number } | null };
    expect(tdata.task.status).toBe('submitted');
    expect(tdata.claims[0].status).toBe('submitted');
    expect(tdata.evidence?.revision).toBe(1);

    const ev = evidenceShow({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001' });
    const edata = ev.data as { evidence: { revision: number }; outputs: string[]; history: string[] };
    expect(edata.evidence.revision).toBe(1);
    expect(edata.outputs).toContain('outputs/cmd-01.log');
    expect(edata.history).toEqual([]);

    const missing = evidenceShow({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0002' });
    expect(missing.ok).toBe(true); // query command: "no evidence yet" is an answer, not an error
    expect((missing.data as { evidence: unknown }).evidence).toBeNull();
    expect(existsSync(join(runDir(), 'evidence', 'TASK-0002'))).toBe(false);
  });
});
