# 02. Domain Model and `.team` Storage

> 目标：定义产品对象模型和 `.team/` 存储结构，确保后续命令、状态查询、dashboard、MCP 都有同一套事实源。

---

## 1. 核心对象模型

```text
TeamProject
  TeamRun
    TeamTaskList
    TaskGraph
      TeamTask
    AgentSession
    TaskClaim
    PathClaim
    WorktreeRecord
    MessagePool
    ContextMemory
    EvidenceBundle
    ReviewRecord
    VerificationRecord
    ProgressSnapshot
    EventLog
```

---

## 2. 对象职责

| 对象 | ID 示例 | 职责 |
|---|---|---|
| TeamProject | project slug | 项目级协议配置和默认策略 |
| TeamRun | `RUN-0001` | 一次协作运行，绑定目标、模式、任务列表、状态 |
| TeamTaskList | `RUN-0001` scoped | run 内任务队列索引 |
| TaskGraph | `RUN-0001` scoped | task DAG，描述硬依赖、软依赖、上下文传播、review/verify/integration 边 |
| TeamTask | `TASK-0003` | 一个可认领、可执行、可 review 的工作单元 |
| AgentSession | `AGENT-codex-001` | 一个工具会话的注册、能力、心跳 |
| TaskClaim | `CLAIM-task-0007` | agent 对 task 的租约 |
| PathClaim | `CLAIM-path-0012` | task 对路径范围的占用 |
| WorktreeRecord | `WT-TASK-0003` | task 对应 branch/worktree 信息，schema 见 [16](16-git-worktree-and-team-root.md) §3.2 |
| MessagePool | `MSG-0001` | run/task/agent scoped 的协作消息、问题、回答、blocker、handoff |
| ContextMemory | `CTX-0001` | 从 messages/evidence/events 压缩出的 run/task working memory |
| EvidenceBundle | `TASK-0003` scoped | 实现或调查结果证据 |
| ReviewRecord | `REVIEW-TASK-0003-01` | reviewer 对 task 的审查结论；多轮目录化存 `reviews/TASK-ID/REVIEW-*.{json,md}`，每轮新建记录、永不覆盖（[14](14-evidence-review-verification-contract.md) §3.2） |
| VerificationRecord | `VERIFY-0001` | run/task 的验证命令和 gate 结果；目录化存 `verification/VERIFY-*.{json,md}`，target 可为 task 或 run（[14](14-evidence-review-verification-contract.md) §4） |
| ProgressSnapshot | `RUN-0001` scoped | 从事实派生出的进度快照 |
| EventLog | append-only | 审计事件流 |

---

## 3. 推荐 `.team/` 结构

```text
.team/
  README.md
  project.json
  counters.json            # RUN-ID 计数器（project.lock 内分配）
  backup/                  # migrate / repair 执行前的自动备份
  templates/
    task.md
    evidence.md
    review.md
    verification.md
  runs/
    RUN-0001/
      run.json
      plan.md
      team-task-list.json
      task-graph.json
      counters.json        # run 内 TASK/CLAIM/MSG/REVIEW/VERIFY/WT 计数器
      tasks/
        TASK-0001/
          task.json
          task.md
        TASK-0002/
          task.json
          task.md
      agents/
        AGENT-codex-001.json
        AGENT-claude-001.json
      claims/
        task-claims.json
        path-claims.json
        review-claims.json
        path-approvals.json
      worktrees.json
      progress.json
      context/
        run-memory.md
        run-decisions.jsonl    # derived：可由 messages.jsonl 重建
        open-questions.jsonl   # derived：可由 messages.jsonl 重建
        messages.jsonl         # 权威协作事实源（13 号 M23 裁决）
        context-index.json     # derived
        tasks/
          TASK-0001.md
        snapshots/
          CTX-0001.md
      evidence/
        TASK-0001/
          evidence.json
          evidence.md
          outputs/
          history/
      reviews/
        TASK-0001/
          REVIEW-TASK-0001-01.json
          REVIEW-TASK-0001-01.md
      verification/
        VERIFY-0001.json
        VERIFY-0001.md
      verification.md      # 派生索引，可重建（14 号 §1）
      integration.md
      report.md
      events.jsonl
      events.meta.json     # events seq 计数器
      locks/
        run.lock
        watch.lock         # team watch 单实例 advisory 锁
```

---

## 4. 制品与运行态边界

**MVP 边界（决策 D4，[13](13-design-audit-and-next-breakdown.md) §2.1）：`.team/` 整体 gitignore，永不入库**——不再区分"可进 git 的制品"与"运行态状态"。`.team/` 是本机协作状态目录，gateway 一律通过 git common dir 解析到主 checkout 的 `.team/`（[16](16-git-worktree-and-team-root.md) §2）。留档需求（复盘、PR 附证据）走 `team export`：把 run 的 plan / evidence / reviews / report 导出到可入库目录（默认 `docs/team-runs/`），由用户审阅后自行提交（[16](16-git-worktree-and-team-root.md) §7）。

`.team/` 内部数据按可变性分三类（口径对齐 [21](21-schema-versioning-and-migration.md) §2）：

### 权威 mutable（就地更新，带 `rev` 乐观锁）

- `project.json`
- `run.json`
- `team-task-list.json`
- `task-graph.json`
- `tasks/*/task.json`
- `agents/*.json`
- `claims/task-claims.json`、`claims/path-claims.json`、`claims/review-claims.json`、`claims/path-approvals.json`
- `worktrees.json`
- `evidence/*/evidence.json`
- `counters.json`（project 级与 run 级）

### Append-only（只追加，永不重写；带行内 `seq` 或行级 `v`）

- `events.jsonl`
- `context/messages.jsonl`
- `reviews/*/REVIEW-*.json`（每轮新文件，永不覆盖）
- `verification/VERIFY-*.json`

### Derived（可删除重算）

- `progress.json`
- `context/context-index.json`
- `context/open-questions.jsonl`、`context/run-decisions.jsonl`（messages.jsonl 为权威，[13](13-design-audit-and-next-breakdown.md) M23 裁决派生化）
- `verification.md`（`verification/*.json` 的派生索引）

`plan.md`、`task.md`、`evidence.md`、`run-memory.md` 等 markdown 是人读载体，跟随其权威 json 演进，不参与版本握手（[21](21-schema-versioning-and-migration.md) §2）。

---

## 5. `run.json`

```json
{
  "schema_version": "team.run.v1",
  "run_id": "RUN-0001",
  "title": "Implement auth phase 1",
  "mode": "feature",
  "status": "planned",
  "created_at": "2026-07-09T13:30:00+08:00",
  "created_by": {
    "tool": "claude-code",
    "agent_id": "AGENT-claude-001"
  },
  "source_prompt": "实现 auth phase 1",
  "base_branch": "main",
  "worktree_root": "../.team-worktrees/RUN-0001",
  "default_policy": {
    "claim_ttl_minutes": 30,
    "max_parallel_tasks": 4,
    "max_active_claims_per_agent": 1,
    "require_review": true,
    "require_verification": true,
    "reclaim_policy": {
      "auto_after_ttl_multiple": 3
    },
    "path_release_on_submit": "hold"
  }
}
```

`status` 值域为七态：`planned` / `active` / `paused` / `integrating` / `reported` / `archived` / `cancelled`，run 状态机、转换权限与操作能力矩阵见 [15](15-run-task-state-machine-and-lifecycle.md) §2。`reclaim_policy`（默认过期超 3×TTL 由 sweep 自动回收）与 `path_release_on_submit`（默认 hold：submit 后 path claim 不释放、不降级）的语义见 [15](15-run-task-state-machine-and-lifecycle.md) §5.2 / §4.2；`max_active_claims_per_agent` 默认 1（[13](13-design-audit-and-next-breakdown.md) 附录 C M36）。

---

## 6. `project.json`

`project.json` 描述项目级默认配置，不试图替代项目自身的 AGENTS/CLAUDE/Codex 规则。

```json
{
  "schema_version": "team.project.v1",
  "project_id": "paper-agent",
  "team_dir": ".team",
  "min_gateway_version": "0.1.0",
  "project_memory_path": "docs/team/MEMORY.md",
  "default_base_branch": "main",
  "default_worktree_root": "../.team-worktrees",
  "default_checks": [
    "pytest",
    "npm test"
  ],
  "tooling": {
    "supports_claude_code": true,
    "supports_codex": true,
    "supports_cursor": false
  }
}
```

注：`supports_cursor` 为预留字段（Cursor adapter 属 Phase 2，D2），MVP 默认 `false`；协议对象与 schema 均不含工具特异逻辑，未来启用只是 adapter 层的事。

`min_gateway_version` 是写闸门：低于该版本的 gateway 拒绝写操作，防旧工具破坏新状态；语义与提升时机见 [21](21-schema-versioning-and-migration.md) §6.2。

---

## 7. `agents/AGENT-*.json`

```json
{
  "schema_version": "team.agent.v1",
  "agent_id": "AGENT-codex-001",
  "tool": "codex",
  "role": "implementer",
  "status": "active",
  "registered_at": "2026-07-09T13:45:00+08:00",
  "last_heartbeat_at": "2026-07-09T13:48:00+08:00",
  "capabilities": [
    "code_edit",
    "test_run",
    "review"
  ],
  "current_task_id": "TASK-0003"
}
```

---

## 8. `events.jsonl`

事件流是 append-only 审计账本。所有状态变更必须写事件。每行是一个 `team.event.v1` 事件：`seq` 为 run 内单调递增序号（锁内从 `events.meta.json` 分配，断号即审计证据），`actor` 标注执行者类别与身份（`agent` / `user` / `policy` / `sweep`）；完整 schema、各事件必带字段与写事务事件的 `rev_after` 对账字段见 [18](18-audit-rule-catalog-and-trust-model.md) §2–3。行级可选 `v` 字段缺省为 1（[21](21-schema-versioning-and-migration.md) §3.4）。

```jsonl
{"schema_version":"team.event.v1","ts":"2026-07-09T13:30:00+08:00","seq":1,"event":"run_created","actor":{"type":"agent","id":"AGENT-claude-001"},"run_id":"RUN-0001","payload":{"mode":"feature","base_branch":"main"}}
{"schema_version":"team.event.v1","ts":"2026-07-09T13:31:00+08:00","seq":2,"event":"task_created","actor":{"type":"agent","id":"AGENT-claude-001"},"run_id":"RUN-0001","task_id":"TASK-0001","payload":{}}
{"schema_version":"team.event.v1","ts":"2026-07-09T13:45:00+08:00","seq":3,"event":"agent_registered","actor":{"type":"agent","id":"AGENT-codex-001"},"run_id":"RUN-0001","payload":{"tool":"codex","capabilities":["code_edit","test_run","review"]}}
{"schema_version":"team.event.v1","ts":"2026-07-09T13:45:02+08:00","seq":4,"event":"task_claimed","actor":{"type":"agent","id":"AGENT-codex-001"},"run_id":"RUN-0001","task_id":"TASK-0003","claim_id":"CLAIM-task-0007","payload":{"lease_until":"2026-07-09T14:15:02+08:00"}}
```

`events.jsonl` 不是 message pool。事件流只记录状态变化和审计事实；agent 间的问题、回答、handoff、设计发现应该写入 `context/messages.jsonl`，避免审计账本变成聊天日志。

---

## 9. Context Plane

Context Plane 用于保存任务 DAG、协作消息和压缩上下文：

- `task-graph.json`：权威 DAG，包含 `blocks`、`soft_depends_on`、`produces_context_for`、`reviews`、`verifies`、`integrates` 等边。
- `context/messages.jsonl`：typed collaboration messages，例如 question、answer、blocker、handoff、decision、risk。
- `context/run-memory.md`：run 级 working memory，用于新 agent 快速恢复上下文。
- `context/tasks/TASK-ID.md`：task 级 handoff / memory，用于下游 task hydrate。
- `context/open-questions.jsonl`：未解决问题索引。
- `context/context-index.json`：context refs 的派生索引，可重建。

原则：

1. DAG 是任务依赖和上下文传播的权威结构。
2. Message pool 是协作事实，但不是审计事件。
3. Memory 是派生/压缩视图，必须带 source refs。
4. Memory 的压缩内容一律由 coding agent 生成；gateway 只做机械 rollup（模板拼接/索引）与 source refs 存在性校验，永远不做语义压缩（[13](13-design-audit-and-next-breakdown.md) §5.1 裁决）。
5. `/team-dispatch` claim 成功后应该先 hydrate context，再开始执行。

---

## 10. Progress 是派生视图

`progress.json` 不应该成为权威事实源。它由以下事实派生：

- `team-task-list.json`
- `task-graph.json`
- `claims/task-claims.json`
- `claims/path-claims.json`
- `agents/*.json`
- `context/messages.jsonl`
- `context/open-questions.jsonl`
- `evidence/*/evidence.json`
- `reviews/*/REVIEW-*.json`
- `verification/VERIFY-*.json`
- `events.jsonl`

示例：

```json
{
  "schema_version": "team.progress.v1",
  "run_id": "RUN-0001",
  "updated_at": "2026-07-09T14:00:00+08:00",
  "total_tasks": 8,
  "by_status": {
    "ready": 2,
    "working": 3,
    "reviewing": 1,
    "blocked": 1,
    "done": 1
  },
  "weighted_progress": 0.32,
  "risks": [
    {
      "kind": "stale_agent",
      "agent_id": "AGENT-codex-002",
      "task_id": "TASK-0005"
    }
  ],
  "next_actions": [
    "Review TASK-0002",
    "Resolve stale lease for TASK-0005"
  ]
}
```

---

## 11. Storage Rules

1. 所有 ID 必须稳定，不随文件移动变化。
2. 所有状态变化必须写入 `events.jsonl`。
3. `team-task-list.json` 是 task 查询索引；`tasks/<TASK-ID>/task.json` 是 task 详情。
4. `claims/*.json` 只由 CLI/MCP primitive 更新，不建议 agent 手写。
5. `locks/run.lock` 只用于短事务，不持有到实现结束。
6. `progress.json` 可以被删除并重算。
7. `evidence/` 和 `reviews/` 必须引用 `TASK-ID`。
8. 所有 mutable JSON 状态文件必须携带 `rev` 乐观锁字段：写事务在锁内 `read rev -> mutate -> write rev+1`，rev 异常即审计证据（[17](17-cli-mcp-contract-and-error-model.md) §5.2）。
9. 设计包络：MVP 以单 run ≤ 200 tasks、`events.jsonl` ≤ 10MB 为目标规模，越界时 status 输出 warning；events 归档与压实属 P2（[13](13-design-audit-and-next-breakdown.md) 附录 C M39）。
