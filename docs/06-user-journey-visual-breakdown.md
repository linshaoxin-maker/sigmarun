# 06. User Journey Visual Breakdown

> 目标：按用户旅途拆解 Team Run，不从内部对象出发。每一步都标清楚：用户做什么、Claude/Codex/Cursor 做什么、`.team gateway` 记录什么、产出什么 ID。

---

## 1. 总览：从项目接入到交付

```mermaid
flowchart LR
  U["User"] --> I["init + adapter install<br/>+ doctor"]
  I --> P["/team-plan goal<br/>in Claude Code / Codex"]
  P --> A1["Planning agent<br/>reads repo and breaks down work"]
  A1 --> G1[".team gateway<br/>imports run/task payload"]
  G1 --> R["RUN-ID"]
  R --> D["/team-dispatch RUN-ID<br/>in Codex / Claude / Cursor"]
  D --> G2[".team gateway<br/>claim-next with lock"]
  G2 --> T["TASK-ID + CLAIM-ID<br/>+ worktree suggestion"]
  T --> E["Agent creates/registers worktree<br/>and executes task"]
  E --> S["submit evidence"]
  S --> RV["independent review"]
  RV --> V["independent verification"]
  V --> IN["integrator agent merges<br/>gateway records"]
  IN --> REP["run report + progress + audit trail"]
```

最关键的产品动作：

- `/team-plan` 输出 `RUN-ID`，它是跨工具协作入口。
- `/team-dispatch RUN-ID` 输出 `TASK-ID`，它是当前 agent 的工作入口。
- `.team gateway` 不拆任务，只负责导入、记录、发布、认领、锁、审计和进度。
- worktree 与 Git merge 由 coding agent 执行；gateway 只建议、校验和登记。
- dashboard 是可选只读观察面，不是任务分发或状态写入入口。

---

## 2. 泳道图：谁负责什么

```mermaid
sequenceDiagram
  participant User
  participant PlanningAgent as Claude/Codex/Cursor Planning Agent
  participant Gateway as .team Gateway
  participant DispatchAgent as Codex/Claude/Cursor Dispatch Agent
  participant Reviewer as Independent Reviewer
  participant Verifier as Independent Verifier
  participant Integrator as Integrator Agent

  User->>PlanningAgent: /team-plan "实现 auth phase 1"
  PlanningAgent->>PlanningAgent: 读项目、拆任务、生成 plan/task payload
  PlanningAgent->>Gateway: team run import(payload)
  Gateway->>Gateway: 分配/校验 RUN-ID、TASK-ID
  Gateway->>Gateway: 写 run.json、team-task-list.json、tasks/*
  Gateway-->>PlanningAgent: RUN-0001
  PlanningAgent-->>User: 返回 RUN-0001

  User->>PlanningAgent: /team-publish RUN-0001
  PlanningAgent->>Gateway: task publish(RUN-0001)
  Gateway->>Gateway: draft tasks -> ready queue

  User->>DispatchAgent: /team-dispatch RUN-0001
  DispatchAgent->>Gateway: register agent
  DispatchAgent->>Gateway: claim-next(RUN-0001)
  Gateway->>Gateway: acquire run.lock
  Gateway->>Gateway: 过滤 ready/deps/capability/path-conflict
  Gateway->>Gateway: 写 task-claims、path-claims、events
  Gateway->>Gateway: release run.lock
  Gateway-->>DispatchAgent: TASK-0003 + CLAIM-ID + worktree suggestion
  DispatchAgent->>Gateway: context hydrate
  Gateway-->>DispatchAgent: context pack（must-read refs）
  DispatchAgent->>DispatchAgent: 执行 git worktree add、开发、测试
  DispatchAgent->>Gateway: register worktree / heartbeat
  DispatchAgent->>Gateway: submit evidence(TASK-0003)
  Gateway->>Gateway: 更新 task status、progress、events

  User->>Reviewer: /team-review RUN-0001 TASK-0003
  Reviewer->>Gateway: claim review(TASK-0003)
  Note over Reviewer,Gateway: review claim 也可经 claim-next --role reviewer 合成的虚拟工作项自主领取（D15）
  Reviewer->>Reviewer: 审查 diff/evidence/checks
  Reviewer->>Gateway: approve / request changes

  User->>Verifier: /team-verify RUN-0001 TASK-0003
  Verifier->>Gateway: claim verify(TASK-0003)
  Verifier->>Verifier: 独立重跑 build/tests/scope check
  Verifier->>Gateway: submit verification

  User->>Integrator: /team-integrate RUN-0001
  Integrator->>Gateway: integrate start(RUN-0001)
  Gateway-->>Integrator: integration branch + deterministic order
  Integrator->>Integrator: 执行 git merge、冲突处理、全量验证
  Integrator->>Gateway: integrate record + report
  Gateway-->>User: /team-status RUN-0001 可见进度与审计
```

---

> **修订注（2026-07-15，整改 R5 回写）**：§3 是 full 模式**快乐路径**的静态拆解。用户旅途的**可执行权威清单**（含轻量旅途 + S1–S13 全部异常/分支旅途 + 运维/观测旅途）现固化为 `packages/cli/test/journeys.test.ts` 的 **18 条端到端旅途**——每条以真实 CLI 命令序列回放,断言「步步推进 + 到达明确终态 + 不缠绕」;并配一张**旅途↔功能↔特性三向对账**(第五张机器守护,产品轴):每个改状态命令必属于至少一条旅途(无孤儿功能)、每条旅途引用的命令都真实存在(无幻影步骤)、每个宣称特性都被某旅途行使(无不可达特性)、旅途声明的命令集精确等于其实际执行的命令(catalog 不谎报)。**用户旅途-功能-特性漂移即 CI 红。**

## 3. 用户旅途拆解表

| 阶段 | 用户动作 | Coding Agent 做什么 | `.team gateway` 做什么 | 主要记录 | 输出 |
|---|---|---|---|---|---|
| 0. Setup | `init`、安装所需 adapter、`doctor` | 无 | 初始化 `.team/`；adapter 安装 command/Skill | `.team/project.json`, `.team/counters.json`, adapter files, `AGENTS.md` | 可使用 `/team-*` 的项目 |
| 1. Plan | 在 Claude Code/Codex 输入 `/team-plan "目标"` | 读项目与 memory，拆任务，生成 payload | 校验并导入 payload，分配 ID | `run.json`, `plan.md`, `team-task-list.json`, `tasks/*`, `events.jsonl` | `RUN-ID` |
| 2. Confirm / Publish | 用户确认任务图，`/team-publish RUN-ID` | 展示并解释任务图 | 将 draft task 发布为 `ready` | `team-task-list.json`, `events.jsonl` | ready task queue |
| 3. Dispatch | 在多个窗口输入 `/team-dispatch RUN-ID` | 注册身份，请求领取任务 | 加锁执行 `claim-next`，写 task/path claim | `agents/*`, `task-claims.json`, `path-claims.json`, `events.jsonl` | `TASK-ID`, `CLAIM-ID`, worktree suggestion |
| 4. Execute | 用户等待或继续启动 agent | 创建 worktree、登记、修改代码、测试、heartbeat、消息交接 | 校验 worktree，记录心跳、消息和状态变化 | `agents/*`, `worktrees.json`, `messages.jsonl`, `events.jsonl` | working task |
| 5. Submit | agent 完成实现 | 收集 diff、测试、验收和 handoff | 校验 evidence，推进到 `submitted` | `evidence/TASK-ID/`, `team-task-list.json`, `events.jsonl` | submitted task |
| 6. Review | Ready for review 后启动独立 reviewer | 审查 diff/evidence/risk | 记录 review claim 和决定，禁止自审 | `reviews/TASK-ID/`, `events.jsonl` | approved / changes requested |
| 7. Verify | Ready for verify 后启动独立 verifier | 亲自重跑 focused/full checks | 记录 gate 结果，禁止自证 | `verification/`, `events.jsonl` | verified / failed |
| 8. Integrate | 用户触发 `/team-integrate` | 按 gateway 顺序执行 Git merge、冲突处理和全量验证 | 返回集成计划，逐项登记 merge/failure，生成报告 | `integration.md`, `report.md`, `events.jsonl` | integration branch + run report |
| 9. Observe | 任意时候 `/team-status RUN-ID`、watch 或 dashboard | slash command 可解释状态 | 从事实重算 progress；dashboard 只读 | `progress.json` 可重建 | progress/risk/next actions |

---

## 4. `.team` 记录流

```mermaid
flowchart TD
  A["/team-plan payload"] --> B[".team gateway import"]
  B --> C["run.json<br/>RUN-ID"]
  B --> D["team-task-list.json<br/>task queue index"]
  B --> E["tasks/TASK-ID/task.json<br/>task detail"]
  B --> F["events.jsonl<br/>run_created/task_created"]

  G["/team-dispatch RUN-ID"] --> H["claim-next"]
  H --> I["locks/run.lock"]
  H --> J["claims/task-claims.json"]
  H --> K["claims/path-claims.json"]
  H --> L["agents/AGENT-ID.json"]
  H --> M["worktrees.json"]
  H --> N["events.jsonl<br/>agent_registered/task_claimed"]
  H --> X["context hydrate<br/>context pack（must-read refs）"]

  X --> O["task execution"]
  O --> P["evidence/TASK-ID/<br/>evidence.json + evidence.md + outputs/"]
  O --> Q["events.jsonl<br/>heartbeat/evidence_submitted"]

  R["independent review"] --> S["reviews/TASK-ID/<br/>REVIEW-*.json + md"]
  VV["independent verify"] --> T["verification/<br/>VERIFY-*.json + md"]
  IN["integrator agent + gateway record"] --> U["integration.md"]
  IN --> V["report.md"]

  C --> W["progress.json<br/>derived"]
  D --> W
  J --> W
  L --> W
  P --> W
  S --> W
  T --> W
```

---

## 5. 任务队列在哪里

任务队列不是聊天上下文，也不是 dashboard 里的临时列表。dashboard、status 和 adapter 都读取同一个事实源：

```text
.team/runs/RUN-0001/team-task-list.json
```

它索引所有任务：

```text
RUN-0001
  team-task-list.json
    TASK-0001 ready
    TASK-0002 ready
    TASK-0003 claimed by AGENT-codex-001
    TASK-0004 blocked by TASK-0001
```

每个任务详情在：

```text
.team/runs/RUN-0001/tasks/TASK-0003/task.json
```

所有查询都围绕 ID：

```text
/team-status RUN-0001
/team-tasks RUN-0001
/team-task RUN-0001 TASK-0003
/team-evidence RUN-0001 TASK-0003
/team-review RUN-0001 TASK-0003
```

---

## 6. 从旅途反推需要的功能

```mermaid
mindmap
  root((Team Run))
    Plan Import
      plan/task payload
      RUN-ID
      TASK-ID
      task-list index
    Queue
      ready tasks
      dependencies
      priority
      role/capability
    Claim
      run.lock
      task claim
      path claim
      lease
      heartbeat
    Execution
      worktree
      branch
      changed files
      evidence
    Review
      reviewer claim
      approve
      request changes
      self-approve blocked
    Verify
      required checks
      gate status
      failure to TASK-ID
    Progress
      derived snapshot
      stale risks
      path conflicts
      next actions
    Audit
      events.jsonl
      immutable trail
      who/when/what
```

---

## 7. MVP 主链路

```mermaid
flowchart LR
  P["Slice 1<br/>.team schema"] --> I["Slice 2<br/>plan payload import"]
  I --> C["Slice 3<br/>claim-next + lock + 回收"]
  C --> X["Slice 4<br/>Context Plane"]
  X --> D["Slice 5<br/>dispatch RUN-ID"]
  D --> E["Slice 6<br/>evidence submit"]
  E --> S["Slice 7<br/>status + watch"]
  S --> R["Slice 8<br/>review gate"]
  R --> V["Slice 9<br/>verify + integrate"]
```

（切片编号与 [05](05-mvp-feature-slices.md) 九切片对齐。）

MVP 判断标准：

> 一个 Claude Code 生成的 `RUN-ID`，能被 Codex 用 `/team-dispatch RUN-ID` 加入，并且 Codex 能领取唯一 `TASK-ID`、写回 evidence，用户能用 `/team-status RUN-ID` 查到可信 progress。

---

## 8. 还需要继续细拆的问题

> 以下问题在本文档写作时开放，现已全部被后续文档关闭，逐条标注归属。

1. `plan/task payload` 输入 schema：coding agent 提交给 `.team gateway` 的结构。——已由 [09](09-team-run-import-payload-schema.md) 关闭。
2. `claim-next` 选择算法：priority、依赖、capability、path conflict 怎么排序。——已由 [10](10-claim-next-lock-and-conflict-rules.md) §7 关闭。
3. path claim 粒度：glob、文件、模块、目录如何表达。——已由 [10](10-claim-next-lock-and-conflict-rules.md) §8 + D3（minimatch 语义）关闭。
4. evidence 最小格式：必须记录哪些命令、diff、验收和风险。——已由 [14](14-evidence-review-verification-contract.md) 关闭。
5. progress 派生规则：blocked/stale/reviewing 如何影响进度和风险。——已由 [15](15-run-task-state-machine-and-lifecycle.md) §3.4 + [02](02-domain-model-and-team-storage.md) 关闭。
6. review gate：MVP 是否强制 reviewer 不是 owner。——已由 D6 + [14](14-evidence-review-verification-contract.md) 关闭（require_review 默认开、policy 可关；self-approval 禁令不受开关影响）。
