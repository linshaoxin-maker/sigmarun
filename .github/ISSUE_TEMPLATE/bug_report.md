---
name: Bug report
about: A gateway command misbehaved, crashed, or produced wrong state
title: ''
labels: bug
---

**What happened**
A clear description of the bug.

**Command + envelope**
The exact `sigmarun` command you ran and the `--json` envelope it returned
(run with `--json` and paste it — never scrape the human text).

```json

```

**Expected**
What you expected instead.

**Environment**
- sigmarun version: `sigmarun --version`
- OS + Node: `node --version`
- Agent(s): Claude Code / Codex / other

**Repro / .team state (optional)**
Minimal steps to reproduce. If safe to share, the relevant `.team/runs/<RUN>/`
state or the `sigmarun audit run <RUN> --json` output helps a lot.
