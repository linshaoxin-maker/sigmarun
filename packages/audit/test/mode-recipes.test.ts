import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { appendEvent, submitEvidence } from '@sigmarun/core';
import { readJsonState, writeJsonStateAtomic } from '@sigmarun/storage';
import { auditRun } from '@sigmarun/audit';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault, setupWorking } from '../../dispatch/test/fixture.js';
import { validDraft } from '../../core/test/submit-fixture.js';

/**
 * Mode-recipe rules (AUD-042..046, docs/18 §4.I) — the audit backstop for the plan recipes that
 * live in the skill templates (docs/34 §4). The recipes are advice an AI can forget; these rules
 * check the promised artifacts actually landed, using structural/keyword tests only (I4).
 *
 * The negative cases matter as much as the positives: a rule that fires on runs of OTHER modes
 * would punish every pre-existing run, so each test pins the no-op side too.
 */

const repos: string[] = [];
afterEach(() => {
  while (repos.length) cleanup(repos.pop()!);
});

type Finding = { rule_id: string; severity: string; message: string; next_action: string };
const findings = (env: { data: unknown }) => (env.data as { findings: Finding[] }).findings;
const find = (repo: string, rule: string): Finding | undefined =>
  findings(auditRun({ cwd: repo, runId: 'RUN-0001' })).find((f) => f.rule_id === rule);

/** mkClaimRepo hard-codes mode "feature"; the recipes key off the routed label. */
function setMode(repo: string, mode: string): void {
  const file = join(repo, '.team', 'runs', 'RUN-0001', 'run.json');
  const { doc, rev } = readJsonState(file);
  (doc as Record<string, unknown>).mode = mode;
  writeJsonStateAtomic(file, doc as Record<string, unknown>, { expectedRev: rev });
}

function mk(tasks: Parameters<typeof mkClaimRepo>[0], mode: string): string {
  const repo = mkClaimRepo(tasks);
  repos.push(repo);
  setMode(repo, mode);
  return repo;
}

/** Claim TASK-0001, make a worktree, file evidence built from the given overrides. */
async function submitWith(repo: string, overrides: Record<string, unknown>): Promise<void> {
  const agent = registerDefault(repo);
  await setupWorking(repo, agent);
  submitEvidence({
    cwd: repo,
    runId: 'RUN-0001',
    taskId: 'TASK-0001',
    agentId: agent,
    evidencePath: validDraft(repo, overrides),
  });
}

describe('AUD-042 — bugfix run without an investigation slice', () => {
  it('warns when a bugfix run has no investigation task (repro + impact have nowhere to land)', () => {
    const repo = mk([{ key: 'a' }], 'bugfix');
    const f = find(repo, 'AUD-042');
    expect(f?.severity).toBe('warn');
    expect(f?.message).toContain('investigation');
    expect(f?.next_action).toContain('task add');
  });

  it('stays silent once an investigation slice exists', () => {
    const repo = mk([{ key: 'a' }, { key: 'repro', type: 'investigation' }], 'bugfix');
    expect(find(repo, 'AUD-042')).toBeUndefined();
  });

  it('never fires on other modes — a feature run owes no repro slice', () => {
    const repo = mk([{ key: 'a' }], 'feature');
    expect(find(repo, 'AUD-042')).toBeUndefined();
  });
});

describe('AUD-043 — hotfix evidence without a rollback note', () => {
  it('warns when a hotfix implementation never mentions rollback', async () => {
    const repo = mk([{ key: 'a' }], 'hotfix');
    await submitWith(repo, {});
    const f = find(repo, 'AUD-043');
    expect(f?.severity).toBe('warn');
    expect(f?.message).toContain('rollback');
  });

  it('accepts the note wherever it lands in the evidence — here an acceptance line', async () => {
    const repo = mk([{ key: 'a' }], 'hotfix');
    await submitWith(repo, {
      acceptance: [{ item: 'a done.', status: 'met', note: 'outputs/rollback-note.md: revert via feature flag OFF.' }],
    });
    expect(find(repo, 'AUD-043')).toBeUndefined();
  });

  it('does not fire on plain debug runs — debug is debugging, not a hotfix', async () => {
    const repo = mk([{ key: 'a' }], 'debug');
    await submitWith(repo, {});
    expect(find(repo, 'AUD-043')).toBeUndefined();
  });
});

describe('AUD-044 — refactor evidence without a safety net', () => {
  it('warns when a refactor implementation shows no safety-net log', async () => {
    const repo = mk([{ key: 'a' }], 'refactor');
    await submitWith(repo, {});
    const f = find(repo, 'AUD-044');
    expect(f?.severity).toBe('warn');
    expect(f?.message).toContain('safety-net');
  });

  it('stays silent when the before/after logs are cited as commands', async () => {
    const repo = mk([{ key: 'a' }], 'refactor');
    await submitWith(repo, {
      summary: 'Extracted the module; behavior pinned by outputs/safety-before.log and safety-after.log.',
    });
    expect(find(repo, 'AUD-044')).toBeUndefined();
  });
});

describe('AUD-045 — a review slice that mutates code', () => {
  it('errors when a review task modifies files (that edit escaped review itself)', async () => {
    const repo = mk([{ key: 'a', type: 'review' }], 'review');
    await submitWith(repo, {
      changed_files: [
        { path: 'outputs/findings-security.md', change_type: 'added' },
        { path: 'src/a/index.ts', change_type: 'modified' },
      ],
    });
    const f = find(repo, 'AUD-045');
    expect(f?.severity).toBe('error');
    expect(f?.message).toContain('src/a/index.ts');
    expect(f?.next_action).toContain('bugfix');
  });

  it('allows the findings document itself — submit requires a non-empty changed_files', async () => {
    const repo = mk([{ key: 'a', type: 'review' }], 'review');
    await submitWith(repo, {
      changed_files: [{ path: 'outputs/findings-security.md', change_type: 'added' }],
    });
    expect(find(repo, 'AUD-045')).toBeUndefined();
  });

  it('leaves implementation tasks alone — they are supposed to change code', async () => {
    const repo = mk([{ key: 'a' }], 'feature');
    await submitWith(repo, { changed_files: [{ path: 'src/a/index.ts', change_type: 'modified' }] });
    expect(find(repo, 'AUD-045')).toBeUndefined();
  });
});

describe('AUD-046 — spike code merged back', () => {
  it('warns when a spike task carries a recorded merge commit', () => {
    const repo = mk([{ key: 'a' }], 'spike');
    appendEvent(join(repo, '.team', 'runs', 'RUN-0001'), {
      event: 'task_integrated',
      actor: { type: 'agent', id: 'integrator' },
      run_id: 'RUN-0001',
      task_id: 'TASK-0001',
      payload: { merge_commit: 'abc1234', released_claim_ids: [] },
    });
    const f = find(repo, 'AUD-046');
    expect(f?.severity).toBe('warn');
    expect(f?.message).toContain('throwaway');
  });

  it('stays silent on a spike run whose prototype was never merged', () => {
    const repo = mk([{ key: 'a' }], 'spike');
    expect(find(repo, 'AUD-046')).toBeUndefined();
  });

  it('never fires on a feature run — merging back is the whole point there', () => {
    const repo = mk([{ key: 'a' }], 'feature');
    appendEvent(join(repo, '.team', 'runs', 'RUN-0001'), {
      event: 'task_integrated',
      actor: { type: 'agent', id: 'integrator' },
      run_id: 'RUN-0001',
      task_id: 'TASK-0001',
      payload: { merge_commit: 'abc1234', released_claim_ids: [] },
    });
    expect(find(repo, 'AUD-046')).toBeUndefined();
  });
});
