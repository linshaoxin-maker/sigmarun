# 04. Command Workflows

> 目标：定义上层 slash command 与底层 `.team` primitive 的边界。

---

## 1. 两层命令模型

### 上层：Agent Slash Commands

这些命令属于 Claude Code / Codex / Cursor 等工具侧的插件或 slash command。它们由当前 coding agent 执行，可以包含智能行为，例如读项目、拆任务、review diff。

```text
/team-plan
/team-publish
/team-dispatch
/team-runs
/team-status
/team-tasks
/team-task
/team-evidence
/team-submit
/team-review
/team-verify
/team-integrate
```

### 1.1 Slash 命令面总表（canonical，用户旅途闭环）

> 本表是 slash 命令面的**唯一权威清单**——[01](01-product-boundary-and-user-journey.md)/[07](07-skill-plugin-execution-form.md)/[12](12-context-plane-task-dag-message-pool-memory.md)/[19](19-agent-adapter-pack-claude-codex.md) 中出现的 slash 命令以本表为准。三条原则：① 每个 slash 只是 [17](17-cli-mcp-contract-and-error-model.md) §1 某组 primitives 的固定编排，不新增语义；② task 级命令一律双参（RUN + TASK）；③ 未包装成 slash 的操作永远可以从 status/audit 输出的 `next_actions` 复制 CLI 执行——slash 是便利层，不是能力边界。

| 旅途动作 | Slash 命令 | 底层 primitives | MVP |
|---|---|---|---|
| 规划 | `/team-plan <goal> [--mode feature\|debug\|review] [--publish]` | run import | ✓ |
| 确认发布 | `/team-publish <RUN> [--tasks ...]` | task publish | ✓ |
| 领任务干活 | `/team-dispatch <RUN> [--as <窗口名>] [--task <TASK>] [--role implementer\|reviewer\|verifier] [--loop]` | agent register（label 幂等，D17）→ claim-next（`--task` 定向领取）→ context hydrate → worktree register → …（reviewer/verifier 经 D15 合成工作项） | ✓ |
| 发现 run | `/team-runs` | run list | ✓ |
| 查 run 进展 | `/team-status <RUN>` | progress（含 **Needs user** 待人处理区块 + next_actions） | ✓ |
| 列任务 | `/team-tasks <RUN> [--status --owner]` | task list | ✓ |
| 查单任务 | `/team-task <RUN> <TASK>` | task show（含 evidence / review / verification / previous_attempts 摘要） | ✓ |
| 查证据 | `/team-evidence <RUN> <TASK>` | evidence show | ✓ |
| 补交证据 | `/team-submit <RUN> <TASK>` | submit | ✓ |
| 评审 | `/team-review <RUN> <TASK>` | review claim → approve / request-changes | ✓ |
| 验证 | `/team-verify <RUN> [--task <TASK>]` | verify | ✓ |
| 集成收尾 | `/team-integrate <RUN>` | integrate start → report | ✓ |
| 查依赖图 | `/team-graph <RUN>` | graph show / validate | P1 |
| 查上下文 | `/team-context <RUN> [<TASK>]` | memory show + hydrate 只读预览 | P1 |
| 审计 | `/team-audit <RUN>` | audit run | P1 |
| 留档 | `/team-export <RUN>` | export | P1 |
| 恢复管理 | `/team-reclaim <RUN> <TASK>`、`/team-pause` / `/team-resume <RUN>` | reclaim；run pause / resume | P1（MVP 经 status 的 next_actions 复制 CLI） |

### 底层：`.team` Primitives

这些命令属于 `.team` gateway。它们不做智能推理，只做状态读写、ID 分配/校验、锁、发布、认领、校验和事件记录。

```text
team run import
team run list
team run pause / resume / cancel / archive
team task add
team task publish
team task cancel
team claim-next
team heartbeat
team release
team reclaim
team context hydrate
team worktree register / adopt / list
team message post
team memory update
team submit
team block / unblock
team approve-paths
team review claim
team review approve
team review request-changes
team graph validate
team progress
team watch
team audit
team repair
team export
```

完整命令总表（读/写、锁、MVP 归属）以 [17](17-cli-mcp-contract-and-error-model.md) §1 为准。

**实现对齐注记（P5 收尾轮回填，2026-07-11——规则 3 显式执行）**：实现 CLI 依 D12 名 `sigmarun`，以下原语名在实现期定名或补全，本表按此对齐：
`team message post` → `sigmarun msg post` / `msg list [--open]`；`team progress` → `sigmarun status`（别名 `progress`）；`team verify` → `sigmarun verify submit`（task/run 双目标）；`team integrate start` 之外补 `integrate record [--failed]` 与 `report`（16 §4.1 记账/收尾半场）；`team block / unblock` 的 block 半场由 `review block`（14 §3.2 decision=block）触达，`unblock` 独立原语已落；新增 `resume`（15 §3.3 changes_requested→working 边）、`run show`（19 §3.2 dispatch 第 1 步）、`memory candidates`（25 §4 候选发现）、`memory promote`（25 §4）、`adapter install`（22 §安装）。`task add` / `run pause / resume / cancel / archive` / `worktree list` / `graph show` 尚未实现（P1）。

关键边界：

> Slash command 负责“让当前 agent 做智能工作”；primitive 负责“把事实原子写进 `.team`”。

换句话说，`/team-plan` 不是 `.team` 自己拆任务，而是“当前 coding agent 拆任务 + `.team` gateway 记录和发布任务”。

---

## 2. `/team-plan`

用户输入：

```text
/team-plan "实现 auth phase 1"
```

执行者：Claude Code / Codex / Cursor 中的 planning agent，以及被它调用的 `.team` gateway primitives。

Planning agent 职责：

1. 读项目上下文。
2. 识别目标类型：feature / debug / review / integration。
3. 拆解任务。
4. 生成 plan/task payload。
5. 调用 `.team` gateway 写入 run 和 task list。

`.team` gateway 职责：

1. 创建或校验 `RUN-ID`。
2. 写 `run.json`。
3. 写 `plan.md` 或保存 planning agent 提交的 plan。
4. 将任务 payload 写入 `team-task-list.json`。
5. 为任务分配或校验 `TASK-ID`。
6. 写 `tasks/<TASK-ID>/task.json` 和 `task.md`。
7. 写 `events.jsonl`。
8. 返回 `RUN-ID`。

不做：

- 不实现代码。
- 不 claim task。
- 不创建 task worktree。
- 不把任务直接标为 done。
- `.team` gateway 不读项目、不自行决定任务拆分。

返回示例：

```text
Created RUN-0001: Implement auth phase 1

Tasks:
- TASK-0001 Add auth domain model
- TASK-0002 Add session repository
- TASK-0003 Add auth API tests

Next:
/team-dispatch RUN-0001
```

---

## 3. `/team-dispatch RUN-ID`

用户输入：

```text
/team-dispatch RUN-0001
```

执行者：任意 coding agent。

职责：

1. 读取 `.team/runs/RUN-0001/run.json`。
2. 注册当前 agent。
3. 调用 `team claim-next --run RUN-0001 --agent <AGENT-ID>`。
4. 如果领取成功，调用 `team context hydrate --run RUN-0001 --task <TASK-ID>`。
5. 读取 context pack 中的 must-read refs、上游 handoff、open questions、risks。
6. 创建或进入 worktree。
7. 把 task 状态推进到 `working`。
8. 开始执行 task。
9. 执行中可用 `team message post` 记录 question / blocker / context_update。
10. 周期性 heartbeat。
11. 完成后 submit evidence 和 handoff memory。

返回示例：

```text
Joined RUN-0001 as AGENT-codex-001
Claimed TASK-0003: Add auth API tests
Worktree: ../.team-worktrees/RUN-0001/TASK-0003
Branch: team/RUN-0001/TASK-0003-auth-api-tests
```

---

## 4. `claim-next` 原子流程

`team claim-next` 必须是短事务：

```text
1. acquire locks/run.lock
2. read team-task-list.json
3. read task-claims.json
4. read path-claims.json
5. filter claimable tasks
6. choose highest priority task
7. create task claim
8. create path claims
9. update task-list index
10. append events.jsonl
11. release lock
```

筛选规则：

- `status == ready`
- `depends_on` 全部完成或满足当前 run policy
- role/capability 匹配
- 没有有效 task claim
- `paths.allow` 不与有效 path claim 冲突
- task 未被 block

输出：

```json
{
  "ok": true,
  "run_id": "RUN-0001",
  "task_id": "TASK-0003",
  "claim_id": "CLAIM-task-0007",
  "agent_id": "AGENT-codex-001",
  "lease_until": "2026-07-09T14:40:00+08:00"
}
```

没有可领取任务时：

```json
{
  "ok": false,
  "reason": "no_claimable_task",
  "run_id": "RUN-0001"
}
```

---

## 5. `/team-submit RUN-ID TASK-ID`

执行者：task owner agent；evidence 合同以 [14](14-evidence-review-verification-contract.md) 为准。

Owner agent 职责（组装 evidence）：

1. 收集 changed files（由 `git diff --name-status` 机械生成，不手填）。
2. 记录运行过的 commands；`required_checks` 每条必须附截断后的原始输出与 exit code（D8）。
3. 按 `task.json.acceptance` 逐条对齐 acceptance checklist。
4. 写 `context_ack`：声明已读的上游 refs（与 hydrate 的 must-read 对照）。
5. 写或更新 `context/tasks/TASK-0003.md` 作为下游 task handoff，evidence 中以 `handoff_ref` 指向它。

Gateway submit 事务（[14](14-evidence-review-verification-contract.md) §2.3）：

1. 校验 task 状态 == `working` 且调用者 == owner。
2. schema 校验 `evidence.json`：required_checks 逐条有输出、acceptance 与 task.json 逐条对齐、context_ack / handoff_ref 引用存在——全部机械校验。
3. `changed_files` × path claim 计算 `in_scope`（由 gateway 计算，不由 agent 自报）；越界文件按 policy 记 warning/error。
4. 落盘 `evidence/TASK-0003/`：`evidence.json` + `evidence.md` 骨架 + `outputs/`（截断+脱敏）。
5. 把 task 状态改为 `submitted`；task claim 同步转 `submitted`。
6. path claim 默认 hold 至 `integrated`（[15](15-run-task-state-machine-and-lifecycle.md) §4.2），downgrade 为 opt-in policy。
7. append `evidence_submitted`；校验失败整个事务回滚，task 留在 `working`。

Evidence 必须包含（结构化 schema 见 [14](14-evidence-review-verification-contract.md) §2.1）：

- summary
- changed files
- commands run
- command result
- acceptance checklist
- risks / deviations
- follow-up tasks
- context_ack（已读上游 refs）

Handoff memory 应包含：

- created / changed interfaces
- important decisions
- downstream notes
- unresolved questions
- source refs

---

## 6. `/team-status RUN-ID`

执行者：任意工具。

职责：

1. 读取 task list、claims、agents、events、evidence。
2. 重新计算或刷新 `progress.json`。
3. 输出 run 级状态。

示例：

```text
RUN-0001 Implement auth phase 1

Progress: 46%
Tasks: 8 total | 2 ready | 3 working | 1 review | 1 blocked | 1 done
Agents: 3 active | 1 stale
Risks: 1 path conflict, 1 stale lease

Next:
- Review TASK-0002
- Reclaim stale TASK-0005
```

---

## 7. `/team-task RUN-ID TASK-ID`

执行者：任意工具。

职责：展示单 task 全部相关事实。

应展示：

- task objective
- status
- owner agent
- claim lease
- worktree / branch
- paths
- dependencies
- acceptance
- evidence status
- review status
- verification status
- recent events

---

## 8. `/team-review RUN-ID TASK-ID`

执行者：reviewing agent。

流程：

1. claim review（review claim 模型见 [14](14-evidence-review-verification-contract.md) §3.1：run.lock 内检查 reviewer ≠ 历任 owner，单 task 同时最多一个 active review claim）。
2. 读取 task、evidence、changed files、diff。
3. 按 checklist 审查。
4. 选择：
   - approve
   - request changes
   - block
5. 写 `reviews/TASK-0003/REVIEW-TASK-0003-01.json` + `.md`（每轮新建 `-01/-02/...` 记录，永不覆盖，[14](14-evidence-review-verification-contract.md) §3.2）。
6. 更新 task 状态。
7. append event。

实现者不能 approve 自己的 task。

reviewer 角色也可自主领取：`claim-next --role reviewer` 会从 submitted 队列合成虚拟工作项，命中即落同一种 review claim（D15，[15](15-run-task-state-machine-and-lifecycle.md) §7），不必等人触发 `/team-review`。

---

## 9. `/team-verify RUN-ID`

职责：

- 运行 focused checks 或 full checks：**checks 由 agent 执行，gateway 只校验结构（exit_code 与 status 一致、output_ref 存在）并记录**（D11）。
- 写 `verification/VERIFY-*.json` + `.md`（target 可为 task 或 run，[14](14-evidence-review-verification-contract.md) §4）；`verification.md` 降级为派生索引。
- 更新 verified 状态（task 级 pass 驱动 `approved -> verified`）。
- run 级失败经 `failures_mapped[]` 映射回 TASK-ID，对应任务转 `changes_requested`。

最小 gate：

- build/compile
- unit/focused tests
- regression tests
- scope check
- evidence completeness

---

## 10. `/team-integrate RUN-ID`

完整流程以 [16](16-git-worktree-and-team-root.md) §4 为准，此处只留摘要：

1. `team integrate start`：run 转 `integrating`，从当前 base tip 创建 integration branch（`team/RUN-ID/integration`）。
2. 按 DAG 拓扑序（同层 priority desc、TASK-ID asc）逐个 `merge --no-ff` verified task branch。
3. 冲突由 integrator 解决，摘要写 `integration.md`，重大取舍写 message pool。
4. 某 task merge 后 checks 失败 → revert 该 merge，task 转 `changes_requested`，继续合下一个（失败不卡全局）。
5. 收尾跑 run 级全量 verification，写 `integration.md` + `report.md`，task 推进到 `integrated` / `done`。
6. **MVP 不自动合 main**：产出 integration branch + 报告，最后一步由用户发 PR / 手动合并。

---

## 11. Event Types

完整事件目录与 `team.event.v1` schema 以 [18](18-audit-rule-catalog-and-trust-model.md) §2–3 为准。此处保留 MVP 核心子集：

```text
run_created
task_created
task_published
agent_registered
task_claimed
path_claimed
worktree_created
heartbeat
task_started
evidence_submitted
review_claimed
review_approved
changes_requested
task_blocked
verification_started
verification_passed
verification_failed
task_integrated
run_reported
```

注：`review_requested` 已废弃——submit 即视为请求 review，语义并入 `evidence_submitted`（[18](18-audit-rule-catalog-and-trust-model.md) §8）。
