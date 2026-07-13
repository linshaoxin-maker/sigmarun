# 17. CLI / MCP Contract and Error Model

> Date: 2026-07-09
> Status: v0.1 design draft
> Basis: [13](13-design-audit-and-next-breakdown.md) M16–M20, adjudication §5.5, decision D3 (TS/Node), D14 (passive CLI + watch into MVP), Appendix B F3 (rev optimistic lock); the commands and errors introduced by [14](14-evidence-review-verification-contract.md) / [15](15-run-task-state-machine-and-lifecycle.md) / [16](16-git-worktree-and-team-root.md)
> Goal: a unified contract across all commands — command table, return envelope, reason code, exit code, lock and atomic-write implementation, ID allocation, `team watch` / `init` / `doctor` specs, MCP mapping, test strategy. The adapter (doc 19) is only permitted to depend on this contract to parse output.

---

## 1. Command Table

> **Notation convention (D12 final adjudication)**: the official npm package name and bin are both **`sigmarun`**; this document set continues to use the `team <cmd>` shorthand, which is always equivalent to `sigmarun <cmd>`. The protocol directory name `.team/` does not change with the CLI name.

Legend: write = a state change requiring a lock; read = lockless read-only; blank MVP column = P1.

| Command | Read/Write | Lock | MVP | Owning capability |
|---|---|---|---|---|
| `team init` | write | project | ✓ | Record |
| `team doctor` | read | — | ✓ | Ops |
| `team run import <payload>` | write | project + run | ✓ | Record |
| `team run show <RUN>` | read | — | ✓ | Record |
| `team run list` | read | — | ✓ | Record |
| `team run pause / resume <RUN>` | write | run | ✓ | Dispatch |
| `team run cancel <RUN>` | write | run | ✓ | Dispatch |
| `team run archive <RUN>` | write | run | ✓ | Record |
| `team task list <RUN> [--status --owner --type]` | read | — | ✓ | Record |
| `team task show <RUN> <TASK>` | read | — | ✓ | Record |
| `team evidence show <RUN> <TASK>` | read | — | ✓ | Record (existing in [03](03-team-task-list-and-task-schema.md) §10, now formally incorporated; the underlying layer of `/team-evidence`) |
| `team task publish <RUN> [--tasks --all]` | write | run | ✓ | Record |
| `team task cancel <RUN> <TASK>` | write | run | ✓ | Record |
| `team agent register <RUN> [--label <window-name>]` | write | run | ✓ | Dispatch (**label idempotent**: within the same run, an active registration under the same name returns the same AGENT-ID, D17) |
| `team claim-next <RUN> [--role --capability --task --dry-run]` | write | run | ✓ | Dispatch |
| `team heartbeat <RUN> <TASK>` | write | run | ✓ | Dispatch |
| `team release <RUN> <TASK>` | write | run | ✓ | Dispatch |
| `team reclaim <RUN> <TASK>` | write | run | ✓ | Dispatch |
| `team block / unblock <RUN> <TASK>` | write | run | ✓ | Dispatch |
| `team worktree register / adopt / list <RUN>` | write/read | run | ✓ | Record |
| `team submit <RUN> <TASK> --evidence <file>` | write | run | ✓ | Record/Audit |
| `team review claim / approve / request-changes / block <RUN> <TASK>` | write | run | ✓ | Audit |
| `team verify <RUN> [--task <TASK>] --record <file>` | write | run | ✓ | Audit |
| `team approve-paths <RUN> <TASK> --paths` | write | run | ✓ | Dispatch |
| `team integrate start <RUN>` / `team report <RUN>` | write | run | ✓ | Record |
| `team message post / list`, `team question list` | write/read | run (post) | ✓ | Context |
| `team graph show / validate <RUN>` | read | — | ✓ | Context |
| `team context hydrate <RUN> <TASK>` | write (events) | run | ✓ | Context |
| `team memory update / show <RUN> [--task]` | write/read | run | ✓ | Context |
| `team memory promote --run <RUN> --from <ref> --entry ...` | write | project + target file | | Context (L4 promotion, requires user confirmation; [25](25-project-memory-and-knowledge-promotion.md) §4, P1/Slice 10) |
| `team progress <RUN>` | write (derived files) | run | ✓ | Progress |
| `team audit run / task / claims / paths / evidence / progress` | read | — | ✓ | Audit |
| `team repair <RUN>` | write | run + backup | ✓ | Ops (§5.3, M30) |
| `team export <RUN> [--to --full --force]` | read (writes to a repo directory) | — | ✓ | Record |
| `team watch <RUN> [--interval]` | read + periodically triggered sweep | run when triggered | ✓ (D14) | Progress |
| `team task add` (add tasks after import) | write | run | | Record |
| `team migrate` | write | project + run | | Ops ([21](21-schema-versioning-and-migration.md)) |
| `team backup [--to <dir>]` (supports directories outside the repo, M37) | read (writes to the backup directory) | — | | Ops ([22](22-packaging-installation-and-evolution.md)) |
| `team deinit` (zero deletion: only provides a cleanup checklist and confirmation, M43) | read | — | | Ops ([22](22-packaging-installation-and-evolution.md)) |
| `team adapter install` (form B installs templates) | writes repo files | — | | Distribution ([22](22-packaging-installation-and-evolution.md)) |

Convention: all task-level commands **must supply both RUN and TASK** (E6 adjudication, TASK-ID is run-scoped).

---

## 2. Global Return Envelope

### 2.1 Structure

Under `--json`, stdout outputs **a single JSON object** (human-readable format is the default; **adapters must use `--json`**):

```json
{
  "ok": false,
  "code": "path_conflict",
  "message": "TASK-0003 paths overlap with active claim held by TASK-0002.",
  "data": {
    "candidate_task_id": "TASK-0003",
    "blocked_by": [
      { "task_id": "TASK-0002", "agent_id": "AGENT-claude-001", "paths": ["src/auth/**"] }
    ]
  },
  "warnings": [],
  "next_actions": [
    "wait for TASK-0002 to submit",
    "team status RUN-0001",
    "ask user to run: team approve-paths ..."
  ],
  "meta": {
    "gateway_version": "0.1.0",
    "envelope_version": "team.envelope.v1",
    "run_id": "RUN-0001",
    "elapsed_ms": 42
  }
}
```

Rules:

1. When `ok=true`, `code` is fixed to `"OK"`; when `ok=false`, `code` must be one of the §3 enumeration.
2. The structure of `data` depends on the command, but each command's data schema is fixed and versioned (tracking envelope_version).
3. `next_actions` are strings that are **directly executable or can be relayed verbatim to the user** — they are the branching basis for the adapter's fixed workflow (the globalization of [08](08-core-gateway-capabilities.md) §4.6).
4. `warnings[]` elements have the structure `{code, message, refs?}` and do not affect `ok`.
5. Diagnostic information goes to stderr; stdout always contains only the envelope (pipe-safe).
6. Error message **does not echo file contents** (to prevent secrets from leaking into logs, [24](24-security-permissions-and-data-hygiene.md)).

### 2.2 Exit code

| exit | Meaning | Corresponding code class |
|---|---|---|
| 0 | Success (including dry-run) | OK |
| 2 | Usage error (missing argument / malformed) | usage_error |
| 3 | Lock timeout | lock_timeout |
| 4 | Validation failure | schema_invalid / evidence_invalid / payload_* |
| 5 | Target does not exist | *_not_found |
| 6 | Conflict | task_already_claimed / path_conflict / rev_conflict / requires_approval / no_claimable_task / deps_blocked / capability_mismatch / parallel_limit_reached / agent_claim_limit (the BR-001 guard family is unified to 6, backfilled in the 2026-07-11 functional-test round) |
| 7 | State machine rejection | invalid_transition / run_paused / run_not_active |
| 8 | Storage/environment error | io_error / not_a_git_repo / team_root_not_found / unsupported_schema_version |
| 1 | Other failure | catch-all |

---

## 3. Reason Code Enumeration (Unified Across All Commands)

| code | Semantics | Main source commands | next_actions must include |
|---|---|---|---|
| `run_not_found` / `task_not_found` / `agent_not_registered` | Target missing | all | the correct query command |
| `run_not_active` / `run_paused` | run state does not permit it | claim-next, publish | resume / status command |
| `no_claimable_task` | queue empty | claim-next | status; wait suggestion |
| `deps_blocked` / `capability_mismatch` / `parallel_limit_reached` | claim filtering failed | claim-next | the specific blocking item |
| `agent_claim_limit` | the agent already holds an active claim (`max_active_claims_per_agent`, default 1; M36/D17) | claim-next | first submit / release the current task |
| `cross_run_conflict` | intersects the paths of another active run and `cross_run_path_policy=block` (D18) | task publish, claim-next | change paths / `--force` / wait for the other run to wrap up |
| `task_already_claimed` | task already claimed | claim-next --task | a hint listing claimable tasks |
| `path_conflict` | path occupancy conflict | claim-next | blocked_by details (§2.1 example) |
| `requires_approval` | hit a path requiring approval | claim-next, submit | `team approve-paths` command template |
| `claim_not_found` | target task has no active claim (exit 5; name finalized and backfilled during FEAT-004 implementation) | heartbeat, release, reclaim | query the current claim status |
| `not_claim_owner` | the claim belongs to someone else; renewing the lease / releasing is refused (exit 6; name finalized and backfilled during FEAT-004 implementation) | heartbeat, release | hint of the holder's identity; a non-owner should use reclaim |
| `lock_timeout` | lock not acquired | all write commands | retry suggestion + `team doctor` |
| `rev_conflict` | optimistic-lock version mismatch (suspected direct file edit bypassing the CLI) | all write commands | `team audit run` |
| `invalid_transition` | state machine rejection (including actor identity mismatch) | state commands | current state + list of legal transitions |
| `evidence_invalid` | evidence validation failed | submit | each missing item, itemized ([14](14-evidence-review-verification-contract.md) §2.3) |
| `memory_entry_invalid` | L4 promotion entry is invalid (no refs / refs stale / hits a secret / dangling supersedes) | memory promote | [25](25-project-memory-and-knowledge-promotion.md) §4/§6 |
| `duplicate_payload` | plan fingerprint matches an existing run (D17 de-duplication; exit 6 conflict class; backflowed in during FEAT-002 implementation) | run import | view the existing run / explicitly bypass with `--force` |
| `self_approval_forbidden` | the reviewer is a past owner | review claim/approve | hint to switch reviewer |
| `schema_invalid` / `unsupported_schema_version` | input or stored-file version problem; for the latter, `data.kind` ∈ `gateway_too_old` / `migration_required` / `unknown_major` ([21](21-schema-versioning-and-migration.md) §4.1) | import, all reads | upgrade/migration guidance ([21](21-schema-versioning-and-migration.md)) |
| `not_a_git_repo` / `bare_repo_unsupported` / `team_root_not_found` | environment problem | all | `team doctor` |
| `worktree_missing` / `worktree_dirty` | worktree anomaly | register/adopt/remove suggestion | [16](16-git-worktree-and-team-root.md) §8 recovery path |
| `export_target_invalid` / `export_redaction_hit` | export rejected | export | list of hits / --to correction |
| `backup_target_invalid` | backup target is invalid (inside `.team/` or not writable) | backup | --to correction ([22](22-packaging-installation-and-evolution.md)) |
| `path_escape_detected` | path escapes beyond the repo/worktree root under realpath validation (symlink escape, [24](24-security-permissions-and-data-hygiene.md) §6; this row also carries out the doc 24 §9 revision instruction) | submit, export, worktree register | correct the path; `team audit paths` |
| `usage_error` / `io_error` | catch-all | all | — |

A new reason code must be registered simultaneously in this table + the exit code mapping + the adapter branching suggestion; missing any one is treated as a contract breach (audit rule).

---

## 4. Lock Implementation (D3 selection, closing [10](10-claim-next-lock-and-conflict-rules.md) open items 1/2)

| Item | Decision |
|---|---|
| Mechanism | **lock directory**: `mkdir` atomicity (universal across POSIX/Windows), writing `meta.json` inside the directory (pid, agent_id, command, acquired_at, gateway_version) |
| Two locks | `.team/locks/project.lock/` (run creation and project-level ID allocation, M19); `.team/runs/<RUN>/locks/run.lock/` (all write transactions within a run) |
| Acquisition | exponential backoff retry (starting at 50ms, ×2, capped at 1s), default total timeout 5s → `lock_timeout` |
| stale lock | `meta.json.acquired_at` exceeding `lock_stale_ms` (default 30s, configured separately from the lease — closing doc 10 open item 3) → preemption is allowed: **atomic takeover first** (rename the old lock directory to `run.lock.taken-<ts>` to preserve evidence + mkdir the new lock); the **first event** of the lock transaction after a successful takeover writes `lock_takeover` (containing the old meta and the evidence path) — appending the event itself requires holding the lock, and the order must not be reversed (2026-07-10 review correction) |
| Lock discipline | inside the lock, only read-file → compute → write-file; **forbidden** to execute git/network/project commands inside the lock |
| Crash recovery | lock directories left behind by dead processes are reclaimed by the stale mechanism; half-written files are prevented by atomic writes (§5) |

jsonl appends such as `message post` likewise go through run.lock (M20 closed): append inside the lock + allocate MSG-ID, avoiding cross-platform O_APPEND semantic differences.

---

## 5. Atomic Write and `rev` Optimistic Lock (Appendix B F3 implementation)

### 5.1 Atomic Write

```text
Write JSON:  write <file>.tmp-<pid> -> fsync(file) -> rename to overwrite
Write jsonl: inside the lock, write the whole line in append mode + '\n', with seq embedded in the line
MVP does not fsync the directory (recorded as a known trade-off; in an extreme power-loss scenario the last rename may be lost — audit can detect the inconsistency and rebuild the derived files)
```

### 5.2 `rev` Field

All **mutable JSON state files** (task-list, task.json, the claims triplet, path-approvals, worktrees.json, agents/*.json, evidence/*/evidence.json, counters) uniformly carry:

```json
{ "rev": 12, "updated_at": "2026-07-09T19:30:00+08:00", "...": "..." }
```

Rules:

1. The write transaction performs `read rev -> mutate -> write rev+1` inside the lock.
2. The lock guarantees the normal path never conflicts; the role of `rev` is to **detect abnormal paths** — a direct edit bypassing the CLI (rev not incremented per the rule / updated_at going backwards) is reported as `rev_conflict`/`direct_state_edit_suspected` in the next write transaction or in `team audit`.
3. append-only files (events, messages) do not use rev; they use an **in-line seq**: each line of `events.jsonl` contains `seq` (monotonic within a run; the counter is stored in `events.meta.json` and incremented inside the lock); a gap in the sequence is audit evidence.
4. The payload of write-transaction-class events carries `rev_after` (the new rev of each state file written by this transaction), serving as the rev reconciliation input for audit ([18](18-audit-rule-catalog-and-trust-model.md) §3).

### 5.3 Cross-file Transactions: Write Order, Commit Point, and Repair (M30 adjudication implementation)

Single-file atomicity (§5.1) is not the same as transaction atomicity — a single write transaction touches multiple files, and a crash may stop in the middle. Conventions:

1. **Canonical write order**: state files are written in the order "detail → index → claims → derived artifacts", and **the `events.jsonl` append is always last — it is the commit point**. If the event is present, the transaction holds; if the event is absent, any already-written state is uniformly treated as uncommitted residue.
2. **Crash semantics**: crash before the event → residue does not match the ledger (detected by the AUD consistency matrix + `rev_after` reconciliation), handled as uncommitted; crash after the event → the transaction holds, and any missing derived artifact is simply recomputed.
3. **`team repair --run <RUN>`**: a mechanical repair primitive — comparing file by file against the events ledger (including `rev_after`): uncommitted residue is **rolled back**, committed-but-missing derived artifacts are **rolled forward and recomputed**; idempotent; automatically backs up before execution (reusing the [21](21-schema-versioning-and-migration.md) §5 backup mechanism); the repair action writes a `state_repaired` event; anything it cannot fix is listed as findings for manual handling. From now on, audit is "both testable and repairable".

---

## 6. ID Allocation

| ID | Counter location | Protecting lock |
|---|---|---|
| `RUN-ID` | `.team/counters.json` | project.lock |
| `TASK-ID` / `CLAIM-*` / `MSG-*` / `REVIEW-*` / `VERIFY-*` / `EDGE-*` / `WT-*` | `runs/<RUN>/counters.json` | run.lock |

Format regexes (for validation): `RUN-\d{4}`, `TASK-\d{4}`, `CLAIM-(task|path|review)-\d{4}`, `MSG-\d{4}`, `REVIEW-TASK-\d{4}-\d{2}`, `VERIFY-\d{4}`, `AGENT-[a-z0-9-]+-\d{3}`. IDs only increase and are never reused; deleting a run does not reclaim its number range.

---

## 7. `team watch` Spec (D14 implementation)

```text
team watch RUN-0001 [--interval 30] [--once]
```

| Rule | Content |
|---|---|
| Loop body | every interval seconds: ① acquire run.lock and perform one sweep (expired-claim handling, auto-reclaim decision — the same code as claim-next's sweep) ② recompute progress without a lock ③ print the status delta (new events, new risks, progress changes) |
| Read-only nature | apart from the reclamation-class state changes triggered by the sweep (which are themselves the legitimate authoritative operations specified by D9), it makes no writes; **it does not dispatch work, does not claim, does not submit** |
| Single instance | `runs/<RUN>/locks/watch.lock` (advisory): a second watch warns and exits on startup; `--force` can bypass it |
| Exit | automatically exits when the run enters a terminal state (reported/archived/cancelled); `--once` runs a single round (for external cron invocation) |
| Output | human-readable by default; with `--json` it outputs an NDJSON event stream (line = `team.event.v1` event line + periodic snapshot line; [23](23-dashboard-information-architecture.md) §6 has adjudicated that the dashboard MVP uses file polling and does not depend on this stream; the formal line contract will be finalized with the read-model in P2) |

---

## 8. `team init` / `team doctor`

| Command | Content |
|---|---|
| `init` | creates `.team/` (project.json, counters.json, templates/, locks/); appends `.team/` to `.gitignore` ([16](16-git-worktree-and-team-root.md) §1.1); if already initialized, idempotently returns the current state |
| `doctor` | checks and reports item by item: git repo and common-dir resolution, team root consistency (main checkout vs worktree), Node version, lock availability (create-lock/delete-lock self-test), schema version matrix ([21](21-schema-versioning-and-migration.md)), leftover tracked `.team/`, dangling lock directories, count of abandoned worktrees |

---

## 9. MCP Mapping (form C reserved, D1)

| Principle | Content |
|---|---|
| Same core | the MCP server and the CLI link the same core library (the container boundary in the doc 20 C4), with tools mapping one-to-one to primitives: `team_claim_next`, `team_submit_evidence`… (naming follows [07](07-skill-plugin-execution-form.md) §2C) |
| Same contract | the structured content of the tool result is exactly the §2 envelope; reason code and next_actions are completely identical — an adapter migrating from CLI to MCP does not change its branching logic |
| Lifecycle | the stdio MCP server follows the agent session (consistent with Claude Code behavior); while the server is resident it may optionally build in a watch loop (D14's form C path) |
| Concurrency | the server internally still goes through file locks — **multiple server instances (multiple sessions) coexisting is the norm**; one must not assume single-instance exclusivity |

---

## 10. Gateway Self-Test Strategy (doc 13 P0 commitment + host for the Appendix B acceptance cases)

| Category | Test cases |
|---|---|
| Concurrency | 16 concurrent claim-next calls (same run): zero double-claims, claims file rev strictly increasing, events seq with no gaps |
| Crash injection | kill -9 during a write transaction (after the tmp write / before and after the rename): after restart there are no half-written files, and audit either passes or can detect and rebuild the derived files |
| Lock | a lock-holding process is killed → after 30s another process takes over and leaves a `lock_takeover` event |
| Failure-mode regression | one end-to-end test case for each of the five Appendix B scenarios F1–F5 (referencing the "acceptance case" column of [13](13-design-audit-and-next-breakdown.md) Appendix B) |
| Contract regression | at least one triggering test case per reason code, asserting the envelope structure + exit code mapping |
| Cross-platform | locks / atomic writes / path normalization run on all three CI platforms: macOS, Linux, Windows |

---

## 11. Schema Version Handshake (minimum rules; full text belongs to [21](21-schema-versioning-and-migration.md))

1. Reading any `.team` file: if the `schema_version` major is unrecognized → `unsupported_schema_version` (exit 8), prompting `team migrate` or a gateway upgrade.
2. Minor-level added fields: on read, **preserve unknown fields** and write them back as-is (forward-compat).
3. `project.json.min_gateway_version`: a gateway below this version refuses write operations (to prevent an old tool from corrupting new state).

---

## 12. MVP Acceptance Scenarios

| Scenario | Expectation |
|---|---|
| Any command's `--json` output | a single valid envelope, with no JSON pollution on stderr |
| An unregistered agent claims directly | `agent_not_registered`, exit 5, next_actions includes the register command |
| Executing a write command after manually editing task-claims.json | `rev_conflict` or audit `direct_state_edit_suspected` |
| Operating again 35s after the lock-holding process is killed | takeover succeeds and the event is queryable |
| An agent disconnects for 3×TTL while watch is running | the next sweep round auto-reclaims, and watch prints a reclamation notice |
| Concurrent claim on Windows | behavior is consistent with macOS (guaranteed by CI) |
| doctor runs in a polluted repository (tracked .team) | clear report + repair guidance |

---

## 13. Revision Instructions for Existing Documents

| Document | Revision |
|---|---|
| [04](04-command-workflows.md) | converge the primitive list to the §1 command table as authoritative |
| [07](07-skill-plugin-execution-form.md) | align the §2C MCP tool surface with §9; add the envelope/next_actions mechanism to the "skill ignored" row of the risk table |
| [08](08-core-gateway-capabilities.md) | §4.6 structured failure is upgraded to the global §2 envelope; the §7 MVP command surface is replaced with §1 |
| [10](10-claim-next-lock-and-conflict-rules.md) | the §5 lock rule table is replaced with §4; open items 1/2/3 closed |
| [15](15-run-task-state-machine-and-lifecycle.md) | the envelope/reason code of the new primitives follow this document as authoritative |

---

## 14. Interfaces Deferred to Other Documents

- The authoritative/derived field matrix is already implied by the rev coverage; the revision that removes status from the graph node is carried out with the doc 12 revision pass (13 §5.5)
- component interface signatures (claim-engine, lock-manager, storage, audit engine) → [20](20-c4-l2-l3-component-contracts.md)
- full version-migration strategy → [21](21-schema-versioning-and-migration.md)
- envelope human-readable copy and error phrasing → doc 19 adapter
- error-output redaction details → [24](24-security-permissions-and-data-hygiene.md)
