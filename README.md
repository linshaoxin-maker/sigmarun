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
clobbered files, "done" with no evidence, no shared memory. sigmarun gives them
deterministic primitives to coordinate through — task claims with leases,
evidence gates, independent review/verify, topological integration — while the
agents keep doing the thinking.

## Install

```bash
npm i -g sigmarun     # Node >= 20
sigmarun --version
```

## Quick start

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
