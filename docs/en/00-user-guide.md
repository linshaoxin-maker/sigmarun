# 00. User Guide

> Date: 2026-07-11
> Status: v0.2 (evolves with the implementation; this document is the draft for the future implementation repo's README)
> Audience: **users**, not protocol designers. It only covers how to use the system and what humans, coding agents, and the gateway are each responsible for.
> Naming: this document uses `sigmarun` (the `team <cmd>` in older design docs is equivalent to `sigmarun <cmd>`, D12).

---

## 1. What is this

**sigmarun lets you use multiple Claude Code and Codex windows at the same time in one project, collaborating like a small software team that has a task queue, work isolation, and a shared, replayable logbook.**

It is made up of four layers:

| Layer | What it does | How the user perceives it |
|---|---|---|
| Claude Code / Codex | Understand the project, break down tasks, write code, review, run tests | The AI coding tool you talk to |
| `/team-*` commands or Skills | Standardize the AI's collaboration steps and require it to call the gateway | The main control surface you type into the AI chat |
| `sigmarun` gateway CLI | Assign IDs, import tasks, atomic claims, conflict checks, evidence *recording*, state transitions, and audit | Called by the AI most of the time; you can also call it directly when troubleshooting |
| `.team/` | The local source of truth for collaboration in the current project | Usually not edited directly; state, evidence, and events can all be looked up |

sigmarun **is not a new AI**; it does not understand requirements or write code on its own — that work is still done by coding agents like Claude Code and Codex. Because it has no intelligence of its own, it also **cannot judge whether the evidence, reviews, and verifications you record are true** — it enforces *who may write what, in what order* (claims, path locks, state transitions) and keeps an auditable record, but the honesty of a submitted test run or the real independence of a review stays the agents' and your responsibility, not a guarantee the gateway makes. It also **does not depend on any centralized website or cloud service**. The optional future dashboard is only a read-only observation surface over `.team/`; it does not break down tasks, claim them, or modify state.

The boundary in one sentence:

> Coding agents provide the intelligence, Skills standardize the process, the gateway provides order, and `.team/` stores the facts.

### You stay in the loop

You don't watch every step, but you're not cut out of the decisions either. The installed `/team-*` commands make the agent **pause and ask you — with a short, researched choice, not a blank "what should I do?"** — at the real forks:

- **Planning**: it shows the task breakdown and waits for your OK before creating the run (no more "it already made the run").
- **Picking work**: it previews which task it would claim, and why, so you can let it proceed or point it elsewhere.
- **Red lines** (always pause, even on autopilot): merging onto the shared integration branch; taking over a crashed window's half-done work (continue it, or restart clean?); touching files outside a task's declared scope.
- **When stuck**: a check that keeps failing comes back with a diagnosis and options, instead of burning turns or silently giving up.

You control how much it checks in, in one sentence at any time: *"you drive it"* (autopilot — act and report), the default (pause at the forks above), or *"ask me each step"*. Note this is a property of how the **agent is instructed**, not something the gateway enforces — the gateway has no intelligence to know a fork is happening. It behaves the same in Claude Code and Codex.

One boundary to know: this pause-and-ask model assumes **one operator** driving all the windows. Several people operating the same run works at the coordination layer (claims and path locks don't care who you are), but "pause for the human" has no notion of *which* human — multi-person operation of a single run is outside the current design.

---

## 2. Installation and project onboarding

### 2.1 Install the CLI

Requires Node.js 20+ and Git. After the official npm release:

```bash
npm install -g sigmarun
```

To try the current version from the source repository:

```bash
npm install
npm run release
npm install -g ./release
```

### 2.2 Initialize the project

Go into the Git project you want to collaborate on:

```bash
cd your-project
sigmarun init
```

`init` only creates `.team/`, writes the project-level configuration, and checks `.gitignore`. It does not install the Claude Code or Codex command templates.

### 2.3 Install tool adapters

Install only the tools you actually use:

```bash
sigmarun adapter install --tool=claude-code
sigmarun adapter install --tool=codex
```

The adapter installs the `/team-*` commands or Skills into the current project and adds a managed protocol section to `AGENTS.md`. Adapter files are part of the project's collaboration configuration and can be reviewed and committed to Git; `.team/` itself is not committed.

Finally, run:

```bash
sigmarun doctor
```

Open Claude Code or Codex, type `/team-`, and once you can see the corresponding commands, project onboarding is complete.

---

## 3. Three objects to remember first

```text
Project
  RUN-0001       A single project goal, e.g. "Implement auth phase 1"
    TASK-0001    An engineering task that can be independently claimed, verified, and reviewed
    TASK-0002
    TASK-0003
```

- `RUN-ID` is the entry point for cross-tool, cross-window collaboration.
- `TASK-ID` is the unit of work for a single agent.
- `CLAIM-ID`, `AGENT-ID`, locks, and leases are mainly used for gateway audit; ordinary users usually do not need to manage them by hand.

---

## 4. The full journey of a feature

### 4.1 Plan: have a coding agent break down tasks

In any AI window that has the adapter installed, type:

```text
/team-plan "Implement auth phase 1"
```

This process has two layers:

1. Claude Code or Codex reads the project, historical memory, and test conventions, and breaks the work into a task DAG.
2. sigmarun validates the payload the agent generated, assigns the `RUN-ID` and `TASK-ID`s, and records them as a draft.

Example output:

```text
Created RUN-0001 (draft): Implement auth phase 1
TASK-0001 Add auth domain model
TASK-0002 Add session repository   (depends on TASK-0001)
TASK-0003 Add auth API tests       (depends on TASK-0001)
Next: /team-publish RUN-0001
```

sigmarun does not decide which tasks the work should be broken into; it only validates the format, registers the task graph, and returns stable IDs.

### 4.2 Publish: release the task queue

First check the goals, dependencies, acceptance criteria, and the paths allowed to be modified. Once confirmed:

```text
/team-publish RUN-0001
```

Publishing is an explicit human control point. Unpublished draft tasks cannot be claimed by other windows.

If the task graph only needs local adjustments, use `sigmarun task add` and `sigmarun task cancel` for controlled changes; if the goal or the breakdown needs a full redo, cancel or keep the current draft RUN, then run `/team-plan` again to create a new RUN. The current version has no `run amend` that silently overwrites an existing RUN. Do not edit `.team/` directly.

### 4.3 Dispatch: have multiple implementation windows claim tasks

In the Claude Code and Codex windows respectively, type:

```text
# Codex window
/team-dispatch RUN-0001 --as left

# Claude Code window
/team-dispatch RUN-0001 --as right
```

Each window will, in order:

1. Register its own agent identity.
2. Atomically claim an executable `TASK-ID` through the gateway.
3. Read the task's dependencies, messages, upstream handoffs, and project memory.
4. Run `git worktree add` as the gateway suggests, then have the gateway validate and register the worktree.
5. Write code, run tests, and commit in small steps inside the isolated worktree.
6. Submit evidence to the gateway, then stop and report back to you.

The responsibility boundary here is: **the worktree is created by the coding agent; the sigmarun gateway only suggests, validates, and registers — it does not run `git worktree add`.**

By default a window stops once it finishes one task. To allow it to claim tasks continuously, use:

```text
/team-dispatch RUN-0001 --as left --loop
```

To specify a task:

```text
/team-dispatch RUN-0001 --as left --task TASK-0003
```

If a task's dependencies are unfinished, it is already claimed, or paths conflict, the window returns the gateway's structured reason and stops — it will not switch tasks on its own.

### 4.4 Observe: check project progress at any time

```text
/team-status RUN-0001
```

You will see:

- Overall progress and the number of tasks in each state;
- The `TASK-ID` each agent is working on;
- Stale leases, path conflicts, blocks, and open questions;
- Ready for review / Ready for verify;
- Needs user, along with the suggested next-step command for each item.

When you need to keep watching:

```bash
sigmarun watch RUN-0001
```

`watch` reads the same `.team/` state each round, runs the lease-reclaim check, and refreshes progress. The future dashboard reads the same source of truth and only provides a more intuitive view of RUNs, the task DAG, agents, changed files, risks, and events — it adds no write path.

### 4.5 Submit: finishing the implementation is not finishing the task

The implementing agent must submit evidence, which at minimum contains:

- The files and commits actually modified;
- The commands run, their exit codes, and output references;
- The corresponding result for each acceptance criterion;
- The context read, remaining risks, and handoffs to downstream.

After a successful submission the task moves to `submitted`, awaiting independent review. An agent cannot just say "done" in chat, nor can it mark the task as done itself.

### 4.6 Review: an independent reviewer checks the implementation

Once `/team-status` shows Ready for review, run this in a window that never implemented the task:

```text
/team-review RUN-0001 TASK-0003 --as reviewer
```

The reviewer checks the diff, evidence, acceptance criteria, error paths, tests, and out-of-scope changes, then chooses:

- `approve`: proceed to independent verification;
- `request changes`: record a finding and send the task back into the change flow.

No agent may review or approve a task it once owned. By default the MVP does not require the reviewer window to wait from the start of the RUN; just start it when review is needed.

### 4.7 Verify: an independent verifier re-runs the checks

Passing review is not the same as passing verification. Use another window that has not owned the task:

```text
/team-verify RUN-0001 TASK-0003 --as verifier
```

The verifier must personally run the build, focused tests, regression tests, and scope check, and submit a verification record to the gateway. On success the task moves to `verified`; on failure it returns to the change flow, and the failure evidence is retained.

### 4.8 Integrate: the agent runs Git, the gateway records the result

Once all tasks ready for integration are verified:

```text
/team-integrate RUN-0001
```

The integrator agent will:

1. Get a deterministic integration order and an integration branch suggestion from the gateway.
2. Run `git checkout`, `git merge --no-ff`, and any necessary conflict handling itself.
3. Run checks after each merge and register the merge commit or the failure reason with the gateway.
4. Run full run-level verification and generate `integration.md` and `report.md`.

The sigmarun gateway does not run the Git merge for the agent, and it never merges into main automatically. In the end you review the integration branch and the report, then open a PR or merge by hand.

When you need to keep a record:

```bash
sigmarun export RUN-0001
```

The export is written to `docs/team-runs/` after a redaction check, for you to review and decide whether to commit.

---

## 5. Who acts when

| Phase | Primary actor | Does the user need to step in |
|---|---|---|
| Plan | The planning agent breaks down tasks, the gateway imports them | Check the task graph |
| Publish | The gateway publishes the ready queue | Must explicitly release |
| Dispatch / Execute | The implementer agent | Start the needed windows; handle questions and sensitive-path approvals |
| Submit | The implementer agent + the gateway evidence gate | Usually just read the report |
| Review | An independent reviewer agent | Start a reviewer when Ready for review |
| Verify | An independent verifier agent | Start a verifier when Ready for verify |
| Integrate | The integrator agent + gateway records | Review the report and decide whether to open a PR |
| Observe | status / watch / optional dashboard | Look anytime; does not change state |

The MVP is a "multi-window gateway" shape: the user is responsible for opening coding-agent windows, and sigmarun does not start or host Claude Code or Codex processes. Automatically launching and scheduling processes is a later local orchestrator capability.

---

## 6. Multiple RUNs, changes, and project memory

| What you want to do | Recommended action | Rule |
|---|---|---|
| Pursue another independent goal | `/team-plan "new goal"` | One RUN per goal; they can coexist in parallel |
| Avoid duplicate planning | Just re-import normally | The gateway uses a plan fingerprint to block duplicate imports |
| Two RUNs modify the same paths | Check the publish warning; enable a block policy if needed | Warns by default; can be configured to forbid cross-RUN path overlap |
| Pause an entire RUN | `sigmarun run pause RUN-0001` | Existing facts are kept; new normal progress stops |
| Resume a RUN | `sigmarun run resume RUN-0001` | Continue from the existing queue |
| Add or cancel a task | `sigmarun task add` / `sigmarun task cancel` | Record changes through the gateway; do not edit the ledger directly |
| The goal changes fundamentally | Create a new RUN | Do not quietly stuff another piece of work into the original RUN |

Each RUN's questions, decisions, and handoffs go into the message pool and run memory. Conclusions worth keeping long-term can be promoted to `docs/team/MEMORY.md` via `sigmarun memory promote`. That file goes into Git, and later planning and dispatch will read it; the runtime facts in `.team/` stay local to this machine.

---

## 7. Why they won't step on each other

| Defense | What it prevents | Mechanism |
|---|---|---|
| Atomic claim | Two windows claiming the same task | `claim-next` does the selection and write inside the run lock |
| Task lease | A crashed window holding a task forever | The heartbeat renews the lease; after it expires the task can be lazily reclaimed or explicitly reclaimed |
| Path reservation | Two tasks modifying the same range in parallel | Checks `paths.allow` against existing path claims at claim time |
| Identity cap | One window hoarding multiple implementation tasks | By default an agent can hold only one implementation task at a time |
| Evidence gate | An agent verbally declaring completion | Verifiable evidence must be submitted |
| Independent review / verify | Self-review, self-verification, and error propagation | The owner cannot approve or independently verify their own task |
| Events and audit | State files being bypassed or half-written | Event sequence, version numbers, and audit/repair reconciliation |

---

## 8. How to recover when things go wrong

| Symptom | Common cause | Action |
|---|---|---|
| Cannot claim a task | Empty queue, unfinished dependencies, path conflict, RUN paused | Check the returned `code` / `next_actions`, then look at `/team-status` |
| A task shows as held by a window for a long time | The agent exited or the lease expired | Wait for watch / the next claim to lazily reclaim it, or `sigmarun reclaim RUN TASK` |
| A previous agent left an unfinished worktree | The task was reclaimed | The new agent chooses `worktree adopt` to continue, or creates a new attempt |
| Review requests changes | The finding has been written to the message pool | The original implementer or a new implementer re-dispatches/resumes, makes changes, and submits again |
| Want to trace a specific task | You need the full facts | `/team-task RUN TASK`, `/team-evidence RUN TASK` |
| Suspect the ledger is inconsistent | An abnormal exit or manual edits | `sigmarun audit run RUN`; after confirming, run `sigmarun repair RUN` |
| Accidentally deleted `.team/` | The local source of truth was deleted | The current version cannot auto-recover from Git; a retained export can only be used for audit records, not for fully restoring the runtime state |
| Switching machines or a fresh clone | `.team/` is not in Git | The current version requires creating a new runtime state; cross-machine sync is a later capability |

---

## 9. Command quick reference

Ordinary users mainly use slash commands:

```text
Plan      /team-plan "<goal>" [--mode feature|debug|review]
Publish   /team-publish <RUN>
Work      /team-dispatch <RUN> [--as <window-name>] [--task <TASK>] [--loop]
Observe   /team-runs · /team-status <RUN> · /team-tasks <RUN>
Details   /team-task <RUN> <TASK> · /team-evidence <RUN> <TASK>
Gates     /team-review <RUN> [TASK] · /team-verify <RUN> [TASK]
Finish    /team-integrate <RUN>
```

Use the CLI for project maintenance and troubleshooting:

```text
Project   sigmarun init · adapter install · doctor
Runs      sigmarun run show|list|pause|resume|cancel|archive
Tasks     sigmarun task show|add|cancel|publish
Observe   sigmarun status|watch · worktree list · graph show
Recover   sigmarun reclaim|resume|unblock · audit run · repair
Archive   sigmarun report|export · memory candidates|promote
```

`claim-next`, `heartbeat`, `worktree register`, `submit`, `review claim`, `verify submit`, and `integrate record` are gateway primitives called by the adapter. Ordinary users usually do not need to compose them by hand.

For the full command contract, see [04 §1.1](04-command-workflows.md) (the slash side) and [17 §1](17-cli-mcp-contract-and-error-model.md) (the CLI side).

---

## 10. Current boundaries

- **Single-machine source of truth**: `.team/` is the local collaboration ledger; cross-machine/remote sync belongs to a later version.
- **Initial support for Claude Code + Codex**: tools like Cursor will connect to the same gateway protocol later.
- **Does not host agent processes**: the MVP does not automatically open Claude Code, Codex, or Cursor; users start the windows themselves.
- **Does not merge to main automatically**: the integrator agent only generates the integration branch and reports; the final merge is the user's decision.
- **Read-only dashboard**: the optional dashboard only displays RUNs, the DAG, agents, files, risks, messages, and events; it does not write `.team/`.
- **Cooperative trust + after-the-fact audit**: the goal is to constrain the AI's mistakes, forgetfulness, and overreach, not to defend against a deliberately malicious process that holds local file permissions.
