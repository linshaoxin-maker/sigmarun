import { EVENT_STATUS } from '@sigmarun/core';
import type { LedgerEvent } from '@sigmarun/core';

// Single source in core/state-machine (remediation E2); re-exported for existing consumers.
export { EVENT_STATUS };

/**
 * Ledger replay fold: the last state-bearing event per task wins (docs/17 §5.3 commit point;
 * docs/15 general principle 1: a transition without an event is an audit error).
 * Shared by repair (forward-roll) and AUD-034 (replay mismatch detection) — single source of truth.
 */


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
