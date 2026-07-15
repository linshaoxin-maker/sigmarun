import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { submitEvidence } from '@sigmarun/core';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault, setupWorking } from '../../dispatch/test/fixture.js';
import { validDraft } from './submit-fixture.js';

let repo: string;
let agent: string;
beforeEach(async () => {
  repo = mkClaimRepo([
    { key: 'a', paths: { allow: ['src/a/**'] } },
  ]);
  // give the task a required check by re-importing is heavy; instead use fixture with checks below where needed
  agent = registerDefault(repo);
  await setupWorking(repo, agent);
});
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
const taskStatus = () => JSON.parse(readFileSync(join(runDir(), 'tasks', 'TASK-0001', 'task.json'), 'utf8')).status;
const events = () => readFileSync(join(runDir(), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

function expectInvalid(env: { ok: boolean; code: string; data: unknown }, needle: string): void {
  expect(env.ok).toBe(false);
  expect(env.code).toBe('evidence_invalid');
  const errors = (env.data as { errors: string[] }).errors;
  expect(errors.some((e) => e.includes(needle))).toBe(true);
  expect(taskStatus()).toBe('working'); // zero mutation rollback
  expect(existsSync(join(runDir(), 'evidence', 'TASK-0001', 'evidence.json'))).toBe(false);
  expect(events().some((e) => e.event === 'evidence_invalid')).toBe(true);
}

describe('submit — mechanical validation failures (docs/14 §2.1 field rules; BDD-005 invalid family)', () => {
  it('rejects a non-owner (not_claim_owner) and a non-working task (invalid_transition)', () => {
    const other = registerDefault(repo, 'win-2', 'codex');
    const env = submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: other, evidencePath: validDraft(repo) });
    expect(env.code).toBe('not_claim_owner');
    // drive to submitted, then retry: no longer working
    submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: validDraft(repo) });
    const again = submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: validDraft(repo) });
    expect(again.code).toBe('invalid_transition');
  });

  it('rejects empty changed_files', () => {
    const env = submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: validDraft(repo, { changed_files: [] }) });
    expectInvalid(env as never, 'changed_files');
  });

  it('rejects changed_files that escape the repository path contract', () => {
    const parent = submitEvidence({
      cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent,
      evidencePath: validDraft(repo, { changed_files: [{ path: '../outside.ts', change_type: 'modified' }] }),
    });
    expect(parent.ok).toBe(false);
    expect(parent.code).toBe('path_escape_detected');
    expect(taskStatus()).toBe('working');

    const absolute = submitEvidence({
      cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent,
      evidencePath: validDraft(repo, { changed_files: [{ path: join(repo, 'src/a/index.ts'), change_type: 'modified' }] }),
    });
    expect(absolute.ok).toBe(false);
    expect(absolute.code).toBe('path_escape_detected');
    expect(taskStatus()).toBe('working');
  });

  it('rejects acceptance that does not match the task item-by-item', () => {
    const env = submitEvidence({
      cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent,
      evidencePath: validDraft(repo, { acceptance: [{ item: 'something else.', status: 'met' }] }),
    });
    expectInvalid(env as never, 'acceptance');
  });

  it('rejects a skipped check without a note and an uncovered required check', () => {
    // add a required check onto the task via the draft: the task itself has none, so build one via task edit-free route:
    // fixture task has no required_checks; simulate coverage failure by claiming a check result that is skipped w/o note
    const env = submitEvidence({
      cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent,
      evidencePath: validDraft(repo, { required_checks_results: [{ check: 'npm test', cmd_ref: 'cmd-01', status: 'skipped' }] }),
    });
    expectInvalid(env as never, 'skipped');
  });

  it('rejects when a referenced output file does not exist', async () => {
    const { writeFileSync } = await import('node:fs');
    const draft = validDraft(repo);
    const parsed = JSON.parse(readFileSync(draft, 'utf8'));
    parsed.commands[0].output_file = join(repo, '..', 'missing-output.log');
    writeFileSync(draft, JSON.stringify(parsed));
    const env = submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: draft });
    expectInvalid(env as never, 'output');
  });

  it('rejects a missing handoff', () => {
    const env = submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: validDraft(repo, { handoff: '' }) });
    expectInvalid(env as never, 'handoff');
  });

  it('rejects an unparseable draft file as evidence_invalid', async () => {
    const { writeFileSync } = await import('node:fs');
    const bad = join(repo, '..', `bad-${Date.now()}.json`);
    writeFileSync(bad, '{not json');
    const env = submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: bad });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('evidence_invalid');
  });
});

describe('submit — required check coverage against a task that declares checks', () => {
  it('fails on uncovered checks and unknown cmd_ref; passes once covered', async () => {
    const repo2 = mkClaimRepo([{ key: 'b', checks: ['npm test -- b'] }]);
    try {
      const agent2 = registerDefault(repo2);
      await setupWorking(repo2, agent2, 'TASK-0001', 'task-b');

      const uncovered = submitEvidence({
        cwd: repo2, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent2,
        evidencePath: validDraft(repo2, { acceptance: [{ item: 'b done.', status: 'met' }], required_checks_results: [] }),
      });
      expect(uncovered.code).toBe('evidence_invalid');
      expect((uncovered.data as { errors: string[] }).errors.some((e) => e.includes('npm test -- b'))).toBe(true);

      const badRef = submitEvidence({
        cwd: repo2, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent2,
        evidencePath: validDraft(repo2, {
          acceptance: [{ item: 'b done.', status: 'met' }],
          required_checks_results: [{ check: 'npm test -- b', cmd_ref: 'cmd-99', status: 'pass' }],
        }),
      });
      expect(badRef.code).toBe('evidence_invalid');
      expect((badRef.data as { errors: string[] }).errors.some((e) => e.includes('cmd-99'))).toBe(true);

      const covered = submitEvidence({
        cwd: repo2, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent2,
        evidencePath: validDraft(repo2, {
          acceptance: [{ item: 'b done.', status: 'met' }],
          required_checks_results: [{ check: 'npm test -- b', cmd_ref: 'cmd-01', status: 'pass' }],
        }),
      });
      expect(covered.ok).toBe(true);
      const ev = JSON.parse(readFileSync(join(repo2, '.team', 'runs', 'RUN-0001', 'evidence', 'TASK-0001', 'evidence.json'), 'utf8'));
      expect(ev.required_checks_results[0].status).toBe('pass');
    } finally {
      cleanup(repo2);
    }
  });
});

describe('smoke-test L6: changed_files entry shape', () => {
  it('plain strings produce a precise evidence_invalid, not path_escape_detected', async () => {
    const { mkClaimRepo, registerDefault, setupWorking } = await import('../../dispatch/test/fixture.js');
    const { submitEvidence } = await import('@sigmarun/core');
    const { validDraft } = await import('./submit-fixture.js');
    const { cleanup } = await import('../../storage/test/helpers.js');
    const repo = mkClaimRepo([{ key: 'a' }]);
    try {
      const owner = registerDefault(repo, 'w-shape');
      await setupWorking(repo, owner);
      const draftPath = validDraft(repo, { changed_files: ['src/a/index.ts'] as unknown as Array<Record<string, unknown>> });
      const env = submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner, evidencePath: draftPath });
      expect(env.ok).toBe(false);
      expect(env.code).toBe('evidence_invalid');
      expect(JSON.stringify(env.data)).toContain('must be an object {path, change_type}');
    } finally {
      cleanup(repo);
    }
  }, 120_000);
});

describe('OSS security review: cmd_id is confined to a bare identifier', () => {
  it('a path-traversal cmd_id is rejected as evidence_invalid (arbitrary .log write prevented)', async () => {
    const { mkClaimRepo, registerDefault, setupWorking } = await import('../../dispatch/test/fixture.js');
    const { submitEvidence } = await import('@sigmarun/core');
    const { validDraft } = await import('./submit-fixture.js');
    const { cleanup } = await import('../../storage/test/helpers.js');
    const repo = mkClaimRepo([{ key: 'a' }]);
    try {
      const owner = registerDefault(repo, 'w-cmdid');
      await setupWorking(repo, owner);
      const draftPath = validDraft(repo, {
        commands: [{ cmd_id: '../../../../../../tmp/pwned', cmd: 'noop', exit_code: 0 }],
      });
      const env = submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner, evidencePath: draftPath });
      expect(env.ok).toBe(false);
      expect(env.code).toBe('evidence_invalid');
      expect(JSON.stringify(env.data)).toContain('cmd_id must match');
    } finally {
      cleanup(repo);
    }
  }, 120_000);
});
