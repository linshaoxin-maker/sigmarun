# FEAT-008 MVP Scope — status/watch/audit/repair 与查询面（复合，子项 008.1–008.4）

> 源：05 Slice 7 ｜ 锚：UC-007 + BDD-007-01/06/07 + Slice 7 验收全表 ｜ 合同：17 §5.3/§7、18 全目录（§7 envelope/exit-0 语义）、23 §4（Needs user）、M32、INV-006、D9/D14

## 008.1 status + 查询面（新包 `@sigmarun/watch`）

- `status <RUN>`：状态计数（ready/working/submitted/blocked/done…）、**按 weight 的 progress**（done 权重/总权重）、风险区（stale lease——blocked 豁免；未回应 blocker）、open questions、**Needs user 区块**（M32 四类：批准待授/blocker 待人/停等确认（留 FEAT-009 追加 changes_requested 类）/回收确认——每项带可复制命令）；同步落 `progress.json`（derived，team.progress.v1，无 rev，可删重算）。
- `run list`（全部 run 概要）、`task show <RUN> <TASK>`（task.json+claims+attempts+evidence 摘要）、`evidence show <RUN> <TASK>`（checks/acceptance/outputs/revision 历史）——与 .team 事实逐字段一致。

## 008.2 watch（同包）

- `watch <RUN> [--interval 30] [--once] [--force]`（17 §7）：单实例 advisory 锁 `locks/watch.lock`（第二实例拒，--force 越过）；每 tick：**sweep（与 claim-next 同一段代码）→ 无锁重算 progress → 快照**；run 终态自动退出；`--once` 单轮（外部 cron 用）。MVP 测试面为 --once + 单实例 + 终态；循环模式实现但不进自动化（长驻进程）。
- **随做修复（FEAT-004 隐患）**：sweep 的 claims/list 持久化此前悬挂在 finishClaim 之后——sweep 后守卫失败会留下"task.json ready + 事件已记 + claims 仍 active"的半提交。提取 `sweepRun` 原语（watch/claim-next 共用），sweep 有动作即先持久化。

## 008.3 audit（新包 `@sigmarun/audit`）

- `audit run <RUN>`：**只读、无锁、exit 0**——findings 是数据不是失败（18 §7）；envelope data：findings[{rule_id, severity, message, next_action, refs}] + rules_run[] + rules_skipped[{rule_id, reason}] + concurrent_writes_detected。
- 本期落地 14 条（数据面已存在）：AUD-001/002/003（blocked 豁免）/004/011/013/014/021/022/029/030(a)/031/033/035。
- 其余 26 条**登记跳过 + 原因**：review/verify 面（005–010/012/015–020）随 FEAT-009/010；memory 面（036–040）随 FEAT-011；AUD-032 **挂账**——写事务事件的 `rev_after` 字段（18 §3）未随 FEAT-002…007 落地，登记为实现债（回填入下一步队列）；AUD-034 重放引擎 P1。

## 008.4 repair（同包 audit）

- `repair <RUN>`（17 §5.3）：对照 events 账本机械修复——events.meta 计数器漂移前滚；task.json 与 list 行状态漂移以**事件链末态**为准修复；派生物（progress.json）重算；**执行前自动备份**（.team/backups/<ts>/）；每项修复写 `state_repaired` 事件；**幂等**（二跑 no-op 且不再写事件）；修不了的进 findings 交人工。

## Out（书面）

- watch 的 NDJSON 行合同（P2 read-model 定稿）、dashboard 文件轮询端（23 §6）。
- `--fail-on error` CI 门禁参数、audit 子命令分组（evidence/claims/…）→ P1。
- AUD-032（rev_after 债）、AUD-034 重放引擎 → 登记跳过；team-status/tasks/task/evidence 四个 adapter 模板随本 FEAT 补装 → **收窄**：模板补装并入 FEAT-009 一次做（避免连续两次改 adapters 包）——书面改派。
