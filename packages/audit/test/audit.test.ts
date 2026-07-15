import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonState, writeJsonStateAtomic } from '@sigmarun/storage';
import { claimNext, registerAgent, reviewClaim, reviewDecide } from '@sigmarun/dispatch';
import { auditRun } from '@sigmarun/audit';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault, setupWorking } from '../../dispatch/test/fixture.js';
import { validDraft } from '../../core/test/submit-fixture.js';

let repo: string;
let agent: string;
beforeEach(() => {
  repo = mkClaimRepo([{ key: 'a' }]);
  agent = registerDefault(repo);
});
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
type Finding = { rule_id: string; severity: string; message: string; next_action: string };
const findings = (env: { data: unknown }) => (env.data as { findings: Finding[] }).findings;
const hasRule = (env: { data: unknown }, ruleId: string) => findings(env).some((f) => f.rule_id === ruleId && f.severity === 'error');

function editState(rel: string, fn: (doc: Record<string, unknown>) => void): void {
  const file = join(runDir(), rel);
  const { doc, rev } = readJsonState(file);
  fn(doc as Record<string, unknown>);
  writeJsonStateAtomic(file, doc, { expectedRev: rev });
}

async function submitAndApprove(): Promise<{ reviewer: string }> {
  await setupWorking(repo, agent);
  const { submitEvidence } = await import('@sigmarun/core');
  submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: validDraft(repo) });
  const reviewer = (registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'codex', role: 'reviewer', label: 'win-review' }).data as { agent_id: string }).agent_id;
  reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer });
  reviewDecide({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer, decision: 'approve', review: { findings: [] } });
  return { reviewer };
}

describe('audit run (docs/18 §7: read-only, exit 0, findings are data)', () => {
  it('clean run: ok, zero findings, rules_run + rules_skipped with reasons', () => {
    const env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);
    expect(env.code).toBe('OK');
    expect(findings(env).length).toBe(0);
    const data = env.data as { rules_run: string[]; rules_skipped: Array<{ rule_id: string; reason: string }> };
    expect(data.rules_run).toContain('AUD-001');
    expect(data.rules_run).toContain('AUD-032');
    expect(data.rules_run).toContain('AUD-033');
    expect(data.rules_skipped.some((s) => s.rule_id === 'AUD-032')).toBe(false);
  });

  it('duplicate active task claims -> AUD-001 error with rule_id and next_action', () => {
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent });
    editState('claims/task-claims.json', (doc) => {
      const claims = doc.claims as Array<Record<string, unknown>>;
      claims.push({ ...claims[0], claim_id: 'CLAIM-task-9999', agent_id: 'AGENT-rogue-001' });
    });
    const env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true); // still exit 0 — findings are data
    const f = findings(env).find((x) => x.rule_id === 'AUD-001');
    expect(f?.severity).toBe('error');
    expect(f?.next_action).toContain('reclaim');
  });

  it('task/claim matrix drift is caught by AUD-005..010', () => {
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent });

    editState('tasks/TASK-0001/task.json', (doc) => { doc.status = 'ready'; });
    editState('team-task-list.json', (doc) => { (doc.tasks as Array<Record<string, unknown>>)[0].status = 'ready'; });
    expect(hasRule(auditRun({ cwd: repo, runId: 'RUN-0001' }), 'AUD-005')).toBe(true);

    editState('tasks/TASK-0001/task.json', (doc) => { doc.status = 'working'; });
    editState('team-task-list.json', (doc) => { (doc.tasks as Array<Record<string, unknown>>)[0].status = 'working'; });
    editState('claims/task-claims.json', (doc) => { (doc.claims as Array<Record<string, unknown>>)[0].status = 'released'; });
    expect(hasRule(auditRun({ cwd: repo, runId: 'RUN-0001' }), 'AUD-006')).toBe(true);

    editState('claims/task-claims.json', (doc) => { (doc.claims as Array<Record<string, unknown>>)[0].status = 'active'; });
    editState('tasks/TASK-0001/task.json', (doc) => { doc.status = 'submitted'; });
    editState('team-task-list.json', (doc) => { (doc.tasks as Array<Record<string, unknown>>)[0].status = 'submitted'; });
    expect(hasRule(auditRun({ cwd: repo, runId: 'RUN-0001' }), 'AUD-007')).toBe(true);

    editState('claims/task-claims.json', (doc) => { (doc.claims as Array<Record<string, unknown>>)[0].status = 'released'; });
    editState('tasks/TASK-0001/task.json', (doc) => { doc.status = 'changes_requested'; });
    editState('team-task-list.json', (doc) => { (doc.tasks as Array<Record<string, unknown>>)[0].status = 'changes_requested'; });
    expect(hasRule(auditRun({ cwd: repo, runId: 'RUN-0001' }), 'AUD-008')).toBe(true);

    editState('claims/task-claims.json', (doc) => { (doc.claims as Array<Record<string, unknown>>)[0].status = 'active'; });
    editState('tasks/TASK-0001/task.json', (doc) => { doc.status = 'verified'; });
    editState('team-task-list.json', (doc) => { (doc.tasks as Array<Record<string, unknown>>)[0].status = 'verified'; });
    expect(hasRule(auditRun({ cwd: repo, runId: 'RUN-0001' }), 'AUD-009')).toBe(true);

    editState('tasks/TASK-0001/task.json', (doc) => { doc.status = 'cancelled'; });
    editState('team-task-list.json', (doc) => { (doc.tasks as Array<Record<string, unknown>>)[0].status = 'cancelled'; });
    expect(hasRule(auditRun({ cwd: repo, runId: 'RUN-0001' }), 'AUD-010')).toBe(true);
  });

  it('expired lease -> AUD-003 warn; blocked task exempt', () => {
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent });
    editState('claims/task-claims.json', (doc) => {
      (doc.claims as Array<{ lease_until: string }>)[0].lease_until = new Date(Date.now() - 10 * 60_000).toISOString();
    });
    let env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    expect(findings(env).some((f) => f.rule_id === 'AUD-003' && f.severity === 'warn')).toBe(true);

    editState('tasks/TASK-0001/task.json', (doc) => { doc.status = 'blocked'; });
    env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    expect(findings(env).some((f) => f.rule_id === 'AUD-003')).toBe(false);
  });

  it('evidence acceptance drift -> AUD-013; missing evidence for submitted task -> AUD-011', async () => {
    await setupWorking(repo, agent);
    const { submitEvidence } = await import('@sigmarun/core');
    submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: validDraft(repo) });
    editState('evidence/TASK-0001/evidence.json', (doc) => {
      (doc.acceptance as Array<{ item: string }>)[0].item = 'tampered text';
    });
    let env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    expect(findings(env).some((f) => f.rule_id === 'AUD-013' && f.severity === 'error')).toBe(true);

    rmSync(join(runDir(), 'evidence', 'TASK-0001'), { recursive: true });
    env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    expect(findings(env).some((f) => f.rule_id === 'AUD-011')).toBe(true);
  });

  it('untrusted evidence checks, raw output secrets, and invalid review skips are caught by AUD-012/018/019', async () => {
    await setupWorking(repo, agent);
    const { submitEvidence } = await import('@sigmarun/core');
    submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: validDraft(repo) });

    editState('tasks/TASK-0001/task.json', (doc) => {
      doc.required_checks = ['npm test -- a'];
    });
    editState('evidence/TASK-0001/evidence.json', (doc) => {
      doc.required_checks_results = [{ check: 'npm test -- a', cmd_ref: 'cmd-01', status: 'pass' }];
      (doc.commands as Array<Record<string, unknown>>)[0].exit_code = 1;
    });
    let env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    expect(hasRule(env, 'AUD-012')).toBe(true);

    writeFileSync(join(runDir(), 'evidence', 'TASK-0001', 'outputs', 'cmd-01.log'), 'leaked AKIAIOSFODNN7EXAMPLE\n');
    env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    expect(hasRule(env, 'AUD-018')).toBe(true);

    editState('run.json', (doc) => {
      (doc.default_policy as Record<string, unknown>).require_review = true;
    });
    const eventsFile = join(runDir(), 'events.jsonl');
    writeFileSync(
      eventsFile,
      readFileSync(eventsFile, 'utf8') +
        JSON.stringify({ schema_version: 'team.event.v1', ts: new Date().toISOString(), seq: 999, event: 'review_skipped', actor: { type: 'policy', id: 'test' }, run_id: 'RUN-0001', task_id: 'TASK-0001', payload: {} }) +
        '\n',
    );
    env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    expect(hasRule(env, 'AUD-019')).toBe(true);
  });

  it('a policy-legal review skip is warn, not error (AUD-019 severity; remediation D-2)', async () => {
    editState('run.json', (doc) => {
      (doc.default_policy as Record<string, unknown>).require_review = false;
    });
    await setupWorking(repo, agent);
    const { submitEvidence } = await import('@sigmarun/core');
    submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: validDraft(repo) });
    expect((readJsonState(join(runDir(), 'tasks', 'TASK-0001', 'task.json')).doc as { status: string }).status).toBe('approved');
    const env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    const f = findings(env).find((x) => x.rule_id === 'AUD-019');
    expect(f).toBeTruthy();
    expect(f!.severity).toBe('warn');
  });

  it('a healthy lightweight run audits with ZERO errors — evidence-chain rules report info (S10/D21)', async () => {
    const { importRun, taskDone } = await import('@sigmarun/core');
    const { mkTmpGitRepo } = await import('../../storage/test/helpers.js');
    const { validPayload } = await import('../../core/test/payload-fixture.js');
    const { initProject } = await import('@sigmarun/core');
    const lite = mkTmpGitRepo();
    try {
      initProject({ cwd: lite });
      importRun({ cwd: lite, payload: validPayload(), lightweight: true });
      // complete every task the sanctioned lightweight way
      for (;;) {
        const c = claimNext({ cwd: lite, runId: 'RUN-0001', agentId: 'win-1' });
        if (!c.ok) break;
        taskDone({ cwd: lite, runId: 'RUN-0001', taskId: (c.data as { task_id: string }).task_id, agentId: 'win-1' });
      }
      const env = auditRun({ cwd: lite, runId: 'RUN-0001' });
      const all = findings(env);
      expect(all.filter((f) => f.severity === 'error')).toEqual([]);
      // visibility is kept: the waiver is announced as info, not silence
      expect(all.some((f) => f.rule_id === 'AUD-011' && f.severity === 'info')).toBe(true);
      expect(all.some((f) => f.rule_id === 'AUD-016' && f.severity === 'info')).toBe(true);
      expect(all.some((f) => f.rule_id === 'AUD-017' && f.severity === 'info')).toBe(true);
    } finally {
      cleanup(lite);
    }
  });

  it('event seq gap -> AUD-033 error', () => {
    const file = join(runDir(), 'events.jsonl');
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    writeFileSync(file, [lines[0], ...lines.slice(2)].join('\n') + '\n'); // drop seq 2
    const env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    expect(findings(env).some((f) => f.rule_id === 'AUD-033' && f.severity === 'error')).toBe(true);
  });

  it('state edit after the latest event -> AUD-032 direct_state_edit_suspected', () => {
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent });
    editState('claims/task-claims.json', (doc) => {
      (doc.claims as Array<Record<string, unknown>>)[0].lease_until = new Date(Date.now() + 99 * 60_000).toISOString();
    });
    const env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    const f = findings(env).find((x) => x.rule_id === 'AUD-032');
    expect(f?.severity).toBe('error');
    expect(f?.message).toContain('direct_state_edit_suspected');
  });

  it('active worktree entry with a missing path -> AUD-029', async () => {
    const path = await setupWorking(repo, agent);
    rmSync(path, { recursive: true, force: true });
    const env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    expect(findings(env).some((f) => f.rule_id === 'AUD-029' && f.severity === 'error')).toBe(true);
  });

  it('review and verification direct edits are caught by review/verify audit rules', async () => {
    await submitAndApprove();

    editState('reviews/TASK-0001/REVIEW-TASK-0001-01.json', (doc) => {
      doc.reviewer_agent_id = agent;
    });
    let env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    expect(findings(env).some((f) => f.rule_id === 'AUD-015' && f.severity === 'error')).toBe(true);

    editState('reviews/TASK-0001/REVIEW-TASK-0001-01.json', (doc) => {
      doc.reviewer_agent_id = 'AGENT-codex-002';
    });
    rmSync(join(runDir(), 'reviews', 'TASK-0001'), { recursive: true, force: true });
    env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    expect(findings(env).some((f) => f.rule_id === 'AUD-016' && f.severity === 'error')).toBe(true);

    editState('tasks/TASK-0001/task.json', (doc) => { doc.status = 'verified'; });
    editState('team-task-list.json', (doc) => {
      (doc.tasks as Array<Record<string, unknown>>)[0].status = 'verified';
    });
    env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    expect(findings(env).some((f) => f.rule_id === 'AUD-017' && f.severity === 'error')).toBe(true);
  });

  it('duplicate active review claims -> AUD-020', async () => {
    await setupWorking(repo, agent);
    const { submitEvidence } = await import('@sigmarun/core');
    submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: validDraft(repo) });
    const reviewer = (registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'codex', role: 'reviewer', label: 'win-review' }).data as { agent_id: string }).agent_id;
    reviewClaim({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: reviewer });
    editState('claims/review-claims.json', (doc) => {
      const claims = doc.claims as Array<Record<string, unknown>>;
      claims.push({ ...claims[0], claim_id: 'CLAIM-review-9999', reviewer_agent_id: 'AGENT-reviewer-rogue' });
    });
    const env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    expect(findings(env).some((f) => f.rule_id === 'AUD-020' && f.severity === 'error')).toBe(true);
  });
});
