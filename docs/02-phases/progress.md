# Progress — sigmarun

> Mode: Full ｜ Layout: workspace-grouped ｜ Resolved root: `Multi-Agent/sigmarun/docs/`
> 项目根 = `Multi-Agent/sigmarun/`（git 仓库，2026-07-10 建立）；语料库（00–25）与本工作区同住 `docs/`，phase 文档为 gate/索引视图；实现代码随 P5 在仓库根生长（`packages/` 九包）。

## 2026-07-10

- 方法论工作区建立（01-current-state / 02-phases / 03-architecture / 04-decisions / 05-features）。
- 阶段判定：P0 基本 PASS（缺 glossary）；**P1 FAIL（最大缺口：stories/UC/NFR 未形式化）**；P2 部分（缺 UC 锚定 BDD）；P3 基本 PASS（缺 impact matrix、STRIDE 表）；P4 部分（FEAT-001…011 已映射，缺 impact matrix）；P5 未开始。
- 决策账本 D1–D19；Codex 触发两轮实测通过；`sigmarun` 定名。

## 2026-07-10（P1/P2 补齐会话）

- **P1 定稿**：R-001…013（每条带成功标准）、UC-001…009 内嵌、NFR-001…009（六列九类）、UX-001…005、ASM-001…006、安全合规节、[glossary.md](glossary.md)——G1 全绿。
- **P2 定稿**：Functional Spec（触发/响应/状态总览）、BR-001 守卫决策表、ERR-001…006 错误恢复旅程、17 §3 全量错误码映射、**BDD-UC-001…009 共 55 场景**——G2 全绿（豁免仅 BR-001 行 9 压测项）。
- **挂起 gate 全关**：G0-5（glossary）、G3-7/18（矩阵锚定）、G3-12+G4-5（Feature Impact Matrix 入 P4）、G3-14（24 §1.4 STRIDE 六维表）、G4-6——**P0–P4 全绿**（G3-17/G2-6 SKIPPED 留痕、G4-7 N/A）。
- traceability 主矩阵 Story→UC→BDD→NFR→Component→FEAT 六列无断链；Files/Tests/Result 留 P5 回填。

## 2026-07-10（18/23 号补验 + 漏洞修复轮）

背景：18/23 号由上一进程的后台 agent 写成，完成通知丢失导致**从未过我方验收**（用户点名复查，命中）。全文校验结论：两份质量合格且与全集一致（18 的 AUD-021…028 与 12 号引用吻合；23 的只读边界 N1–N8 与刷新裁决成立）。修复项：

- **18 号 v0.2 增补**：补 4 个晚于其写作的事件（state_repaired / memory_promoted / memory_superseded / run_migrated）+ agent label 字段（D17）+ **AUD-036…040**（L4 记忆四条 + per-agent 上限绕过检出）——规则总数 35→40，`memory` 审计子命令入映射表。
- **18 §8 修订指令补执行**：14 §8 回填正式 AUD 编号；16 遗留接口回填 029/030/031；05 Slice 7 验收补 P0-inline 五条 + audit envelope 断言；15 的 `reviewing→submitted` 边经核已在（疑为 18 号 agent 越范围顺手回填，内容正确，收录）。
- **23 号增补**：§4.4 补 L4 项目记忆面板（D19 晚于其写作）；12 §12 补三种边注记。
- **P4 对齐**：FEAT-008 范围明确为 status/watch/audit/repair 与查询面；impact matrix 004/008 行补 path-approvals、AUD-004/040、repair/backup 链路。
- 教训（知识条目候选）：后台 agent 跨进程存活时完成通知可能丢失——**凡未见完成回执的委派产物，一律按未验收处理**；这正是本产品 evidence 门禁（F1）要解决的问题在自己身上的镜像。

## 2026-07-10（Codex 独立外审 → 修复轮）

外审判定"带条件可用"，5 findings（4×P1、1×P2）逐条核实：**四条属实已修，一条属实但采用多归属修法**；另顺带发现并补执行 24→17 的 `path_escape_detected` 指令。

- F1 requires_approval 豁免不当（属实）：撤销豁免，新增 BDD-003-08（claim 拦截）、005-08（submit 双向 Outline）、007-08（Needs user 批准闭环）；BR-001 行 8 回填，豁免收窄至仅行 9。
- F2 错误码覆盖不全（属实）：P2 §6 扩为 17 §3 全量映射（补查找/环境/worktree/兜底四组），新增 ERR-006（doctor 引导）；G2-4 证据重写。
- F3 run cancel 口径矛盾（属实）：裁决 `integrating` 可 cancel（合并中止、integration branch 保留）、`reported` 不可 cancel 只能 archive；15 状态图+矩阵、P2 §3 同步；新增 BDD-007-09 级联场景。
- F4 FEAT-008/010 过粗（属实）：编号不拆，P4 增"复合 FEAT 子项分解"表（008.1–.4、010.1–.3，各带验收锚）；05 Slice 7 补 watch/repair/查询面验收、Slice 9 补 revert/export 验收；G4-2 证据重写。
- F5 矩阵 BDD-003-04/05 错挂（属实，修法微调）：确立**多归属规则**（主挂物理所在 UC、复用行括注），UC-003/004 行修正。
- BDD 51→55；相关计数全集同步（P2/矩阵/README/current-state）。

## 2026-07-10（P5 开工 · FEAT-001 交付）

- **Feature DAG 定稿**（05-features/README.md，mermaid，无环，执行纪律：按序单开、gate FAIL 不进下一个）。
- **TS monorepo 建立**：npm workspaces + tsc -b 项目引用 + vitest（src-alias 测试）；三包落地 storage/core/cli（20 §3 九包的首批）。
- **FEAT-001 交付**（完整两阶段）：测试先行（RED 6/6 → GREEN 25/25，覆盖 91%/73%）→ init/doctor + envelope + team-root + 原子写/rev → 真机冒烟 → verification（G5 全表：13 PASS、3 N/A、SCA BLOCKED 留痕）→ 知识沉淀与矩阵回填 → commit（Refs: FEAT-001）。
- 残余：CI 工具化（P1）、npm audit 补跑、worktree 警告分支随 FEAT-004。

## 下一步队列

1. **P5 开工（唯一剩余）**：`git commit` 设计基线（待用户发令）→ 仓库根建 TS monorepo（20 §3 九包）→ FEAT-001 起逐个走 `05-features/FEAT-XXX/`：mvp-scope → **失败测试先行**（BDD/合同用例）→ 最小实现 → verification/self-check/knowledge → 矩阵回填。
2. 沿途维护：ASM-004/005/006 按期限确认；backflow 事件显式标注。
