# 01. Product Boundary and User Journey

> 目标：把 `.team/` 的产品边界和跨工具用户旅途说清楚，避免把它设计成另一个“智能调度器”。

---

## 1. 产品边界

`.team/` 的职责是：

- 作为 gateway 接收 Claude Code / Codex / Cursor 提交的 run、task list 和 evidence。
- 记录 run、task、agent、claim、evidence、review、progress 和 events。
- 提供可原子操作的任务认领协议。
- 用 path claim 和 lease/heartbeat 降低多 agent 并行冲突。
- 让用户可以通过 `RUN-ID` 和 `TASK-ID` 查询状态与证据。
- 为 dashboard、MCP、CLI、slash command 提供同一套事实源。
- 以本地协作状态目录存在：MVP 阶段 `.team/` 全部 gitignore、不入库，留档经 `team export` 导出后由用户提交（D4，[16](16-git-worktree-and-team-root.md)）。

`.team/` 不负责：

- 自动理解项目。
- 自动拆解任务。
- 自动写代码。
- 自动判断代码一定正确。
- 替代 Claude Code / Codex / Cursor。
- 以 OS 级 daemon 常驻。gateway 永远是被动 CLI；巡检由用户手动启动的只读 `team watch` 承担（D14）。

这些智能行为由具体 coding agent 完成。`.team/` 只约束和记录它们的协作。

---

## 2. 主要角色

| 角色 | 说明 | 典型工具 |
|---|---|---|
| User / Project Owner | 发起目标、批准计划、查看进度、处理阻塞 | 人 |
| Planning Agent | 读项目、拆任务、生成 plan/task payload | Claude Code / Codex / Cursor |
| Implementing Agent | 认领实现任务，在 worktree 中修改代码 | Codex / Claude Code / Cursor |
| Reviewing Agent | 认领 review 任务，审查 diff 和 evidence | Claude Code / Codex |
| Integrating Agent | 合并通过 review 的任务，处理冲突，跑验证 | Codex / Claude Code |
| `.team` Gateway | 接收 payload，分配/登记 ID，提供记录、认领、锁、状态、审计原语 | CLI / MCP backend |

---

## 3. 核心旅途：从 Claude plan 到 Codex dispatch

### Step 1：用户在 Claude Code 中规划

```text
/team-plan "实现 auth phase 1"
```

Claude Code slash command 的提示词要求当前 Claude agent 做智能规划：

1. 阅读项目代码和规则。
2. 拆解任务。
3. 生成 plan/task payload。

随后 slash command 调用 `.team` gateway primitives：

1. 创建或登记 `RUN-ID`。
2. 将任务 payload 写入 `team-task-list.json`。
3. 为每个任务分配或登记 `TASK-ID`。
4. 写入 `tasks/<TASK-ID>/task.json`。
5. 追加 `events.jsonl`。
6. 返回 `RUN-ID` 给用户。

输出示例：

```text
Created Team Run: RUN-0001
Tasks: 8
Ready: 5
Blocked by dependencies: 3
Next: run /team-dispatch RUN-0001 from Codex, Claude Code, or Cursor.
```

### Step 2：用户在 Codex 中分发

```text
/team-dispatch RUN-0001
```

Codex 读取 `.team/runs/RUN-0001/`，注册当前 agent，然后调用底层 primitive：

```text
team claim-next --run RUN-0001 --agent AGENT-codex-001
```

claim 成功后返回：

```json
{
  "run_id": "RUN-0001",
  "task_id": "TASK-0003",
  "title": "Implement auth session repository",
  "worktree_path": "../.team-worktrees/RUN-0001/TASK-0003",
  "branch": "team/RUN-0001/TASK-0003-auth-session-repository",
  "required_checks": ["npm test -- auth"]
}
```

### Step 3：Codex 开始执行

Codex 创建或进入 worktree，开始实现，并持续写回：

- `events.jsonl`
- `agents/AGENT-codex-001.json`
- `claims/task-claims.json`
- `claims/path-claims.json`
- `evidence/TASK-0003/`（目录：`evidence.json` + `evidence.md`）
- `context/tasks/TASK-0003.md`（handoff memory）
- `progress.json`

### Step 4：其他 agent 加入同一 run

用户可以在多个工具中重复：

```text
/team-dispatch RUN-0001
```

每个 agent 都通过同一个 run id 进入同一任务队列，并在锁保护下领取不同任务。

---

## 4. 三类 Team Run

| Run 类型 | 启动方式 | Coding agent 输出 | `.team` gateway 负责 | 并行粒度 |
|---|---|---|---|---|
| Feature Run | `/team-plan "实现 X"` | task graph、依赖、验收、文件范围 | 持久化、ID、状态、发布 | 模块 / 层 / 测试切片 |
| Debug Run | `/team-plan --mode debug "测试 Y 失败"` | repro、假设、调查任务、回归目标 | 持久化、ID、状态、发布 | 根因假设 / 子系统 |
| Review Run | `/team-plan --mode review <branch>` | diff map、风险列表、review checklist | 持久化、ID、状态、发布 | correctness / tests / architecture / security |

三类 run 共用同一套 `.team/` 对象和状态机。差别只在 coding agent 生成的任务类型和计划 payload。

---

## 5. 关键用户体验

### 发布任务

```text
/team-publish RUN-0001
```

把 import 后处于 `draft` 的任务发布为 `ready`。这是用户确认动作：先展示将发布的任务与 warnings，用户确认后 `draft -> ready`，首次发布使 run 进入 `active`（[15](15-run-task-state-machine-and-lifecycle.md) §6）。

### 查询 run

```text
/team-status RUN-0001
```

应该展示：

- run 状态
- 总任务数
- ready / working / review / blocked / done 数量
- stale agent
- path conflict
- 最近事件
- 下一步建议

### 查询 task

```text
/team-task RUN-0001 TASK-0003
```

应该展示：

- 任务目标
- 当前 owner
- worktree / branch
- paths
- acceptance criteria
- changed files
- evidence
- review 状态
- required checks

### 查询 evidence

```text
/team-evidence RUN-0001 TASK-0003
```

应该展示：

- 实现摘要
- 修改文件
- 运行的命令
- 测试结果
- 风险和偏离
- 后续建议

---

## 6. 用户旅途中的核心 ID

| ID | 含义 | 用途 |
|---|---|---|
| `RUN-ID` | 一次项目级协作运行 | 加入 run、查进度、集成、报告 |
| `TASK-ID` | 一个可认领任务 | claim、submit、review、evidence |
| `AGENT-ID` | 一个 agent 会话 | heartbeat、owner、审计 |
| `CLAIM-ID` | 一次任务或路径认领 | 冲突检查、审计 |
| `WORKTREE-ID` | 一个任务 worktree | diff、测试、集成 |
| `REVIEW-ID` | 一轮 review 的记录（如 `REVIEW-TASK-0003-01`） | 多轮 review 追溯、返工依据 |
| `VERIFY-ID` | 一次验证记录（可指向 task 或 run） | verification 结果、集成前把关 |

产品交互必须围绕这些 ID，而不是只靠自然语言描述。
