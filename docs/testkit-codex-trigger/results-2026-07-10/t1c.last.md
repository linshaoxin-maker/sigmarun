`RUN-0001` / `TASK-0042` under `CLAIM-task-0007` is submitted.

Changed: created `notes/hello.md` with exactly:

```text
hello team run
```

Workspace: `./.wt/TASK-0042`  
Branch: `team/RUN-0001/TASK-0042-hello-note`  
Commit: `72b517d [TASK-0042] Add hello note`

Verification passed: exact-content diff exited `0`, `git status --porcelain` in the task workspace was clean, and `team submit` returned `ok: true`, `status: submitted`, `revision: 1`.