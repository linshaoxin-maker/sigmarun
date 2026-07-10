# FEAT-003 MVP 范围 — publish（draft→ready，run 激活）

> 源：Slice 2.5、[15 §6/§2](../../15-run-task-state-machine-and-lifecycle.md)、D18、[16 §5](../../16-git-worktree-and-team-root.md) ｜ 锚：BDD-002-01…04（-02 的 claim 半场归 FEAT-004）、UC-002

## 本期交付

- `sigmarun task publish <RUN> [--tasks=TASK-0001,…] [--force]`：run.lock 事务内 draft→ready（task.json + task-list 双写）；首次发布触发 run `planned→active`；events `task_published`×N + `run_activated`（提交点写序）。
- 守卫：run 不存在→`run_not_found`；run 状态 ∉ {planned, active}→`run_not_active`（exit 7）；`--tasks` 指向不存在任务→`task_not_found`；已 ready 任务→跳过 + 警告（幂等语义）。
- **D18 跨 run 检查**（发布前置，零变更先判）：与其他 active/integrating run 的 `paths.allow` 保守重叠（glob 前缀祖先法，10 §8.2）——`warn`（默认）：警告 + `cross_run_overlap_detected` 事件；`block`：拒绝 `cross_run_conflict`（exit 6），`--force` 越过。
- ReasonCode 扩：`run_not_found` / `task_not_found` / `run_not_active` / `cross_run_conflict`（17 §3 既有，enum 落地）。

## 本期不交付 / 说明

- claim 侧的 `run_not_active` 拒领（FEAT-004）；完整 minimatch 重叠判定（FEAT-004 dispatch/path-conflict，本期为保守前缀法并书面标注）；`import 的 ready 降级`维持——publish 永远是显式用户动作（R-002/UC-002），`/team-plan --publish` 由 adapter 链式调用实现（09 §11 口径），降级警告文案改指向本命令。
