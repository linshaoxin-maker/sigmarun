import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { submitEvidence } from '@sigmarun/core';
import { dashboardState } from '../src/dashboard.js';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault, setupWorking } from '../../dispatch/test/fixture.js';
import { validDraft } from '../../core/test/submit-fixture.js';

/**
 * The dashboard needs-you panel renders statusRun's needs_user verbatim, so the AUD-041 item
 * only needs to survive the aggregation: dashboardState -> runs[].status.needs_user. The page's
 * generic renderer ([kind] detail + command) does the rest — no HTML change involved.
 */

let repo: string;
let agent: string;
beforeEach(async () => {
  repo = mkClaimRepo([{ key: 'a' }]);
  agent = registerDefault(repo);
  await setupWorking(repo, agent);
});
afterEach(() => cleanup(repo));

describe('dashboard state — handoff_unstructured reaches the needs-you panel data', () => {
  it('carries the item through runs[].status.needs_user', () => {
    const sub = submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: validDraft(repo, { handoff: 'done, see the diff.' }) });
    expect(sub.ok).toBe(true);
    const env = dashboardState({ cwd: repo });
    expect(env.ok).toBe(true);
    const runs = (env.data as { runs: Array<{ status: { needs_user?: Array<{ kind: string; task_id?: string }> } }> }).runs;
    const items = runs[0]!.status.needs_user ?? [];
    expect(items.some((n) => n.kind === 'handoff_unstructured' && n.task_id === 'TASK-0001')).toBe(true);
  });
});
