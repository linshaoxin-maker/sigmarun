import type { LedgerEvent } from '@sigmarun/core';

/**
 * Ledger replay fold: the last state-bearing event per task wins (docs/17 §5.3 commit point;
 * docs/15 general principle 1: a transition without an event is an audit error).
 * Shared by repair (forward-roll) and AUD-034 (replay mismatch detection) — single source of truth.
 */
export const EVENT_STATUS: Record<string, string> = {
  task_created: 'draft',
  task_published: 'ready',
  task_claimed: 'claimed',
  task_started: 'working',
  task_released: 'ready',
  task_reclaimed: 'ready',
  evidence_submitted: 'submitted',
  review_skipped: 'approved',
  review_claimed: 'reviewing',
  review_released: 'submitted',
  review_approved: 'approved',
  review_blocked: 'blocked',
  changes_requested: 'changes_requested',
  task_blocked: 'blocked',
  task_unblocked: 'working',
  verification_passed: 'verified',
  task_integrated: 'integrated',
  task_cancelled: 'cancelled',
  task_done: 'done',
};

const OWNER_SETTING = new Set(['task_claimed', 'task_started']);
const OWNER_CLEARING = new Set(['task_released', 'task_reclaimed', 'task_cancelled']);

export interface LedgerExpectation {
  status: string;
  owner: string | null;
  claim: string | null;
}

export function foldLedger(events: LedgerEvent[]): Map<string, LedgerExpectation> {
  const ledger = new Map<string, LedgerExpectation>();
  for (const e of events) {
    // Run-level verification failures name their tasks in payload.failures_mapped, not task_id.
    if (e.event === 'verification_failed') {
      const mapped = (e.payload?.failures_mapped as string[] | undefined) ?? (e.task_id ? [e.task_id] : []);
      for (const id of mapped) {
        const prev = ledger.get(id);
        ledger.set(id, { status: 'changes_requested', owner: prev?.owner ?? null, claim: prev?.claim ?? null });
      }
      continue;
    }
    const status = EVENT_STATUS[e.event];
    if (!status || !e.task_id) continue;
    const prev = ledger.get(e.task_id);
    const owner = OWNER_SETTING.has(e.event)
      ? ((e.actor as { id?: string } | undefined)?.id ?? null)
      : OWNER_CLEARING.has(e.event)
        ? null
        : (prev?.owner ?? null);
    const claim = OWNER_SETTING.has(e.event)
      ? ((e.claim_id as string | undefined) ?? null)
      : OWNER_CLEARING.has(e.event)
        ? null
        : (prev?.claim ?? null);
    ledger.set(e.task_id, { status, owner, claim });
  }
  return ledger;
}
