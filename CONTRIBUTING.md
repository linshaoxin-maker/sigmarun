# Contributing to sigmarun

Thanks for your interest. sigmarun is a repo-local coordination protocol plus a
gateway CLI for multiple AI coding agents (Claude Code, Codex) working on one
repository. This document explains how to build, test, and propose changes.

## Development setup

```bash
git clone <this-repo>
cd sigmarun
npm install          # installs the workspace packages
npm run build        # tsc -b across the 8 packages
npx vitest run       # the full test suite (should be all green)
```

Requirements: Node >= 20. The repo is an npm-workspaces monorepo built with
TypeScript project references (`tsc -b`) and tested with vitest.

## Architecture in one paragraph

Eight packages under `packages/`: `storage` (locks, atomic writes, rev
optimistic locking, redaction, path fences), `core` (init/doctor/import/publish/
submit/integrate/report/export + the event ledger), `dispatch` (claim engine,
review/verify gates, worktrees), `context` (messages, hydration, memory),
`adapters` (Claude command + Codex skill templates), `watch` (status/progress/
watch), `audit` (40-rule engine + repair/replay), `cli` (the single front-end).
The design corpus lives in `docs/` (numbered 00–25). The machine contract is
one envelope per command (`team.envelope.v1`) with a stable exit-code map
(`docs/17`).

## Ground rules for changes

1. **Every command returns exactly one envelope.** The CLI front-end holds no
   business rules — logic lives in the packages, the CLI parses argv and maps
   the reason code to an exit code (`docs/17 §2.2`).
2. **The event ledger append is the commit point.** Write order is
   detail → index → claims → derived artifacts, and `events.jsonl` is appended
   last. A transaction that fails before that append must leave no half-written
   state.
3. **State writes go through `writeJsonStateAtomic`** (temp-file + rename, rev
   bumped by one). Never write state files directly.
4. **Test-first for behavior changes.** Add a failing test, make it pass, keep
   the suite green. Regression locks for fixed bugs are expected.
5. **Reason codes are a contract.** A new reason code must be registered in the
   exit-code map (`packages/cli/src/cli.ts`) and `docs/17 §3`.

## Schema evolution

On-disk state under `.team/` is versioned as `team.<object>.v<major>` (e.g.
`team.run.v1`). The policy:

- **Additive changes are a minor bump — no version change on disk.** New optional
  fields must round-trip: readers preserve unknown fields, so an older gateway
  keeps working. Do not bump the major for additions.
- **A breaking on-disk change bumps the schema major, and ships *with* a
  migration.** When you change the shape in a way an older reader can't handle,
  register a migration from the previous major with `registerMigration('<object>',
  <fromMajor>, fn)` in `packages/storage/src/migrate.ts`. The migration is a pure
  in-memory transform to the next major.
- **Migration is automatic on read.** `readJsonState` upgrades an older doc in
  memory via the registered chain, so any newer gateway reads any older state; the
  file converges to the new major on its next write, or eagerly via
  `sigmarun migrate` (which backs up the originals first). A doc *newer* than the
  gateway understands is refused with `unsupported_schema_version` — there is no
  down-conversion.
- **Never bump a major without its migration.** A major with no registered
  migration from `major-1` makes every older file unreadable. The
  `currentSchemaMajor` of an object is defined as the highest major reachable by a
  contiguous chain of registered migrations from v1.

CLI semver tracks the code surface (commands, flags, envelope fields); the
`.team/` schema major tracks the on-disk contract. They can move independently.

## Submitting a change

- Branch from `main`, keep the diff focused.
- Run `npm run build && npx vitest run` before opening a PR — CI runs the same
  across Linux/macOS/Windows on Node 20 and 22.
- Describe what changed and why; link the relevant `docs/` section or an issue.
- Commit messages: imperative summary line; explain the "why" in the body.

## Releasing

The version lives in three synchronized spots — the root `package.json`, every
`packages/*/package.json`, and `GATEWAY_VERSION` in
`packages/core/src/envelope.ts`. `release:prepare` keeps them in lockstep and
cuts the changelog:

```bash
npm run release:prepare -- minor --dry-run   # preview the bump + changelog cut
npm run release:prepare -- minor             # apply it
npm install                                  # refresh the lockfile
npm run build && npx vitest run              # confirm green
git commit -am "release: vX.Y.Z" && git tag vX.Y.Z
git push --follow-tags
```

Pushing the `vX.Y.Z` tag triggers `.github/workflows/release.yml`, which builds,
tests, assembles the single publishable package (`npm run release`), and
publishes to npm **with provenance** on the `next` dist-tag. It requires an
`NPM_TOKEN` repository secret. After verifying the published tarball, promote it:
`npm dist-tag add sigmarun@X.Y.Z latest` (pre-1.0 ships `next`-first, docs/22 §4.1).

Publishing manually instead of via CI: `npm run release`, then
`cd release && npm publish --access public --tag next --provenance` (needs `npm login`).

## Reporting bugs / requesting features

Open an issue using the templates under `.github/ISSUE_TEMPLATE/`. For anything
security-sensitive, follow [SECURITY.md](SECURITY.md) instead of filing a public
issue.
