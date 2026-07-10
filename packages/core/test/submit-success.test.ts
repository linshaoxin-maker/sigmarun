import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonState, writeJsonStateAtomic } from '@sigmarun/storage';
import { hydrateContext } from '@sigmarun/context';
import { submitEvidence } from '@sigmarun/core';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault, setupWorking } from '../../dispatch/test/fixture.js';
import { validDraft } from './submit-fixture.js';

let repo: string;
let agent: string;
beforeEach(async () => {
  repo = mkClaimRepo([{ key: 'a' }]);
  agent = registerDefault(repo);
  await setupWorking(repo, agent);
});
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
const evDir = () => join(runDir(), 'evidence', 'TASK-0001');
const readJson = (rel: string) => JSON.parse(readFileSync(join(runDir(), rel), 'utf8'));
const events = () => readFileSync(join(runDir(), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('submit — happy path (docs/14 §2.3 nine steps; BDD-005-01)', () => {
  it('writes evidence + outputs + handoff, flips task/claim to submitted, keeps path claim held', () => {
    const env = submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: validDraft(repo) });
    expect(env.ok).toBe(true);

    const ev = JSON.parse(readFileSync(join(evDir(), 'evidence.json'), 'utf8'));
    expect(ev.schema_version).toBe('team.evidence.v1');
    expect(ev.revision).toBe(1);
    expect(ev.agent_id).toBe(agent);
    expect(ev.claim_id).toBe('CLAIM-task-0001');
    expect(ev.changed_files[0].in_scope).toBe(true);
    expect(ev.commands[0].output_ref).toBe('outputs/cmd-01.log');
    expect(readFileSync(join(evDir(), 'outputs', 'cmd-01.log'), 'utf8')).toContain('all 12 tests passed');
    expect(existsSync(join(evDir(), 'evidence.md'))).toBe(true);
    expect(readFileSync(join(runDir(), 'context', 'tasks', 'TASK-0001.md'), 'utf8')).toContain('handoff');
    expect(ev.handoff_ref).toBe('context/tasks/TASK-0001.md');

    expect(readJson('tasks/TASK-0001/task.json').status).toBe('submitted');
    expect(readJson('team-task-list.json').tasks[0].status).toBe('submitted');
    expect(readJson('claims/task-claims.json').claims[0].status).toBe('submitted');
    expect(readJson('claims/path-claims.json').claims[0].status).toBe('active'); // hold (15 §4.2)

    const ev27 = events().find((e) => e.event === 'evidence_submitted');
    expect(ev27.payload.revision).toBe(1);
    expect(ev27.payload.checks_pass_count).toBe(0);
    expect(ev27.payload.out_of_scope_count).toBe(0);
    expect(events().some((e) => e.event === 'review_skipped')).toBe(false); // require_review defaults true
  });

  it('redacts secrets in outputs and truncates long logs (D8)', () => {
    const draft = validDraft(repo);
    const parsed = JSON.parse(readFileSync(draft, 'utf8'));
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);
    lines[10] = 'export AWS_KEY=AKIAIOSFODNN7EXAMPLE';
    writeFileSync(parsed.commands[0].output_file, lines.join('\n'));
    const env = submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: draft });
    expect(env.ok).toBe(true);
    const log = readFileSync(join(evDir(), 'outputs', 'cmd-01.log'), 'utf8');
    expect(log).toContain('[REDACTED:aws_key]');
    expect(log).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(log).toContain('line 1');
    expect(log).toContain('line 500');
    expect(log).not.toContain('line 200'); // middle dropped (head 50 + tail 200)
    const ev = JSON.parse(readFileSync(join(evDir(), 'evidence.json'), 'utf8'));
    expect(ev.commands[0].output_truncated).toBe(true);
    expect(env.warnings.some((w) => w.code === 'secret_redacted')).toBe(true);
  });

  it('recomputes in_scope with minimatch; out-of-scope files warn and count (AUD-014 inline)', () => {
    const draft = validDraft(repo, {
      changed_files: [
        { path: 'src/a/index.ts', change_type: 'added' },
        { path: 'src/other/rogue.ts', change_type: 'modified', in_scope: true }, // agent lies; gateway recomputes
      ],
    });
    const env = submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: draft });
    expect(env.ok).toBe(true);
    const ev = JSON.parse(readFileSync(join(evDir(), 'evidence.json'), 'utf8'));
    expect(ev.changed_files[1].in_scope).toBe(false);
    expect(env.warnings.some((w) => w.code === 'out_of_scope_change')).toBe(true);
    expect(events().find((e) => e.event === 'evidence_submitted').payload.out_of_scope_count).toBe(1);
  });

  it('require_review=false: task goes approved with a review_skipped trace (D6)', () => {
    const runFile = join(runDir(), 'run.json');
    const { doc, rev } = readJsonState(runFile);
    ((doc as { default_policy: Record<string, unknown> }).default_policy).require_review = false;
    writeJsonStateAtomic(runFile, doc, { expectedRev: rev });
    const env = submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: validDraft(repo) });
    expect(env.ok).toBe(true);
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('approved');
    const skip = events().find((e) => e.event === 'review_skipped');
    expect(skip.actor.type).toBe('policy');
  });

  it('context_ack is reconciled against the hydrate must_read (AUD-028 warning half)', () => {
    hydrateContext({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent });
    const env = submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: validDraft(repo, { context_ack: [] }) });
    expect(env.ok).toBe(true);
    expect(env.warnings.some((w) => w.code === 'handoff_not_acknowledged')).toBe(true);
  });

  it('resubmission archives the previous evidence and bumps revision (rework carrier)', () => {
    submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: validDraft(repo) });
    // simulate the FEAT-009 changes_requested loop: task back to working, claim back to active
    const taskFile = join(runDir(), 'tasks', 'TASK-0001', 'task.json');
    const t = readJsonState(taskFile);
    (t.doc as { status: string }).status = 'working';
    writeJsonStateAtomic(taskFile, t.doc, { expectedRev: t.rev });
    const claimsFile = join(runDir(), 'claims', 'task-claims.json');
    const c = readJsonState(claimsFile);
    (c.doc as { claims: Array<{ status: string }> }).claims[0].status = 'active';
    writeJsonStateAtomic(claimsFile, c.doc, { expectedRev: c.rev });

    const env = submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: validDraft(repo) });
    expect(env.ok).toBe(true);
    const ev = JSON.parse(readFileSync(join(evDir(), 'evidence.json'), 'utf8'));
    expect(ev.revision).toBe(2);
    expect(existsSync(join(evDir(), 'history', 'rev-1.json'))).toBe(true);
  });
});
