import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonState, writeJsonStateAtomic } from '@sigmarun/storage';
import { claimNext } from '@sigmarun/dispatch';
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

function editState(rel: string, fn: (doc: Record<string, unknown>) => void): void {
  const file = join(runDir(), rel);
  const { doc, rev } = readJsonState(file);
  fn(doc as Record<string, unknown>);
  writeJsonStateAtomic(file, doc, { expectedRev: rev });
}

describe('audit run (docs/18 §7: read-only, exit 0, findings are data)', () => {
  it('clean run: ok, zero findings, rules_run + rules_skipped with reasons', () => {
    const env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);
    expect(env.code).toBe('OK');
    expect(findings(env).length).toBe(0);
    const data = env.data as { rules_run: string[]; rules_skipped: Array<{ rule_id: string; reason: string }> };
    expect(data.rules_run).toContain('AUD-001');
    expect(data.rules_run).toContain('AUD-033');
    expect(data.rules_skipped.some((s) => s.rule_id === 'AUD-032' && s.reason.includes('rev_after'))).toBe(true);
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

  it('event seq gap -> AUD-033 error', () => {
    const file = join(runDir(), 'events.jsonl');
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    writeFileSync(file, [lines[0], ...lines.slice(2)].join('\n') + '\n'); // drop seq 2
    const env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    expect(findings(env).some((f) => f.rule_id === 'AUD-033' && f.severity === 'error')).toBe(true);
  });

  it('active worktree entry with a missing path -> AUD-029', async () => {
    const path = await setupWorking(repo, agent);
    rmSync(path, { recursive: true, force: true });
    const env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    expect(findings(env).some((f) => f.rule_id === 'AUD-029' && f.severity === 'error')).toBe(true);
  });
});
