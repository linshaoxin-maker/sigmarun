# FEAT-004 MVP Scope — claim-next + 锁 + 回收

> 源：05 Slice 3+4 ｜ 锚：UC-003 全组（BDD-003-01…08）+ BDD-004-02/03 + BDD-002-02 + BDD-007-02/03 ｜ 合同：10 全文、15 §3–5、BR-001、18 事件 #12/16/17/22/24/26/41、D9/D17、AUD-001/002/003/004（前两者+004 inline）

## In

- **新包 `@sigmarun/dispatch`**（20 §3 第 4 包）：claim-engine + 租约/回收；依赖 core+storage。
- `agent register`：label 幂等（D17，BDD-003-05）；`AGENT-<tool>-%03d`（run counters `next_agent`）；agents/*.json（team.agent.v1，无凭据/机器指纹）。
- `claim-next`：run.lock 单事务内 **sweep → BR-001 九守卫按序短路 → 排序选取 → 写入**：
  - 排序（10 §7）：priority desc → dependency depth asc → weight desc → task_id asc（created_at 与 task_id 同序，合并）。
  - 写入：task-claims/path-claims 追加（CLAIM-task/path-%04d 共用 `next_claim`）、task.json+list 行 ready→claimed、agents.current_task_id、events `task_claimed`+`path_claimed` 提交点。
  - 失败结构化（10 §2.3）：directed 返回具体守卫码；undirected 返回 `no_claimable_task` + `data.excluded[{task_id,reason}]`；path_conflict 带 `blocked_by`。
  - `--task` 定向（D17）、`--dry-run`（零写入）、`--role` 过滤。
  - requires_approval 守卫（BR-001 行 8 / AUD-004 inline）：无 granted 覆盖即拒；MVP 覆盖判定 = glob 字符串相等。
- `approve-paths`：path-approvals.json（granted 条目）+ `path_approval_granted` 事件——行 8 的放行半场。
- `heartbeat`：续租 lease_until=now+TTL + agents 心跳（事件按 18 允许采样，MVP 每次写）。
- `release`（owner）：claim released + task→ready + `previous_attempts` 追加 + path claims 同步释放 + `task_released`。
- `reclaim`（manual，user）：**仅限已过期租约**（未过期 → invalid_transition）；`task_reclaimed`（reclaim_reason=stale_lease_manual）。
- **sweep（惰性，D9/BR-004）**：claim-next 事务内执行；`now > lease_until + (multiple−1)×TTL`（multiple 默认 3 ⇒ 距 acquire 3×TTL）自动回收，`task.status=blocked` 豁免（AUD-003）；actor=sweep，payload.triggered_by=触发 agent。
- BR-001 行 1 补全：run planned→`run_not_active`（BDD-002-02，FEAT-003 留债）、paused→`run_paused`、integrating→候选限 review/verify/integration 类型。
- 守卫码全量入 enum+exit：agent_not_registered(5)、run_paused(7)、task_already_claimed/path_conflict/requires_approval(6)、no_claimable_task/deps_blocked/capability_mismatch/parallel_limit_reached/agent_claim_limit(1 兜底)。

## Out（书面）

- worktree 实建/hydrate/dispatch 编排 → FEAT-005/006（本 FEAT 仅返回 worktree 建议字段，10 §2.2）。
- review claim 合成队列（D15）→ FEAT-009；cross-run 声明式检查已随 FEAT-003。
- NFR-001 16 并发压测 → P5 压测项（CI）；本 FEAT 以顺序双 agent 用例锚互斥语义。
- minimatch 级 glob 交集（AUD-002 全量）→ FEAT-007 evidence in_scope 一并引入；本 FEAT 沿用保守前缀法（10 §8.2 允许）。
- lock_takeover 事件挂账：storage.acquireLock 尚无事件出口，随 FEAT-008 audit/repair 面接线（原 FEAT-004 挂账顺延，理由：接管点在 storage 层，事件写入需 runDir 上下文，dispatch 不总持有）。

## 契约新增（backflow 显式）

- `claim_not_found`(5)、`not_claim_owner`(6)：heartbeat/release 对非本人/不存在的 claim 的拒绝码——17 §3 未列，实现期定名，**回填 docs/17 §3**（规则 3）。
