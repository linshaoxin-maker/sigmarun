import { describe, it, expect, afterEach } from 'vitest';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, readJsonState, writeJsonStateAtomic } from '@sigmarun/storage';
import { integrateStart, integrateRecord, publishTasks, runShow, submitEvidence } from '@sigmarun/core';
import { registerAgent } from '@sigmarun/dispatch';
import { auditRun, repairRun } from '@sigmarun/audit';
import { promoteMemory, postMessage } from '@sigmarun/context';
import { runCli } from '../../cli/src/cli.js';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault, driveToVerified, setupWorking } from '../../dispatch/test/fixture.js';
import { validDraft } from './submit-fixture.js';

let repo: string;
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
const readJson = (rel: string) => JSON.parse(readFileSync(join(runDir(), rel), 'utf8'));

describe('publish shares the canonical run lock (fix #1)', () => {
  it('publish blocks with lock_timeout while run.lock is held', () => {
    repo = mkClaimRepo([{ key: 'a' }], { publish: false });
    const release = acquireLock(join(runDir(), 'run.lock'));
    try {
      const env = publishTasks({ cwd: repo, runId: 'RUN-0001' });
      expect(env.ok).toBe(false);
      expect(env.code).toBe('lock_timeout'); // previously it locked a different path and sailed through
    } finally {
      release();
    }
    const after = publishTasks({ cwd: repo, runId: 'RUN-0001' });
    expect(after.ok).toBe(true);
  }, 15_000);
});

describe('repair replay knows the verified/integrated tail (fix #2)', () => {
  it('a healthy verified + integrated run is a no-op for repair', async () => {
    repo = mkClaimRepo(
      [{ key: 'a' }],
      { policy: { deps_satisfied_when: ['approved', 'verified', 'integrated', 'done'] } },
    );
    const owner = registerDefault(repo, 'w-owner');
    const reviewer = (registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'claude-code', role: 'reviewer', label: 'w-r' }).data as { agent_id: string }).agent_id;
    const verifier = (registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'codex', role: 'verifier', label: 'w-v' }).data as { agent_id: string }).agent_id;
    await driveToVerified(repo, 'TASK-0001', 'a', owner, reviewer, verifier);
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('verified');

    let env = repairRun({ cwd: repo, runId: 'RUN-0001' });
    expect((env.data as { repaired: unknown[] }).repaired).toEqual([]); // previously demoted verified -> approved
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('verified');

    integrateStart({ cwd: repo, runId: 'RUN-0001' });
    integrateRecord({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', mergeCommit: 'abc1234' });
    env = repairRun({ cwd: repo, runId: 'RUN-0001' });
    expect((env.data as { repaired: unknown[] }).repaired).toEqual([]);
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('integrated');
  }, 30_000);
});

describe('torn events.jsonl degrades to findings instead of crashes (fix #9)', () => {
  it('submit still works; audit and repair surface the corrupt line', async () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const owner = registerDefault(repo);
    await setupWorking(repo, owner);
    appendFileSync(join(runDir(), 'events.jsonl'), '{"schema_version":"team.event.v1","seq":99,"ev'); // torn tail

    const submit = submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner, evidencePath: validDraft(repo) });
    expect(submit.ok).toBe(true); // previously: raw SyntaxError crash

    const audit = auditRun({ cwd: repo, runId: 'RUN-0001' });
    expect(audit.ok).toBe(true);
    expect((audit.data as { findings: Array<{ rule_id: string; message: string }> }).findings.some(
      (f) => f.rule_id === 'AUD-033' && f.message.includes('unparseable'),
    )).toBe(true);

    const repair = repairRun({ cwd: repo, runId: 'RUN-0001' });
    expect(repair.ok).toBe(true);
    expect((repair.data as { findings: string[] }).findings.some((f) => f.includes('unparseable'))).toBe(true);
  });
});

describe('small confirmed fixes', () => {
  it('run show exposes the stored default_policy (fix #11)', () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const env = runShow({ cwd: repo, runId: 'RUN-0001' });
    const policy = (env.data as { run: { policy?: { claim_ttl_minutes?: number } } }).run.policy;
    expect(policy?.claim_ttl_minutes).toBe(30); // previously undefined (read run.policy)
  });

  it('integrate record --failed honors the run claim TTL (fix #13)', async () => {
    repo = mkClaimRepo(
      [{ key: 'a' }],
      { policy: { claim_ttl_minutes: 5, deps_satisfied_when: ['approved', 'verified', 'integrated', 'done'] } },
    );
    const owner = registerDefault(repo, 'w-owner');
    const reviewer = (registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'claude-code', role: 'reviewer', label: 'w-r' }).data as { agent_id: string }).agent_id;
    const verifier = (registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'codex', role: 'verifier', label: 'w-v' }).data as { agent_id: string }).agent_id;
    await driveToVerified(repo, 'TASK-0001', 'a', owner, reviewer, verifier);
    integrateStart({ cwd: repo, runId: 'RUN-0001' });
    integrateRecord({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', failed: true, reason: 'merge checks failed' });
    const claim = readJson('claims/task-claims.json').claims.find((c: { status: string }) => c.status === 'active');
    const leaseMs = Date.parse(claim.lease_until) - Date.now();
    expect(leaseMs).toBeLessThan(6 * 60_000); // 5-min policy, not the old hard-coded 30
    expect(leaseMs).toBeGreaterThan(3 * 60_000);
  }, 30_000);

  it('watch rejects a non-numeric --interval instead of hanging (fix #10)', () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const r = runCli(['watch', 'RUN-0001', '--interval=30s', '--json'], { cwd: repo });
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout).code).toBe('usage_error');
  });

  it('memory promote rejects a sibling-prefix escape path (fix #12)', () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const agent = registerDefault(repo);
    postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: agent, type: 'decision', body: 'decided.' });
    const projFile = join(repo, '.team', 'project.json');
    const { doc, rev } = readJsonState(projFile);
    (doc as { project_memory_path?: string }).project_memory_path = '../side-repo/MEMORY.md';
    writeJsonStateAtomic(projFile, doc, { expectedRev: rev });

    const env = promoteMemory({ cwd: repo, runId: 'RUN-0001', entry: 'x.', section: 'Architecture', refs: ['MSG-0001'] });
    expect(env.code).toBe('memory_entry_invalid');
    expect(existsSync(join(repo, '..', 'side-repo'))).toBe(false); // nothing written outside the repo
  });
});
