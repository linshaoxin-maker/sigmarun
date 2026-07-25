import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { submitEvidence } from '@sigmarun/core';
import { statusRun } from '@sigmarun/watch';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault, setupWorking } from '../../dispatch/test/fixture.js';
import { STRUCTURED_HANDOFF, validDraft } from '../../core/test/submit-fixture.js';

/**
 * needs-you surface of AUD-041 (docs/14 §2.4): the submit-time handoff_unstructured verdict was
 * persisted into the evidence_submitted payload exactly so read models can show it without
 * re-deriving. While the task sits in the review window (submitted/reviewing) the reviewer can
 * still force a rewrite cheaply — after that the panel stays quiet (audit AUD-041 keeps the
 * long-tail record). The item must ride BEHIND the gate item so the run's user_state stays
 * awaiting_gates, not needs_you.
 */

let repo: string;
let agent: string;
beforeEach(async () => {
  repo = mkClaimRepo([{ key: 'a' }]);
  agent = registerDefault(repo);
  await setupWorking(repo, agent);
});
afterEach(() => cleanup(repo));

type Item = { kind: string; task_id?: string; detail: string; command: string };
const needs = () => {
  const env = statusRun({ cwd: repo, runId: 'RUN-0001' });
  expect(env.ok).toBe(true);
  return { items: (env.data as { needs_user: Item[] }).needs_user, user_state: (env.data as { user_state: { state: string } }).user_state };
};
const submit = (handoff: string) =>
  submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: validDraft(repo, { handoff }) });

describe('needs-you — handoff_unstructured rides the review wait (AUD-041 surface)', () => {
  it('a submitted unstructured handoff yields the item, ordered behind the review gate', () => {
    expect(submit('done, see the diff.').ok).toBe(true);
    const { items, user_state } = needs();
    const gateIdx = items.findIndex((n) => n.kind === 'awaiting_review' && n.task_id === 'TASK-0001');
    const handIdx = items.findIndex((n) => n.kind === 'handoff_unstructured' && n.task_id === 'TASK-0001');
    expect(gateIdx).toBeGreaterThanOrEqual(0);
    expect(handIdx).toBeGreaterThan(gateIdx); // gate stays the primary item…
    expect(user_state.state).toBe('awaiting_gates'); // …so the run-level state is not hijacked
    expect(items[handIdx]!.detail).toContain('docs/14 §2.4');
    expect(items[handIdx]!.command).toBe('sigmarun evidence show RUN-0001 TASK-0001');
  });

  it('a structured handoff yields no item', () => {
    expect(submit(STRUCTURED_HANDOFF).ok).toBe(true);
    expect(needs().items.some((n) => n.kind === 'handoff_unstructured')).toBe(false);
  });

  it('legacy evidence_submitted events without the payload field stay silent (no retro-nagging)', () => {
    expect(submit('done, see the diff.').ok).toBe(true);
    const ledger = join(repo, '.team', 'runs', 'RUN-0001', 'events.jsonl');
    const lines = readFileSync(ledger, 'utf8').trim().split('\n').map((l) => {
      const e = JSON.parse(l) as { event: string; payload?: Record<string, unknown> };
      if (e.event === 'evidence_submitted' && e.payload) delete e.payload.handoff_unstructured;
      return JSON.stringify(e);
    });
    writeFileSync(ledger, lines.join('\n') + '\n');
    expect(needs().items.some((n) => n.kind === 'handoff_unstructured')).toBe(false);
  });
});
