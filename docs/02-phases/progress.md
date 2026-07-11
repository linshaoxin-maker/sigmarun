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

## 2026-07-10（FEAT-002 交付）

- **FEAT-002 plan 导入**完整两阶段：RED 26 → GREEN 52/52（覆盖 93.8%/80.8%）；真机冒烟含 dedup；G5 全表（G5-4 回归=FEAT-001 25 用例持续绿）。
- **合同 backflow**：`duplicate_payload` reason code 实现期定名，回填 17 §3 / 09 §6（规则 3 显式处理）。
- 新增基元：mkdir 锁（超时/接管）、secret 模式集（warn-only，FEAT-007 升级为替换管道）、events 写入器（seq/提交点）。
- 书面 scope cut：`initial_status: ready` 降级 draft + 警告，待 FEAT-003。
- 下一个：**FEAT-003 publish**（draft→ready、run 激活、D18 跨 run 检查，锚 BDD-002-01…04）。

## 2026-07-10（FEAT-003 交付）

- **FEAT-003 publish**：RED 8 → GREEN 60/60（覆盖 93.5%/80.5%）；真机冒烟含幂等；D18 warn/block 双策略 + 零变更断言；FEAT-002 的 ready 降级警告文案改指向本命令（scope cut 收敛为"publish 永远显式"的既定语义）。
- 书面留待 FEAT-004：BDD-002-02 claim 拒绝半场、minimatch 级重叠判定（当前为 10 §8.2 保守前缀法）。
- 下一个：**FEAT-004 claim-next + 锁 + 回收**（DAG 最重一环：认领守卫 BR-001、租约/心跳捎带、3×TTL sweep、previous_attempts、AUD-001/002 inline，锚 BDD-003 全组 + BDD-007-02/03）。

## 2026-07-10（FEAT-004 交付）

- **FEAT-004 claim-next + 锁 + 回收**：第四包 `dispatch` 落地；RED 23 → GREEN 85/85（覆盖 93.2%/80.2%）；真机 12 事件全链冒烟。BR-001 九守卫全实现（行 9 并行上限代码在、压测豁免留 CI）；BDD-002-02（FEAT-003 留债）闭合。
- backflow：`claim_not_found`/`not_claim_owner` 回填 docs/17 §3；minimatch 改派 FEAT-007（书面理由：真正的 file-vs-glob 场景在 evidence in_scope）；lock_takeover 事件顺延 FEAT-008。
- 下一个：**FEAT-005 Context Plane**（hydrate 包 + messages.jsonl + run-memory；锚 UC-009 读路径 + 12 号合同）。

## 2026-07-10（FEAT-005 交付）

- **FEAT-005 Context Plane**：第五包 `context` 落地；RED 17 → GREEN 103/103（覆盖 92.6%/79.5%）；真机六命令冒烟（blocker/question 入池→--open 派生→memory update→hydrate→graph validate）。
- 实现期修正：task-graph 边字段 `kind`（以 run-import 实写为准）——"跨包消费先读生产方"入知识卡。
- 下一个：**FEAT-006 dispatch 端到端**（/team-dispatch 编排合同 + worktree register + task→working + 适配器 conformance，锚 UC-003/004 + 19 号）。

## 2026-07-11（FEAT-006 交付）

- **FEAT-006 dispatch 端到端**：第六包 `adapters` 落地；RED 13 → GREEN 117/117（覆盖 92.7%/79.7%）；真机全链（run show→claim→worktree register→working→双工具 adapter install→AGENTS 标记恰一对）。
- 书面改派：`run show` 自 FEAT-008 提前（dispatch 第 1 步硬依赖）；base_branch 祖先校验随 FEAT-010；submit 步骤为模板前向引用。
- 下一个：**FEAT-007 evidence 门禁 submit**（14 §2 evidence schema + submit 事务 + handoff 写半场 + context_ack + in_scope minimatch + 脱敏管道升级，锚 BDD-005 全组）。

## 2026-07-11（FEAT-007 交付）

- **FEAT-007 evidence 门禁 submit**：RED 14 → GREEN 131/131（覆盖 92.3%/78.0%）；真机冒烟（脱敏落盘 grep 验证、越界警告、exit 7 状态门）。F1 正面锚 + minimatch 挂账闭合 + 脱敏替换管道。
- **缺陷修复**：`default_policy` 字段名错读（FEAT-004 起潜伏，run 级策略覆盖被静默忽略）——"兜底逻辑掩盖读错的键"入知识库。
- 下一个：**FEAT-008 status/watch/audit/repair 与查询面**（复合 FEAT，子项 008.1–008.4 见 P4；锚 UC-007 + BDD-007 剩余场景 + 18 号 audit 目录）。

## 2026-07-11（FEAT-008 交付）

- **FEAT-008 status/watch/audit/repair**（复合四子项全验收）：watch+audit 两包；RED 17 → GREEN 149/149（覆盖 90.8%/75.1%）；真机六命令冒烟——audit 抓到 FEAT-007 冒烟留下的真实越界（AUD-014）。
- 随做修复：FEAT-004 sweep 半提交隐患（多出口函数"稍后统一保存"教训）；**登记实现债：rev_after（AUD-032 依赖，18 §3 要求写事务事件必带）**。
- 下一个：**FEAT-009 review gate**（review claim 合成 D15、INV-008 自批禁令、approve/request-changes 回环、changes_requested→working 复活续租，锚 BDD-006 全组）。

## 2026-07-11（FEAT-009 交付）

- **FEAT-009 review gate**：RED 10 → GREEN 159/159（覆盖 90.7%/75.3%）；真机（自批 INV-008 拒、D15 合成、approve 不可变记录、/team-review+/team-status 模板落装）。
- 闭合 FEAT-007 留口（skip 最小记录）与 FEAT-008 改派（模板补装）；返工环全链（复活→resume→rev 2→round 2）经测试锁定。
- 下一个：**FEAT-010 verify + integrate + export**（子项 010.1–.3：VERIFY 记录/gates/failures_mapped、拓扑序合并+revert、脱敏阻断式 export，锚 BDD-006-06/07 + BDD-008 全组）。

## 2026-07-11（FEAT-010 交付 · **MVP 主链 FEAT-001…010 闭合**）

- **FEAT-010 verify + integrate + export**：RED 13 → GREEN 172/172（覆盖 89.7%/73.5%）；真机**北极星全链**：plan→import→publish→register→claim→worktree→submit→review→verify→integrate→report→export（7 文件脱敏归档落 docs/team-runs/）。
- 依赖门冲突化解：BDD-008 背景 vs 10 §6 严格档——落既写策略位 `deps_satisfied_when`（默认 ['done'] 不变）；字段名回填 10 §6 挂账。
- 十包监控：storage/core/dispatch/context/adapters/watch/audit/cli 八包 + 172 用例全绿。
- 下一个：**FEAT-011 project memory promote（L4，P1 首位）**；其后收尾轮（rev_after 债、SCA、CI、模板余量、conformance、回填批）。

## 2026-07-11（FEAT-011 交付 · **P4 特性全集 FEAT-001…011 交付完毕**）

- **FEAT-011 L4 memory promote**：GREEN 180/180（覆盖 89.4%/73.2%）；真机五步（decision→candidates→promote→拒收→doctor）。audit 覆盖推进：SKIPPED 仅剩 rev_after（AUD-032）与重放（AUD-034）。
- 八包 · 180 用例 · 11 FEAT · 11 次原子提交（Refs 链完整）。
- **收尾轮待办**（优先序）：① rev_after 债（AUD-032 解锁）② 回填批（10 §6 deps_satisfied_when、04 §1.1 命令面对齐 resume/verify submit/integrate record/memory candidates 等实现期定名）③ SCA 补跑 ④ CI 三平台 + NFR-001 压测 ⑤ review block/task 级 review.required ⑥ team-integrate/team-verify/team-tasks/team-task/team-evidence/team-submit/team-runs 模板余量 + Codex skills 三件 ⑦ conformance suite（19 §9/M38）。

## 2026-07-11（全量审查 + 修复轮）

- **审查**：8 查找角度扫 `faafeae...HEAD` 全量（9591 行）→ 43 候选 → 16 条对抗验证 → 14 成立（4 条重伤：publish 锁路径互斥失效、repair 重放表损坏健康 run、review sweep 半提交、verify 可自验）/ 2 驳回（含 15 §2.4 paused 期回收属设计）。
- **修复**：14 项全修 + 12 回归锁；storage 收敛 `tryAcquireLock`/`runLockPath`（锁样板 11 处漂移根因）；core 新增 `readEventsSafe`（账本容错读）。192/192 绿、build 0、真机冒烟过。记录：[code-review-2026-07-11.md](code-review-2026-07-11.md)。
- 登记收尾轮卫生项：grantReviewClaim/reviewDecide 内 claims-先于-详情 写序、效率三候选（audit evidence 缓存/synthesizeReview 预建 owners Map/repair 批量 meta 写）、worktree 正则转义。

## 2026-07-11（收尾轮完成）

- **批 1**（并行会话产物验收入库）：rev_after 全事件快照 + AUD-032 活化；AUD-005…020 审计批（33/40 规则在线，SKIPPED 仅剩 023–028 上下文对账批与 034 重放）；path_escape_detected + 路径围栏（worktree/export realpath 收容）。
- **批 2**：SCA 归零（镜像源根因，官方源 0 漏洞）；review block/unblock；task 级 review.required（15 §9）；integrate 终结 task claim（新审计规则真机命中 AUD-009 即修 + 回归锁）；AUD-032 遗留账本降噪；模板全量 12+4；conformance（M38，25 命令面）+ NFR-001 压测（8 真进程并发）；CI 矩阵（3 OS × Node 20/22）；写序/效率卫生项；04 §1.1 回填。
- 计数：**205/205 用例**、36 测试文件、33 条审计规则在线。收尾轮 ①–⑦ 全部销账。
- **剩余 P1 面**（非阻塞）：run pause/resume/cancel/archive、task add/cancel、worktree list、graph show、AUD-023–028 对账批、AUD-034 重放、CLAUDE.md @import 接线、npm 打包发布（22 §Phase 1）。

## 下一步队列

1. 收尾轮（原 ①–⑦ + 上表卫生项，按序）；完成后 22 号 §MVP 打包面（npm 发布物）评估。
2. 沿途维护：ASM-004/005/006 按期限确认；backflow 事件显式标注。
