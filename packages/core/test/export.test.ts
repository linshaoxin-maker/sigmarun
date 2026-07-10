import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportRun, submitEvidence } from '@sigmarun/core';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault, setupWorking } from '../../dispatch/test/fixture.js';
import { validDraft } from './submit-fixture.js';

let repo: string;
beforeEach(async () => {
  repo = mkClaimRepo([{ key: 'a' }]);
  const owner = registerDefault(repo);
  await setupWorking(repo, owner);
  submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: owner, evidencePath: validDraft(repo) });
});
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');

describe('export (16 §7; BDD-008-04/05; NFR-004 blocking rescan)', () => {
  it('exports the default set and prints the manifest (BDD-008-05)', () => {
    const env = exportRun({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);
    const data = env.data as { files: string[]; total_bytes: number; target: string };
    expect(data.files.some((f) => f.endsWith('plan.md'))).toBe(true);
    expect(data.files.some((f) => f.includes('evidence') && f.endsWith('evidence.md'))).toBe(true);
    expect(data.total_bytes).toBeGreaterThan(0);
    expect(existsSync(join(repo, 'docs', 'team-runs', 'RUN-0001', 'plan.md'))).toBe(true);
    expect(env.next_actions.some((a) => a.includes('git add'))).toBe(true);
  });

  it('aborts on a secret hit with export_redaction_hit and writes nothing (BDD-008-04)', () => {
    appendFileSync(join(runDir(), 'evidence', 'TASK-0001', 'evidence.md'), '\nleak ghp_0123456789abcdef0123456789abcdef0123\n');
    const env = exportRun({ cwd: repo, runId: 'RUN-0001', to: 'docs/team-runs/RUN-A' });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('export_redaction_hit');
    const hits = (env.data as { hits: Array<{ file: string; kinds: string[] }> }).hits;
    expect(hits.some((h) => h.file.includes('evidence.md') && h.kinds.includes('github_token'))).toBe(true);
    expect(existsSync(join(repo, 'docs', 'team-runs', 'RUN-A'))).toBe(false);
  });

  it('refuses a gitignored or .team target (export_target_invalid)', () => {
    writeFileSync(join(repo, '.gitignore'), '.team/\nignored-dir/\n');
    const ignored = exportRun({ cwd: repo, runId: 'RUN-0001', to: 'ignored-dir/out' });
    expect(ignored.code).toBe('export_target_invalid');
    const inTeam = exportRun({ cwd: repo, runId: 'RUN-0001', to: '.team/export' });
    expect(inTeam.code).toBe('export_target_invalid');
  });

  it('existing target needs --force', () => {
    exportRun({ cwd: repo, runId: 'RUN-0001' });
    const again = exportRun({ cwd: repo, runId: 'RUN-0001' });
    expect(again.code).toBe('export_target_invalid');
    const forced = exportRun({ cwd: repo, runId: 'RUN-0001', force: true });
    expect(forced.ok).toBe(true);
    expect(readFileSync(join(repo, 'docs', 'team-runs', 'RUN-0001', 'plan.md'), 'utf8').length).toBeGreaterThan(0);
  });
});
