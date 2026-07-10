# 03. Team Task List and Task Schema

> 目标：把 `RUN-ID -> team-task-list -> TASK-ID -> task detail` 的骨架定义清楚。

---

## 1. 为什么需要 `team-task-list.json`

如果任务只散落在 `tasks/TASK-0001/task.json`，查询状态和 dashboard 都需要扫全目录。`team-task-list.json` 是 run 内任务队列的索引：

- 快速展示任务列表。
- 支持按 status / owner / role / priority 查询。
- 支持 `claim-next` 快速筛选可领取任务。
- 支持计算 progress。
- 让 dashboard 和 `/team-status` 不需要解析每个 task 详情。

`team-task-list.json` 是索引，不替代 `tasks/<TASK-ID>/task.json`。

---

## 2. ID 规则

| ID | 示例 | 生成者 |
|---|---|---|
| Run ID | `RUN-0001` 或 `RUN-20260709-001` | `.team` gateway，通常由 `/team-plan` 调用 |
| Task ID | `TASK-0001` | `.team` gateway，通常由 `/team-plan` 导入任务时分配 |
| Agent ID | `AGENT-codex-001` | `/team-dispatch` |
| Claim ID | `CLAIM-task-0001` | `claim-next` primitive |
| Path Claim ID | `CLAIM-path-0001` | `claim-next` primitive |
| Review ID | `REVIEW-TASK-0001-01` | `team review claim` |
| Verify ID | `VERIFY-0001` | `team verify` |
| Worktree ID | `WT-TASK-0001` | `team worktree register` |

MVP 可以先使用 run-scoped 自增 ID。后续如果要跨机器同步，可以升级为带时间戳或 UUID 的 ID。Coding agent 可以建议任务标题、依赖和 scope，但最终 ID 应由 `.team` gateway 分配或校验，避免冲突。ID 计数器位置、保护锁与格式正则见 [17](17-cli-mcp-contract-and-error-model.md) §6。

---

## 3. `team-task-list.json`

```json
{
  "schema_version": "team.task_list.v1",
  "run_id": "RUN-0001",
  "updated_at": "2026-07-09T14:10:00+08:00",
  "tasks": [
    {
      "task_id": "TASK-0001",
      "title": "Add auth domain model",
      "type": "implementation",
      "status": "ready",
      "priority": 90,
      "weight": 2,
      "role": "implementer",
      "depends_on": [],
      "owner_agent_id": null,
      "claim_id": null,
      "paths": {
        "allow": ["src/auth/**", "tests/auth/**"],
        "avoid": ["package-lock.json"]
      },
      "required_checks": ["npm test -- auth"],
      "progress": 0,
      "task_ref": "tasks/TASK-0001/task.json"
    }
  ]
}
```

---

## 4. Index 字段说明

| 字段 | 说明 | 更新者 |
|---|---|---|
| `task_id` | 稳定任务 ID | planner |
| `title` | 任务短标题 | planner |
| `type` | `implementation` / `investigation` / `review` / `integration` / `verification` | planner |
| `status` | 任务状态 | primitive |
| `priority` | 领取排序 | planner / user |
| `weight` | progress 权重 | planner |
| `role` | 推荐领取角色 | planner |
| `depends_on` | 前置任务 | planner |
| `owner_agent_id` | 当前 owner | primitive |
| `claim_id` | 当前 claim | primitive |
| `paths.allow` | 推荐修改范围 | planner |
| `paths.avoid` | 不建议修改范围 | planner |
| `required_checks` | 任务验收命令 | planner / reviewer |
| `progress` | 任务级进度快照 | derived |
| `task_ref` | task 详情路径 | planner |

原则：planner 可以写结构和意图；claim、owner、status 等运行态字段只能由 CLI/MCP primitive 改。

---

## 5. `tasks/<TASK-ID>/task.json`

```json
{
  "schema_version": "team.task.v1",
  "run_id": "RUN-0001",
  "task_id": "TASK-0001",
  "title": "Add auth domain model",
  "type": "implementation",
  "status": "ready",
  "objective": "Create the domain model for auth users and sessions.",
  "context": [
    "The project already has user persistence in src/users.",
    "Auth phase 1 should avoid changing public API routes."
  ],
  "acceptance": [
    "AuthUser and Session domain types exist.",
    "Focused unit tests cover construction and validation.",
    "No unrelated formatting churn."
  ],
  "depends_on": [],
  "suggested_role": "implementer",
  "priority": 90,
  "weight": 2,
  "paths": {
    "allow": ["src/auth/**", "tests/auth/**"],
    "avoid": ["package-lock.json"],
    "requires_approval": ["src/users/**"]
  },
  "worktree": {
    "suggested_branch": "team/RUN-0001/TASK-0001-auth-domain-model",
    "suggested_path": "../.team-worktrees/RUN-0001/TASK-0001"
  },
  "required_checks": [
    "npm test -- auth"
  ],
  "review": {
    "required": true,
    "recommended_reviewers": ["reviewer"]
  },
  "metadata": {
    "created_by": "AGENT-claude-001",
    "created_at": "2026-07-09T14:05:00+08:00"
  }
}
```

`status` 值域与全部合法转换以 [15](15-run-task-state-machine-and-lifecycle.md) §3 为准。另有可选字段 `previous_attempts[]`：任务被 release/reclaim 后记录历次 attempt（原 agent、claim、worktree、进展快照引用），回收不清零，新领取者 hydrate 时读取（[15](15-run-task-state-machine-and-lifecycle.md) §5.3）。

---

## 6. Task Markdown Detail

`task.md` 是给人和 agent 读的详细说明，可以从 `task.json` 生成，也允许 planner 写更自然的上下文。

```markdown
# TASK-0001 Add auth domain model

## Objective

Create the domain model for auth users and sessions.

## Context

- The project already has user persistence in `src/users`.
- Auth phase 1 should avoid changing public API routes.

## Acceptance

- AuthUser and Session domain types exist.
- Focused unit tests cover construction and validation.
- No unrelated formatting churn.

## Paths

Allow:
- `src/auth/**`
- `tests/auth/**`

Avoid:
- `package-lock.json`

## Required Checks

- `npm test -- auth`
```

---

## 7. Task 状态机

状态机 v2（权威版本见 [15](15-run-task-state-machine-and-lifecycle.md) §3.2）：

```text
draft -> ready -> claimed -> working -> submitted -> reviewing
reviewing -> approved -> verified -> integrated -> done
reviewing -> changes_requested -> working
reviewing -> submitted                (review claim 释放或过期)
submitted -> approved                 (review_skipped，仅当 policy 允许)
approved -> changes_requested         (verification_failed)
working -> blocked
blocked -> working                    (unblock)
claimed/working/blocked -> ready      (release / reclaim)
任意非终态 -> cancelled                (team task cancel，需用户确认)
```

没有 `stale` 状态：lease 过期是读取时派生的风险标注，不持久化；探测与回收见 [15](15-run-task-state-machine-and-lifecycle.md) §5。

状态含义：

| 状态 | 含义 |
|---|---|
| `draft` | 任务未确认，不能领取 |
| `ready` | 可领取，依赖已满足 |
| `claimed` | agent 已获得 lease，但尚未正式开始 |
| `working` | worktree 已准备，agent 正在工作 |
| `submitted` | agent 已提交 evidence，等待 review |
| `reviewing` | reviewer 已认领 review |
| `changes_requested` | review 或 verification 要求返工 |
| `approved` | review 通过（或按 policy 记 `review_skipped` 直通） |
| `verified` | required checks / verification gate 通过 |
| `integrated` | 已合入 integration branch 或 merge queue |
| `done` | run 接受该任务完成 |
| `blocked` | 需要用户或 planner 决策；blocked 期间 lease 冻结，不续租也不判过期（[15](15-run-task-state-machine-and-lifecycle.md) §5.1） |
| `cancelled` | 终态：任务被取消，从 run progress 分母剔除 |

---

## 8. 状态修改规则

完整转换权限矩阵（谁 × 从哪到哪 × 前置校验 × 必写记录与事件）以 [15](15-run-task-state-machine-and-lifecycle.md) §3.3 为准，此处仅摘要关键路径：

| 转换（摘要） | 谁可以执行 | 必须记录 |
|---|---|---|
| `draft -> ready` | user / planner（`team task publish`） | `task_published` event |
| `ready -> claimed` | `claim-next` primitive | task claim、path claim、event |
| `claimed -> working` | owner agent | worktree record、event |
| `working -> submitted` | owner agent（`team submit`） | evidence、changed files、event |
| `submitted -> reviewing` | reviewer agent | review claim（[14](14-evidence-review-verification-contract.md) §3.1）、event |
| `reviewing -> approved / changes_requested` | reviewer agent | review record、event |
| `approved -> verified` | verifier / integrator | VERIFY 记录（[14](14-evidence-review-verification-contract.md) §4）、event |
| `verified -> integrated` | integrator | integration record、event |
| `integrated -> done` | user / integrator | final event |
| release / reclaim / unblock / cancel | owner / user / sweep | previous_attempts、event（[15](15-run-task-state-machine-and-lifecycle.md) §3.3 / §5） |

实现者不能直接把自己的 task 标记为 `done`；reviewer 不能是该 task 的历任 owner（INV-008）。

---

## 9. Task Progress 规则

MVP 中 task progress 可以按状态派生：

| 状态 | progress |
|---|---|
| `draft` | 0 |
| `ready` | 0 |
| `claimed` | 0.05 |
| `working` | 0.35 |
| `submitted` | 0.6 |
| `reviewing` | 0.7 |
| `changes_requested` | 0.45（介于 working 与 submitted 之间，体现返工，[15](15-run-task-state-machine-and-lifecycle.md) §3.4） |
| `approved` | 0.8 |
| `verified` | 0.9 |
| `integrated` | 0.95 |
| `done` | 1.0 |
| `blocked` | 保持上一次，另计 risk |
| `cancelled` | 从 run progress 分母剔除（[15](15-run-task-state-machine-and-lifecycle.md) §3.4） |

Run progress：

```text
sum(task.progress * task.weight) / sum(task.weight)
```

---

## 10. 查询需求

必须支持：

```text
team tasks --run RUN-0001
team tasks --run RUN-0001 --status ready
team tasks --run RUN-0001 --owner AGENT-codex-001
team task show --run RUN-0001 --task TASK-0003
team evidence show --run RUN-0001 --task TASK-0003
```

Slash command 层可以包装为：

```text
/team-tasks RUN-0001
/team-task RUN-0001 TASK-0003
/team-evidence RUN-0001 TASK-0003
```

约定：所有 task 级命令必须同时给 RUN 与 TASK 双参——TASK-ID 是 run-scoped 自增，单参形式歧义（[17](17-cli-mcp-contract-and-error-model.md) §1）。
