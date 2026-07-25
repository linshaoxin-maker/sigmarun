import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { submitEvidence } from '@sigmarun/core';
import { auditRun } from '@sigmarun/audit';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault, setupWorking } from '../../dispatch/test/fixture.js';
import { STRUCTURED_HANDOFF, validDraft } from '../../core/test/submit-fixture.js';

/**
 * AUD-041 handoff_unstructured — the audit backstop of the submit-time warning (docs/14 §2.4,
 * docs/18 §4.C). Same two shape heuristics as the inline half (shared handoffShapeProblems from
 * @sigmarun/core), re-applied to the STORED context/tasks/<TASK>.md so it also catches handoffs
 * that predate the guardrail or were gutted on disk after landing. Always warn, never error.
 */

let repo: string;
let agent: string;
beforeEach(async () => {
  repo = mkClaimRepo([{ key: 'a' }]);
  agent = registerDefault(repo);
  await setupWorking(repo, agent);
});
afterEach(() => cleanup(repo));

type Finding = { rule_id: string; severity: string; message: string; refs: string[] };
const aud041 = () =>
  ((auditRun({ cwd: repo, runId: 'RUN-0001' }).data as { findings: Finding[] }).findings ?? []).filter(
    (f) => f.rule_id === 'AUD-041',
  );
const submit = (handoff: string) =>
  submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: validDraft(repo, { handoff }) });

describe('AUD-041 handoff_unstructured (docs/18 §4.C; warn-only backstop)', () => {
  it('flags a landed one-liner handoff as warn — never error', () => {
    expect(submit('done, see the diff.').ok).toBe(true); // inline half warns but lands (docs/14 §2.4)
    const f = aud041();
    expect(f.length).toBe(1);
    expect(f[0]!.severity).toBe('warn');
    expect(f[0]!.message).toContain('TASK-0001');
    expect(f[0]!.refs).toContain('context/tasks/TASK-0001.md');
  });

  it('stays silent for a structured handoff', () => {
    expect(submit(STRUCTURED_HANDOFF).ok).toBe(true);
    expect(aud041()).toEqual([]);
  });

  it('catches a handoff gutted on disk after landing (backstop over the inline half)', () => {
    expect(submit(STRUCTURED_HANDOFF).ok).toBe(true);
    writeFileSync(join(repo, '.team', 'runs', 'RUN-0001', 'context', 'tasks', 'TASK-0001.md'), 'gutted.\n');
    const f = aud041();
    expect(f.length).toBe(1);
    expect(f[0]!.severity).toBe('warn');
  });

  it('does not fire while the task is still working (no evidence yet — AUD-011 territory)', () => {
    expect(aud041()).toEqual([]);
  });
});
