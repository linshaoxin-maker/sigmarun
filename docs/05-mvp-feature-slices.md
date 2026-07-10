# 05. MVP Feature Slices

> 目标：把产品拆成可以逐步实现和验证的切片。

---

## 1. MVP 原则

MVP 不做完整平台，只验证一条核心链路：

```text
Claude Code /team-plan -> Claude 拆任务 -> .team gateway 记录任务队列 -> 返回 RUN-ID
用户 /team-publish RUN-ID 确认发布 -> 任务 draft -> ready（[15](15-run-task-state-machine-and-lifecycle.md) §6）
Codex /team-dispatch RUN-ID -> 自动领取 TASK-ID -> hydrate context -> worktree 执行 -> evidence + handoff -> status 可查
```

只要这条链路可靠，后续 review、verify、dashboard 都可以在同一事实源上扩展。

---

## 2. Slice 1：`.team` 基础结构

目标：创建 repo-local 协作目录和 schema。

包含：

- `.team/project.json`
- `.team/runs/<RUN-ID>/run.json`
- `.team/runs/<RUN-ID>/team-task-list.json`
- `.team/runs/<RUN-ID>/task-graph.json`
- `.team/runs/<RUN-ID>/tasks/<TASK-ID>/task.json`
- `.team/runs/<RUN-ID>/context/messages.jsonl`
- `.team/runs/<RUN-ID>/context/run-memory.md`
- `.team/runs/<RUN-ID>/events.jsonl`

验收：

- 可以创建 run。
- 可以创建 task list。
- 可以通过 `RUN-ID` 找到 task list。
- 可以通过 `TASK-ID` 找到 task detail。

---

## 3. Slice 2：agent-side `/team-plan` + `.team` import

目标：让 Claude Code / Codex 的 planning agent 生成 plan/task payload（Cursor 属 Phase 2，D2），并让 `.team` gateway 负责记录、ID、索引和事件。

包含：

- agent-side slash command prompt
- plan/task payload 格式
- gateway run id 生成或校验
- gateway task id 生成或校验
- task-list 写入
- task-graph 写入
- task detail 写入
- run-memory 初始化
- event 写入

验收：

- Claude Code 可以执行 `/team-plan "..."`。
- 命令通过 `.team` gateway 返回 `RUN-ID`。
- `.team/runs/<RUN-ID>/team-task-list.json` 可解析。
- 至少生成 2 个 `TASK-ID`。

---

## 4. Slice 3：`claim-next` + lock

目标：多个 agent 同时 dispatch 时不会领取同一个 task。

包含：

- `locks/run.lock`
- `claims/task-claims.json`
- `claims/path-claims.json`
- claim ttl / lease_until
- ready task filter
- priority sorting
- reclaim（手动确认 + 3×TTL 自动回收，[15](15-run-task-state-machine-and-lifecycle.md) §5）
- `max_active_claims_per_agent`（默认 1）
- events

验收：

- 两个 agent 并发 claim 不会拿到同一 task。
- 已 claim 且 lease 未过期的 task 不会被重复领取。
- path conflict task 不会被领取。
- agent 断线超 3×TTL 后任务自动回 ready 且带 previous_attempts 进展快照。
- 同一 agent 不能同时持有第二个 active claim（默认 policy）。
- claim 成功会写 event。

---

## 5. Slice 4：Context Plane MVP

目标：让任务 DAG、消息池和 working memory 成为主链路的一部分。

包含：

- `task-graph.json`
- `context/messages.jsonl`
- `context/run-memory.md`
- `context/tasks/<TASK-ID>.md`
- `context/open-questions.jsonl`
- `team context hydrate`
- `team message post`

验收：

- `team graph validate RUN-ID` 能检查 DAG 无 cycle。
- task submit 时能写 handoff memory。
- 下游 task claim 后能 hydrate 上游 context。
- blocker/question 能进入 message pool，并在 status 中可见。

---

## 6. Slice 5：`/team-dispatch RUN-ID`

目标：让 Codex / Claude Code 加入 run 并领取任务（Cursor 属 Phase 2，D2）。

包含：

- agent registration
- `claim-next`
- `context hydrate`
- must-read context refs
- worktree branch/path suggestion
- worktree context file
- task 状态推进到 `working`
- heartbeat

验收：

- Codex 执行 `/team-dispatch RUN-ID` 后返回 `TASK-ID`。
- task-list 中 owner/status 更新。
- `agents/<AGENT-ID>.json` 存在。
- dispatch 输出 context pack。
- `worktrees.json` 记录 task worktree。

---

## 7. Slice 6：Evidence + Submit

目标：task owner 完成后写回证据和 handoff。

包含：

- changed files
- checks run
- acceptance checklist
- risks/deviations
- follow-up tasks
- handoff memory
- downstream context refs
- task 状态 `working -> submitted`

验收：

- `/team-submit RUN-ID TASK-ID` 生成 evidence。
- `context/tasks/<TASK-ID>.md` 记录下游 handoff。
- `/team-task RUN-ID TASK-ID` 能显示 evidence 状态。
- evidence 中能看到命令结果和修改文件。

---

## 8. Slice 7：Status + Progress

目标：用户能看 run 进度和任务状态。

包含：

- `progress.json` 派生
- `/team-status RUN-ID`
- `/team-tasks RUN-ID`
- `/team-task RUN-ID TASK-ID`
- open questions / blockers / context risks

验收：

- status 显示 ready / working / submitted / blocked / done 数量。
- progress 按 task weight 计算。
- stale lease 会显示为 risk。
- blocked 任务豁免 stale 判定（[15](15-run-task-state-machine-and-lifecycle.md) §5.1）。
- unresolved blocker 会显示为 risk。
- status 含 Needs user 待人处理区块（批准 / blocker / 停等确认 / 回收确认，[13](13-design-audit-and-next-breakdown.md) 附录 C M32）。
- P0-inline 五条（AUD-001/002/011/015/021）在写原语内直接拒绝，[18](18-audit-rule-catalog-and-trust-model.md) §1.2 场景可复现；`team audit run --json` 返回单个合法 envelope 且 findings 逐条含 rule_id / next_action。
- `team watch`：单实例锁（第二实例被拒，BDD-007-07）、默认 30s tick、每轮触发一次 sweep、run 终态自动退出（[17](17-cli-mcp-contract-and-error-model.md) §7）（外审 finding 4 补）。
- `team repair`：崩溃残留按事件账本前滚/回滚、执行前自动备份、写 `state_repaired` 事件、幂等重跑 no-op（[17](17-cli-mcp-contract-and-error-model.md) §5.3，BDD-007-06）。
- 查询面：`team run list / run show / task show / evidence show` 输出与 `.team/` 事实逐字段一致（对照 [04](04-command-workflows.md) §1.1 canonical 表）。

---

## 9. Slice 8：Review Gate

目标：实现者不能自己把任务标 done。

包含：

- review record
- reviewer claim
- review 工作项可经 `claim-next --role reviewer` 合成（D15，[15](15-run-task-state-machine-and-lifecycle.md) §7）
- approve / request changes
- status transition

验收：

- submitted task 必须 review 后才能 approved。
- owner agent 不能 approve 自己的 task。
- request changes 会回到 working 或 changes_requested。
- `require_review=false` 时自动 approved 且留 `review_skipped` 痕。

---

## 10. Slice 9：Verification + Integration

目标：把任务结果绑定到软件工程 gate。

包含：

- verification record
- required checks
- failed checks 映射 TASK-ID
- integration report

验收：

- verified 需要真实命令证据。
- failed verification 会阻塞 integration。
- integration report 能列出已合入 task 和未合入 task。
- 单任务合并后 checks 失败 → 该 merge 被 revert、任务转 changes_requested，其余任务继续合入（[16](16-git-worktree-and-team-root.md) §4，BDD-008-02）。
- `team export`：干净内容产出留档清单等待用户提交；命中 secret 即中止并列出位置（`export_redaction_hit`，BDD-008-04/05）（外审 finding 4 补）。

---

## 11. 后续阶段

### Phase 2

- Cursor adapter（D2；协议字段已预留，包结构占位 `adapters/cursor/`，[19](19-agent-adapter-pack-claude-codex.md) §12）
- MCP server
- dashboard 只读 viewer
- context search / semantic memory
- cross-run knowledge promotion（已由 [25](25-project-memory-and-knowledge-promotion.md) 设计定稿：L4 项目记忆，读路径 MVP 生效、`memory promote` 为 P1 Slice 10）

### Phase 3

- GitHub Issues / PR sync
- remote runner
- multi-machine lock service
- merge train
- multi-model review voting

---

## 12. 当前待决问题（已全部关闭）

1. `RUN-ID` 是否使用全局时间戳格式，还是项目内自增格式？——已关闭：维持自增格式（RUN-ID 项目内计数、TASK-ID run-scoped），格式正则与计数器位置见 [17](17-cli-mcp-contract-and-error-model.md) §6。
2. `team-task-list.json` 是否允许直接编辑，还是只能通过 primitive 修改？——已关闭：只能经 primitive 修改；直改由 `rev` 乐观锁检出（[17](17-cli-mcp-contract-and-error-model.md) §5.2）。
3. path claim 是 glob 级别还是文件级别？——已关闭：glob 级，minimatch 语义（D3）。
4. worktree 创建由 slash command 自动执行，还是只返回建议命令？——已关闭：worktree 由 dispatch agent 创建，gateway 只 `worktree register` 记录与校验（[16](16-git-worktree-and-team-root.md) §3.1）。
5. evidence 是否强制记录 raw command output？——已关闭：required_checks 强制附截断后的原始输出 + exit code，其余命令可选（D8）。
6. `progress.json` 是否写文件，还是每次 status 动态计算？——已关闭：写文件且可删重算（维持派生视图定位，INV-006）。
7. review gate 在 MVP 是否必须实现，还是先只做 submitted 状态？——已关闭：review gate 进 MVP，policy 可关且留 `review_skipped` 痕（D6）。
