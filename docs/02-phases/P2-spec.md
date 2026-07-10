# P2 Spec — sigmarun（Functional Spec）

> 2026-07-10 正式化（取代同名缺口文档）。输入：P1（UC-001…009、NFR、ASM）。
> 本文写"对外可观察行为"；内部机制（锁实现、文件布局、包结构）属 P3，见语料库。BDD 场景：`BDD-UC-001…009.feature`（共 55 场景；2026-07-10 外审后补 requires_approval 与 run cancel 四场景）。

## 1. 概述

- 范围：MVP 全部用户可观察行为（UC-001…009）。
- 读者：实现者（转测试用例）、reviewer（判定行为对错的依据）。
- 交互形态：slash 命令（人⇄agent）与 `sigmarun` CLI（agent⇄gateway）；一切 CLI 响应为统一 envelope（`ok/code/message/data/warnings/next_actions`，英文，D16）。

## 2. 用户触发与系统响应（按 UC）

| UC | 触发 | 成功响应（可观察） | 失败响应（code → 行为） | BDD |
|---|---|---|---|---|
| UC-001 规划 | `/team-plan "<goal>" [--mode]` | RUN-ID + 任务映射表 + warnings + 下一步 | `schema_invalid`→逐条错误，零落盘；payload 指纹重复→拒并指向既有 RUN | BDD-001-01…05 |
| UC-002 发布 | `/team-publish <RUN> [--tasks]` | ready 数量；run→active | `run_not_active`（发布前领取）；`cross_run_conflict`（block 策略） | BDD-002-01…04 |
| UC-003 领取执行 | `/team-dispatch <RUN> [--as] [--loop]` | TASK-ID + 租约 + 必读集；完成即停汇报 | `no_claimable_task`/`deps_blocked`/`path_conflict`/`agent_claim_limit`/`requires_approval`→呈报即止 | BDD-003-01…08 |
| UC-004 点名 | `…--as <名> --task <TASK>` | 指定任务被该窗口领取 | `task_already_claimed` 等→报因停止，禁止改领 | BDD-004-01…03 |
| UC-005 提交 | `/team-submit <RUN> <TASK>` | 任务→submitted（或直通 approved 留痕）；证据可查 | `evidence_invalid`→逐条缺失，任务留 working | BDD-005-01…08 |
| UC-006 评审验证 | `/team-review`、`/team-verify`、reviewer 角色 dispatch | 评审记录多轮留档；verified 有 pass 记录 | `self_approval_forbidden`；退回无必改项被拒 | BDD-006-01…07 |
| UC-007 监工恢复 | `/team-status`、`sigmarun watch/reclaim/repair`、`approve-paths`、`run cancel` | 进度+风险+Needs user（命令可复制）；自动回收带进展；批准/取消经确认生效 | `rev_conflict`→审计路径；崩溃→repair 前滚/回滚 | BDD-007-01…09 |
| UC-008 集成留档 | `/team-integrate`、`sigmarun export` | 集成分支+报告；导出清单待用户提交 | 合并失败单点 revert；`export_redaction_hit`→中止列位置 | BDD-008-01…05 |
| UC-009 决策传承 | `sigmarun memory promote`；plan/hydrate 自动读 | MEM 条目带出处；新 run 自动继承 | `memory_entry_invalid`（无 refs/命中 secret） | BDD-009-01…06 |

## 3. 状态变化总览

对外可观察的状态生命周期（权威定义与转换权限矩阵在 15 号，行为面等同）：

- Run：`planned → active ⇄ paused → integrating → reported → archived`；`planned/active/paused/integrating` 可 `cancelled`（**reported 不可 cancel，只能 archive**——15 §2.3，2026-07-10 对齐）。
- Task：`draft → ready → claimed → working → submitted → reviewing → approved → verified → integrated → done`；分支：`blocked ⇄ working`、`changes_requested → working`（返工）、`reviewing → submitted`（评审租约过期）、任意非终态 → `cancelled`。
- 用户可见约束：`stale` 不是状态而是标注；没有 submit 就没有任何"完成"外观（F1）。

## 4. 业务规则

### BR-001 任务可领取判定（守卫式短路，合并穷举之理由：任一失败即短路返回该原因）

| # | 守卫（按序） | 不满足时 code | BDD 覆盖 |
|---|---|---|---|
| 1 | run 存在且 active（integrating 时仅限 review/verify/integration 类型） | `run_not_found` / `run_not_active` / `run_paused` | BDD-002-02 |
| 2 | agent 已注册且 active（label 幂等） | `agent_not_registered` | BDD-003-05 |
| 3 | agent 未达 `max_active_claims_per_agent`（默认 1） | `agent_claim_limit` | BDD-003-04 |
| 4 | 存在 status=ready 的候选（`--task` 时即该任务） | `no_claimable_task` / `task_already_claimed` | BDD-003-02、004-02 |
| 5 | 候选 depends_on 全部满足 | `deps_blocked` | BDD-004-03 |
| 6 | role/capability 匹配（reviewer/verifier 走合成工作项队列） | `capability_mismatch` | BDD-006-01 |
| 7 | 无路径冲突（run 内 block 策略；跨 run 按 `cross_run_path_policy`） | `path_conflict` / `cross_run_conflict` | BDD-003-03、002-04 |
| 8 | `requires_approval` 路径已获批准 | `requires_approval` | BDD-003-08（claim 拦）、005-08（submit 双向）、007-08（Needs user 闭环）（外审 finding 1 修复） |
| 9 | 未超 run 并行上限 | `parallel_limit_reached` | （P5 压测覆盖——纯并发上限，无用户旅程分支，豁免仅此一行） |

行数说明：完全交叉 = 各守卫独立布尔，穷举无意义；短路语义下每行一个失败面 + 一条全通过的成功路径（BDD-003-01），覆盖完备。

### 其余业务规则（引用式）

- BR-002 返工环占用不释放：submit 后 path claim 默认 hold 至 integrated（15 §4.2）→ BDD-006-04。
- BR-003 自批禁令跨开关生效：INV-008 不受 require_review 影响 → BDD-006-02、005-07。
- BR-004 回收三阶：过期即标注（读取时）→ 3×TTL 自动回收（sweep）→ 永远保留进展（previous_attempts）→ BDD-007-02/03。
- BR-005 记忆条目必须有出处：无 refs / refs 失效 / 命中 secret 一律拒收 → BDD-009-02。

## 5. 错误恢复旅程

> "用户看到"一律为人话 + 下一步；机器码只出现在 data 中。全部失败必带 next_actions（NFR-009）。

### ERR-001 领不到任务（no_claimable_task / deps_blocked / path_conflict / agent_claim_limit）
| 步骤 | 用户看到 | 系统行为 | 引导 |
|---|---|---|---|
| 1 | "当前没有你能领的任务：<原因>"（如"路径被 TASK-0002 占用"） | 零状态变更 | 给出等待对象或替代命令 |
| 2 | 复制执行建议命令（如查 status / 换角色 / 点名其他任务） | — | 回到正轨 |
关联：BDD-003-02/03/04、004-02/03；NFR-009。

### ERR-002 证据被打回（evidence_invalid）
| 1 | "提交未通过：缺 X 的输出 / 验收第 2 条未对齐"（逐条） | 任务留 working，零半写 | 修哪条清清楚楚 |
| 2 | agent 补齐后重交（revision 不变，仍是首轮） | 门禁重校 | 通过即 submitted |
关联：BDD-005-02/03；14 §2.3。

### ERR-003 窗口掉线（stale → 自动回收）
| 1 | status 中该任务标"stale（过期 Xmin）" | 只标注不改状态 | 可等自动回收或复制 reclaim 命令 |
| 2 | 超 3×TTL："已自动回收，进展快照已留" | claim→reclaimed、任务→ready、previous_attempts 落盘 | 任一窗口可再领，续做或重做 |
关联：BDD-007-02/03；NFR-002。

### ERR-004 导出被拦（export_redaction_hit）
| 1 | "导出中止：以下文件疑含密钥（文件:行）" | 目标目录零产出 | 清理后重试 |
| 2 | 用户清理/确认误报（allowlist）后重跑 export | 二次全量扫描 | 通过即出档 |
关联：BDD-008-04；NFR-004。

### ERR-005 账本异常（rev_conflict / seq 断号 / 崩溃残留）
| 1 | "检测到状态文件被绕过修改/事务残留" | 拒绝本次写 | 复制 `team audit run` |
| 2 | audit 报告逐条 findings | 只读 | 复制 `team repair` |
| 3 | "已修复 N 项（有备份），M 项需人工" | 前滚/回滚 + state_repaired 事件 | 剩余项逐条给路径 |
关联：BDD-007-05/06；NFR-005。

### ERR-006 环境与查找失败（外审 finding 2 补，2026-07-10）
（run_not_found / task_not_found / agent_not_registered / not_a_git_repo / bare_repo_unsupported / team_root_not_found / worktree_missing / worktree_dirty / usage_error / io_error）
| 步骤 | 用户看到 | 系统行为 | 引导 |
|---|---|---|---|
| 1 | "找不到 X / 环境未就绪：<人话原因>"（如"当前目录不在 git 仓库内"） | 零状态变更 | 查找类→给正确的 list/show 命令；环境类→复制 `sigmarun doctor` |
| 2 | doctor 逐项报告哪里不满足（git、锁、命令、schema） | 只读自检 | 每个不满足项带修复建议 |
| 3 | worktree 异常按 16 §8 场景表给恢复路径 | — | adopt / reclaim / 人工清理三选一 |
关联：机器面验证宿主 = 17 §12 合同回归（每个 reason code ≥1 用例，NFR-009）；worktree 场景另有 BDD-003-06。

## 6. 错误码总表（行为面；全量权威 = 17 §3）

| code（组） | UC | 恢复旅程 |
|---|---|---|
| schema_invalid / memory_entry_invalid | UC-001/009 | 逐条报错即引导（无独立旅程） |
| run_not_active / run_paused / cross_run_conflict | UC-002 | ERR-001 |
| no_claimable_task / deps_blocked / path_conflict / task_already_claimed / agent_claim_limit / capability_mismatch / requires_approval / parallel_limit_reached | UC-003/004 | ERR-001 |
| evidence_invalid | UC-005 | ERR-002 |
| self_approval_forbidden / invalid_transition | UC-006 | 即时拒绝 + next_actions |
| lock_timeout | 全部写操作 | 重试引导（17 §4） |
| rev_conflict | UC-007 | ERR-005 |
| export_target_invalid / export_redaction_hit / backup_target_invalid | UC-008 | ERR-004 |
| unsupported_schema_version | 全部 | migrate 引导（21 §4） |
| run_not_found / task_not_found / agent_not_registered | 全部（查找失败） | ERR-006 |
| not_a_git_repo / bare_repo_unsupported / team_root_not_found | 全部（环境未就绪） | ERR-006（doctor 引导） |
| worktree_missing / worktree_dirty | UC-003/007 | ERR-006 + 16 §8 恢复路径 |
| path_escape_detected | UC-005/008 | 即时拒绝 + `team audit paths`（24 §6） |
| usage_error / io_error | 全部（兜底） | ERR-006（usage 附正确语法；io 转 doctor） |

**覆盖声明**：本表 = [17 §3](../17-cli-mcp-contract-and-error-model.md) 全部 reason code 的 UC/旅程映射（2026-07-10 外审后补全）；每个 code 的机器面验证宿主为 17 §12 合同回归（每 code ≥1 触发用例）。

## Gate G2（2026-07-10 更新）

| Gate | Status | Evidence |
|---|---|---|
| G2-1 主/分支/异常齐全 | PASS | §2 每 UC 三列 + 15/17 权威引用 |
| G2-2 每 UC 每分支 ≥1 BDD | PASS | BDD-001…009 共 55 场景，覆盖 §4 UC 全部扩展流程；豁免仅剩 BR-001 行 9（parallel_limit，纯并发上限归 P5 压测）——行 8 requires_approval 经外审纠正已由 BDD-003-08/005-08/007-08 覆盖 |
| G2-3 决策表 | PASS | BR-001 守卫表（短路合并理由已书面化）+ 18 §4 字段级触发条件 |
| G2-4 错误恢复 | PASS | ERR-001…006 + §6 全量映射覆盖 17 §3 **全部** reason code（外审 finding 2 修复：查找/环境/worktree/兜底类补 ERR-006 与 doctor 引导）；"用户看到"列零技术黑话 |
| G2-5 矩阵 BDD 列 | PASS | [traceability-matrix.md](traceability-matrix.md) 已回填 |
| G2-6 无实现细节 | PASS | 本文只含行为与命令面；表名/锁实现/包结构均留在 P3 语料库 |
