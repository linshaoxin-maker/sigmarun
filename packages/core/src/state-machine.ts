/**
 * State-machine data tables (remediation E2, R3): the single source for status vocabularies and
 * the event->status fold map. Before this module, EVENT_STATUS lived in the audit package —
 * pulling a front-end (watch) into depending on the rule engine just to borrow one table — and
 * status literals were retyped per call site, which is how the integrating-phase filter shipped
 * 'verify' (not a TASK_TYPES member) and silently benched verification tasks for an entire phase.
 * The R4 reconciliation test holds these tables and docs/15's catalog to each other.
 */

export const RUN_STATUSES = ['planned', 'active', 'paused', 'integrating', 'reported', 'archived', 'cancelled'] as const;
export const RUN_TERMINAL = new Set<string>(['reported', 'archived', 'cancelled']);

export const TASK_STATUSES = [
  'draft', 'ready', 'claimed', 'working', 'blocked', 'submitted', 'reviewing',
  'changes_requested', 'approved', 'verified', 'integrated', 'done', 'cancelled',
] as const;

/** Task-claim lifecycle (docs/15 §4.1 + the D21-constitutionalized `completed`). */
export const TASK_CLAIM_STATUSES = ['active', 'submitted', 'completed', 'released', 'reclaimed', 'cancelled'] as const;

/** Gate-claim (review/verify lease) lifecycle. */
export const GATE_CLAIM_STATUSES = ['active', 'completed', 'released'] as const;

/**
 * Ledger fold map: the last state-bearing event per task wins (docs/17 §5.3 commit point;
 * docs/15 principle 1: a transition without an event is an audit error). Consumed by audit's
 * replay/repair AND watch's blocked-progress lookback — one table, not one per consumer.
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
