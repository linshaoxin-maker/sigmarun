/**
 * Run mode capability object (docs/26; D21) — the ONLY branch point for lightweight vs full.
 *
 * Lightweight and full runs share one state machine and one engine; what differs is which
 * commands are open. Before this object existed the `lightweight` flag was consulted ad hoc
 * in four places while submit/review/verify/integrate silently accepted lightweight runs —
 * the S3 trap: one legal `submit` pushed a task to approved, where `done` no longer reaches
 * and the owner cannot verify (INV-008), stranding it. Commands now ask the mode, and a
 * walled command answers `mode_mismatch` with the in-mode alternative.
 */
export type RunModeKind = 'lightweight' | 'full';

export interface RunMode {
  kind: RunModeKind;
  can: {
    /** direct completion by the claim holder (`sigmarun done`) */
    done: boolean;
    /** evidence gate (`submit`) */
    submit: boolean;
    /** review gate (review claim/decide + reviewer synthesis) */
    review: boolean;
    /** verification gate (verify submit + verifier synthesis) */
    verify: boolean;
    /** integrate start/record */
    integrate: boolean;
    /** run terminal: `report` allowed from active once every task is terminal (D21) */
    reportWhenAllDone: boolean;
  };
}

export function resolveRunMode(run: { lightweight?: boolean }): RunMode {
  return run.lightweight === true
    ? {
        kind: 'lightweight',
        can: { done: true, submit: false, review: false, verify: false, integrate: false, reportWhenAllDone: true },
      }
    : {
        kind: 'full',
        can: { done: false, submit: true, review: true, verify: true, integrate: true, reportWhenAllDone: false },
      };
}
