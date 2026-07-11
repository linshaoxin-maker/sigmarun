# sigmarun

**Make multiple AI coding windows (Claude Code, Codex) collaborate on one repo like a small team.** sigmarun is a repo-local collaboration protocol plus a gateway CLI: coding agents supply the intelligence, the gateway supplies the order, and `.team/` in your repo is the single source of truth.

多个 AI 编程窗口像一个小团队一样协作同一个项目——repo-local 的 `.team/` 协作协议 + gateway CLI。

## What it does

- **Runs & tasks** — import a plan (task DAG with dependencies, priorities, path scopes), publish tasks, and let agents claim them with lease-based locks. No two agents step on the same files.
- **Evidence gates** — a task is only `submitted` with machine-checked evidence (changed files re-verified against scope, outputs redacted, acceptance mapped). No self-reported "done".
- **Review & verify** — independent reviewer and verifier roles with self-approval firewalls; failed verification maps back to rework automatically.
- **Integration** — deterministic topological merge order over real git worktrees; the gateway never touches your git history itself.
- **Audit & repair** — a 40-rule audit over the append-only event ledger; `repair` replays the ledger to roll damaged state forward.
- **Context plane** — per-run message pool (questions/blockers/decisions), context hydration for fresh agent windows, and promotable project memory.

## Install

```bash
npm i -g sigmarun     # Node >= 20
```

## Quick start (10 minutes)

```bash
cd your-repo
sigmarun init                 # creates .team/ (gitignored) + project scaffolding
sigmarun doctor               # 9-point self-check

# 1. Plan: have your planning agent write a run payload, then
sigmarun run import plan.json         # -> RUN-0001
sigmarun task publish RUN-0001        # draft -> ready

# 2. Dispatch: in each agent window
sigmarun agent register RUN-0001 --tool=claude-code --label=window-A
sigmarun claim-next RUN-0001 --agent=AGENT-claude-code-001
# ... agent works in the suggested git worktree, then submits evidence
sigmarun submit RUN-0001 TASK-0001 --agent=... --evidence=evidence.json

# 3. Watch: from anywhere
sigmarun status RUN-0001      # weight-based progress, risks, "needs you" items
sigmarun audit run RUN-0001   # 40-rule consistency audit, findings are data
```

Agent-side slash commands (`/team-plan`, `/team-dispatch`, `/team-review`, `/team-status`, …) install with:

```bash
sigmarun adapter install --tool=claude-code   # or --tool=codex
```

## Design

Every command emits exactly one machine-readable envelope (`team.envelope.v1`) on `--json`, with a stable exit-code map. All state lives in `.team/` as plain JSON + an append-only `events.jsonl`; the event append is the commit point of every transaction. Optimistic `rev` locking + directory locks make concurrent windows safe; the audit engine can replay the ledger and prove the state honest.

## Status

Early release (form A→B of the roadmap): protocol and full command surface are implemented and conformance-tested (214 tests, 40/40 audit rules). Interfaces may still move before 1.0.
