# P4 Feature — sigmarun / Team Run Protocol

> 状态：视图 + 定稿层（[../05](../05-mvp-feature-slices.md) 九切片是底稿，此处映射为 FEAT 并做四问检验）｜ 2026-07-10

## FEAT 清单（Slice → FEAT 映射）

| FEAT | 名称 | 源 Slice | 用户可见价值（四问检验） | 类型 |
|---|---|---|---|---|
| FEAT-001 | `.team` 基座 + init/doctor | S1 | 可感知：init 后 doctor 全绿、目录可查 | **enabler**（正当性：一切事实源的载体） |
| FEAT-002 | plan 导入（payload→RUN-ID） | S2 | `/team-plan` 返回 RUN 与任务表 | 用户可见 |
| FEAT-003 | publish 确认发布 | S2.5 | `/team-publish` 后队列可领 | 用户可见 |
| FEAT-004 | claim-next 并发认领 + 锁 + 回收 | S3 | 双窗口领不到同一任务；掉线自动回收带进展 | 用户可见（并发演示） |
| FEAT-005 | Context Plane（DAG/消息/hydrate） | S4 | 下游任务自动带上游 handoff | 用户可见 |
| FEAT-006 | dispatch 端到端（--as/--task/--role/--loop） | S5 | 起名、点名、专职、连跑 | 用户可见 |
| FEAT-007 | evidence 门禁 submit | S6 | 无证据不算完成；evidence 面板可查 | 用户可见 |
| FEAT-008 | status/watch/audit/repair 与查询面 | S7 | 进度、风险、"等你处理"清单；audit 体检与 repair 修复；runs/tasks/evidence 查询命令 | 用户可见 |
| FEAT-009 | review gate（含 D15 自主领取） | S8 | reviewer 窗口自动接审；自批被拒 | 用户可见 |
| FEAT-010 | verify + integrate + export | S9 | 集成分支 + 报告 + 脱敏留档 | 用户可见 |
| FEAT-011 | project memory promote（L4） | S10（P1 首位） | 决策晋升；新 run 自动继承 | 用户可见 |

依赖 DAG：`001→002→003→004→005→006→007→008→009→010`，`011` 依赖 `007/010`——线性主链 + 一条尾巴，**无环**。demo 脚本 = [../00 §3](../00-user-guide.md)（完整走法）+ 北极星验收句。

## Gate G4

| Gate | Status | Evidence / 原因 |
|---|---|---|
| G4-1 四问检验 | PASS | 上表逐条；唯一 enabler（FEAT-001）已给正当性 |
| G4-2 粒度分类 | PASS | 单元粒度=05 切片；复合 FEAT-008/010 已按命令面分解为 7 个独立验收子项（见"复合 FEAT 子项分解"表，外审 finding 4 修复） |
| G4-3 依赖无环 | PASS | 上文 DAG（线性 + 尾巴） |
| G4-4 demo 脚本 | PASS | 00 §3 + 北极星 + 17 §10 测试场景 |
| G4-5 feature impact matrix | PASS | 下文 §impact matrix（2026-07-10 补齐） |
| G4-6 traceability FEAT 列 | PASS | [traceability-matrix.md](traceability-matrix.md) 主矩阵 FEAT 列已回填（含 enabler 豁免说明） |
| G4-7 feature flag | N/A | 本地 CLI，无灰度发布面 |
| G4-8 回滚计划 | PASS | npm 版本回退 + `team backup`/migrate 备份机件（21 §5、22 §7） |

## Feature Impact Matrix（2026-07-10，关闭 G4-5 / G3-12）

FEAT × 主要包（20 §3）× 触碰的状态面 × 守门（P0-inline AUD / 关键验收）：

| FEAT | 主要包 | 状态面 | 守门 |
|---|---|---|---|
| 001 基座 | storage、core/schemas、cli | `.team/` 布局、counters、locks | doctor 自检；NFR-006 round-trip |
| 002 plan 导入 | core/lifecycle、storage | run.json、task-list、task-graph、events | schema_invalid 全表（09 §8）；DAG 环阻断（AUD-021）；D17 指纹 |
| 003 publish | core/state-machine、lifecycle | task-list、run status、events | run_activated 链；D18 跨 run 检查 |
| 004 claim+回收 | dispatch/claim-engine、path-conflict、storage/lock-manager | claims 三件套、path-approvals、agents、counters | 双认领阻断（AUD-001）；path 重叠（AUD-002）；requires_approval 批准流（AUD-004）；per-agent 上限（AUD-040）；NFR-001/002 压测 |
| 005 Context Plane | context/*（hydrator、message-pool、graph-validator） | context/*、task-graph、events(context_hydrated) | AUD-021/022/028；INV-012 |
| 006 dispatch 端到端 | cli、adapters(19 模板)、claim-engine | agents(label)、worktrees.json | conformance 十步；UX-003/004；F-c 负路径 |
| 007 evidence 门禁 | core/lifecycle(submit)、storage/redaction | evidence/、claims 状态、events | AUD-011…015（P0-inline）；NFR-004 夹具 |
| 008 status/watch/audit/repair | core/progress、watch、audit-engine、repair | progress.json(派生)、watch.lock、backup/（repair 前备份） | Needs user 区块；F2 现算断言；AUD 全 40 条批跑；state_repaired 链路（17 §5.3） |
| 009 review gate | claim-engine(review)、state-machine | review-claims、reviews/ | INV-008（P0-inline）；D15 合成；BDD-006 全组 |
| 010 verify+integrate+export | lifecycle、redaction、（git 只读调用） | verification/、integration.md、export 目标 | 失败 revert 语义；export 阻断（NFR-004） |
| 011 memory promote | context/memory-store、lifecycle | docs/team/MEMORY.md、counters(MEM)、events | memory_entry_invalid；体积 warning；BDD-009 全组 |

横切：全部 FEAT 过 17 §2 envelope 合同回归 + 三平台 CI（NFR-007）；004/007/009 含 P0-inline 审计子集（13 §6.1 强制）。

### 复合 FEAT 子项分解（2026-07-10 外审 finding 4：粒度证据补强）

FEAT-008/010 编号不拆（依赖链与追溯矩阵稳定），内部按命令面分解为独立可验收子项——P5 实现时按子项出实现与测试，任一子项缺验收即 FEAT 不得关闭：

| 子项 | 内容 | 验收锚 |
|---|---|---|
| 008.1 status + 查询面 | `/team-status`、run list/show、task show、evidence show | 05 Slice 7 查询面行、BDD-007-01 |
| 008.2 watch | 单实例锁、30s tick、sweep 触发、终态退出 | 05 Slice 7 watch 行、BDD-007-07、17 §7 |
| 008.3 audit | AUD 全 40 条批跑 + envelope/exit 0 语义 | 05 Slice 7 P0-inline/envelope 行、18 §7 场景表 |
| 008.4 repair | 事件账本前滚/回滚、执行前备份、state_repaired、幂等 | 05 Slice 7 repair 行、BDD-007-06、17 §5.3 |
| 010.1 verify | VERIFY 记录、gates、failures_mapped 返工 | 05 Slice 9、BDD-006-06/07 |
| 010.2 integrate + report | 拓扑序合并、失败 revert 不卡全局、集成报告 | 05 Slice 9 revert 行、BDD-008-01…03 |
| 010.3 export | 脱敏阻断式二次扫描、留档清单待用户提交 | 05 Slice 9 export 行、BDD-008-04/05 |

**结论**：G4 全绿（G4-7 N/A 留痕）。开工顺序 FEAT-001→010（011 为 P1 首位）；每个 FEAT 开工时在 [../05-features/](../05-features/README.md) 建 `FEAT-XXX/` 走 P5 流程。
