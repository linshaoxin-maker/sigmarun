# sigmarun

**Make multiple AI coding windows (Claude Code, Codex) collaborate on one repo
like a small team.** sigmarun is a repo-local coordination protocol plus a
gateway CLI: the coding agents supply the intelligence, the gateway supplies the
order, and a `.team/` directory in your repo is the single source of truth.

> 让多个 AI 编程窗口（Claude Code、Codex）像一个小团队一样协作同一个项目。

**Status:** early release (`0.x`). The protocol and full command surface are
implemented and tested (build green, 40/40 audit rules, real cross-vendor
smoke runs). Interfaces may still move before 1.0.

## Why

Point two agent windows at the same repo and they collide: duplicate work,
clobbered files, no shared memory. **sigmarun's core job is to stop the
collision** — a task claim with a lease means no two windows grab the same
piece; a path claim means no two windows write the same file. That coordination
is *enforced*: the gateway computes it from the ledger, and no agent can fake it.

Everything the full pipeline adds on top — evidence, review, verify, integrate —
is **structured record-keeping, not a quality authority.** The gateway has no
intelligence of its own (the agents supply that, by design), so it cannot know
whether your tests really ran or your review was really independent; it records
what you *claim*, in order, on an append-only ledger you can replay and audit.
Treat the pipeline as a shared logbook that keeps windows from colliding — not
as a guarantee that the work behind an entry is correct. The judgment stays with
you and the agents; the gateway keeps the order.

## Demo — a 60-second lightweight run

Two agent windows split one goal, each claims a piece and marks it done, the run
closes itself, and the audit comes back clean. This is the whole loop:

```console
$ sigmarun init --example
Initialized .team coordination directory.

$ sigmarun run import sigmarun-plan.example.json --lightweight
Imported RUN-0001 with 2 task(s), claimable now (lightweight).

$ sigmarun claim-next RUN-0001 --agent=win-1        # window 1 grabs a piece
Claimed TASK-0001 ("First piece") ...
  next: Do the work, then mark it done: sigmarun done RUN-0001 TASK-0001 --agent=win-1

$ sigmarun done RUN-0001 TASK-0001 --agent=win-1
TASK-0001 done (was claimed).

$ sigmarun claim-next RUN-0001 --agent=win-2        # window 2 grabs the other
Claimed TASK-0002 ("Second piece") ...

$ sigmarun done RUN-0001 TASK-0002 --agent=win-2
TASK-0002 done (was claimed); every task is now closed.
  next: Close the run: sigmarun report RUN-0001

$ sigmarun report RUN-0001
Run RUN-0001 reported (lightweight): 2 done, 0 cancelled.

$ sigmarun audit run RUN-0001
Audit of RUN-0001: 0 error, 0 warn, 6 info; 40 rule(s) run.    # clean — the 6 info are lightweight waivers
```

▶ **Dynamic replay:** the real recording is [`docs/demo.cast`](docs/demo.cast) —
`npm i -g asciinema && asciinema play docs/demo.cast`, or `asciinema upload docs/demo.cast`
to get an embeddable player. Full pipeline (evidence → review → verify → integrate) is below.

## Install

```bash
npm i -g sigmarun          # Node >= 20
sigmarun --version

# or build from source:
# git clone https://github.com/linshaoxin-maker/sigmarun && cd sigmarun
# npm install && npm run release && npm i -g ./release/*.tgz
```

## Quick start (lightweight — the 5-command loop)

```bash
cd your-repo
sigmarun init --example          # .team/ (gitignored) + sigmarun-plan.example.json
sigmarun run import sigmarun-plan.example.json --lightweight   # tasks claimable now
sigmarun claim-next RUN-0001 --agent=win-1    # any fresh name self-registers
# ...do the work...
sigmarun done RUN-0001 TASK-0001 --agent=win-1
sigmarun report RUN-0001         # once every task is done -> run closes
```

Prefer a sentence over JSON? `sigmarun adapter install --tool=claude-code`
and type `/team-plan <goal>` then `/team-do` in Claude Code — the AI writes
the payload and drives the CLI. See [docs/26](docs/26-lightweight-mode.md).

## Quick start (full pipeline — evidence, review, verification, integration)

```bash
cd your-repo
sigmarun init                    # creates .team/ (gitignored) + scaffolding
sigmarun doctor                  # 10-point self-check
sigmarun adapter install --tool=claude-code   # or --tool=codex

# Plan a run (a planning agent writes the payload), then:
sigmarun run import plan.json    # -> RUN-0001
sigmarun task publish RUN-0001   # draft -> ready

# In each agent window (the installed /team-* commands drive these):
sigmarun agent register RUN-0001 --tool=claude-code --label=window-A
sigmarun claim-next RUN-0001 --agent=<AGENT-ID>
# ... agent works in the suggested git worktree, runs tests, then:
sigmarun submit RUN-0001 TASK-0001 --agent=<AGENT-ID> --evidence=evidence.json

# From anywhere:
sigmarun status RUN-0001         # weight-based progress, risks, "needs you"
sigmarun audit run RUN-0001      # 40-rule consistency audit, findings are data
sigmarun events RUN-0001         # read the append-only ledger as a timeline
sigmarun --help                  # the full command map
```

Agents drive this through installed slash commands / skills — `/team-plan`,
`/team-dispatch`, `/team-review`, `/team-verify`, `/team-status`,
`/team-integrate` (Claude Code) or the matching `team-run-*` Codex skills.

## How it works

- **State** lives in `.team/` as plain JSON plus an append-only `events.jsonl`.
  The event append is the commit point of every transaction.
- **Every command** emits exactly one machine envelope (`team.envelope.v1`) on
  `--json`, with a stable exit-code map. Agents branch on `ok` / `code` /
  `next_actions`, never on human text.
- **Concurrency** is safe through optimistic `rev` locking plus directory locks;
  the audit engine can replay the ledger and prove the on-disk state honest.
- **The gateway never touches your git history** — it records merge commits you
  make on an integration branch; you open the final PR.

## What's not here yet

- No MCP server front-end (`mcp serve`) — the CLI is the interface today. It is a
  planned form, not a regression.
- Semantic search / cross-run remote sync are future phases.

## Documentation

The full design corpus (product boundary, domain model, state machine, CLI/MCP
contract, audit catalog, packaging) lives under [`docs/`](docs/) (numbered
00–25). English is available for the two entry docs, with the rest of the
corpus in Chinese and translation ongoing:

- **User Guide** — [English](docs/en/00-user-guide.md) · [中文](docs/00-user-guide.md)
- **CLI / MCP Contract & Error Model** — [English](docs/en/17-cli-mcp-contract-and-error-model.md) · [中文](docs/17-cli-mcp-contract-and-error-model.md)

New to sigmarun? Start with the User Guide.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for build/test setup and the ground rules.
Security reports: [SECURITY.md](SECURITY.md). Community expectations:
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © Lin Shaoxin
