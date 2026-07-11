# Changelog

## Unreleased

- 发布装配（形态 B 前置，22 §4.1 单包裁决落地）：`npm run release` = 构建 + esbuild 把 8 个 workspace 包 bundle 成单包 `sigmarun`（单 bin，zod/minimatch 保持外部依赖，模板内联随包）；npm 面 README；tarball 冒烟通过（全新 repo 安装 → init/doctor 10 项 → import→publish→claim→status(§9 5%)→audit 40 规则→adapter install 13 模板）。实际 `npm publish` 待账号登录与 license 裁决。

- 真机 dogfood（双代理全旅程）+ finding #3 修复：`report` 即 run 验收——integrated 任务批量翻 `done` 并逐个记 `task_done` 事件（15 §3.3 最后一条未实现边闭合，写序 详情→索引→事件）；progress 落实 docs/03 §9 分数全表（claimed 0.05…integrated 0.95，blocked 经账本回溯保持前值，cancelled 剔除分母）——修复"两任务已合并仍显 0%"；replay 表补 `task_done`。dogfood 另两枚 findings：副作用命令勿过管 `head`（SIGPIPE 半途杀 git）；下游依赖未集成上游的分支策略（16 §3.6 新注 + 项目记忆 MEM-0001）。测试 214/214。

- P1 面收官：`run pause/resume/cancel/archive`（15 §2.3 全转换，cancel 级联 claim/task + BDD-007-09，reported 只可 archive）、`task add`（草稿落位 + 图节点/blocks 边 + 依赖校验）与 `task cancel`（级联三类 claim）、`worktree list`、`graph show`（节点带派生状态）；**审计目录 40/40 全在线**——AUD-023…028（上下文/handoff 对账批）+ AUD-034（账本重放引擎，与 repair 共用 foldLedger 单一事实源，补齐 review_blocked/task_cancelled 映射）；review block 决定同步镜像 blocker 消息（AUD-024 一致性）；AUD-026 收敛为仅对含条目的记忆文件要求出处（import 骨架不再误报）。测试 213/213。

- 收尾轮批 2：SCA 归零（根因=镜像源缺 audit 端点，官方源补跑并修 glob 传递依赖）；review `block` 决定 + `unblock` 原语（15 §3.3 blocked 双边，事件 #34/#15）；task 级 `review.required` 覆盖 run 级 false（15 §9 更严格者胜，import 保留字段缺省语义）；integrate 终结 task claim（AUD-009 真机命中即修）；AUD-032 对升级前遗留账本降 warn；adapter 补齐至 12 命令模板 + 4 Codex skills；conformance suite（25 命令面单信封断言，M38）+ NFR-001 真进程并发压测（8 路 claim 唯一分派 + seq 无缝）；CI 三平台×双 Node 矩阵工作流；reviewDecide/grantReviewClaim 写序对齐 17 §5.3；audit evidence 缓存与 synthesizeReview 单遍预建；docs/04 §1.1 命令面实现对齐注记回填。测试 205/205。

- 审查修复轮：全量 8 角度审查（43 候选 → 16 验证 → 14 成立）后修复 14 项——publish 锁路径统一（互斥恢复）、repair 重放表补 verified/integrated（修复工具不再损坏健康 run）、review sweep 半提交、verify 独立性守卫（作者不可自验）、applyReclaim 提交点次序、failures_mapped 守卫、定向领取并行上限、memory promote 双锁与路径逃逸、events.jsonl 容错读取（readEventsSafe）、watch NaN 挂起、run show 策略字段、integrate 租约策略化、verify 输出截断；storage 新增 tryAcquireLock/runLockPath 收敛 11 处锁样板。测试 192/192（+12 回归锁）。详见 docs/02-phases/code-review-2026-07-11.md。

- FEAT-011 project memory promote（L4，**P4 特性全集收官**）：`memory promote`（refs 必填可解析（INV-012 项目级）、secret 拒收、MEM 项目级编号、出处戳、--supersedes 移入 Superseded 区留痕、memory_promoted/superseded 事件、三层出库防线）、`memory candidates`（只列不选）；audit 补 AUD-036…040；status 超限风险；doctor 补 project_memory_committable。测试 180/180，覆盖 89.4%/73.2%。（Refs: FEAT-011）

- FEAT-010 verify + integrate + export（**MVP 主链闭合**）：`verify submit`（14 §4 结构校验、task/run 双目标、失败映射返工）、`claim-next --role=verifier` 合成、`integrate start/record`（拓扑序下发、gateway 不碰 git、--failed 单点回退不卡全局、path claim hold 终点释放）、`report`（integration.md+report.md、run→reported、不合 main）、`export`（阻断式脱敏归档，`export_redaction_hit` 即中止零写入）；依赖门策略位 `deps_satisfied_when`（10 §6 放宽档）。测试 172/172，覆盖 89.7%/73.5%。（Refs: FEAT-010）

- FEAT-009 review gate：`review claim/approve/request-changes` + `resume`（14 §3 全节：INV-008 自批双点拦截（含 previous_attempts 历任 owner）、D15 `claim-next --role=reviewer` 合成 review_work、20 分钟评审租约 + 惰性回收、must_fix 镜像 message pool 回链、owner claim 原地复活返工环、REVIEW 每轮新文件、require_review=false 的 skipped_by_policy 最小记录）；adapter 补 /team-review、/team-status。测试 159/159，覆盖 90.7%/75.3%。（Refs: FEAT-009）

- FEAT-008 status/watch/audit/repair：新包 `@sigmarun/watch`（`status`——权重 progress/风险/M32 Needs-user 带命令、`run list`/`task show`/`evidence show`、`watch`——单实例锁/tick=sweep+快照/终态退出）与 `@sigmarun/audit`（`audit run`——14 条规则 + 26 条登记跳过、exit 0、findings=data、无锁快照；`repair`——账本前滚/执行前备份/state_repaired/幂等）。修复 FEAT-004 sweep 半提交隐患（sweepRun 提取 + 即时持久化）。登记实现债：写事务事件 rev_after（AUD-032）。测试 149/149，覆盖 90.8%/75.1%。（Refs: FEAT-008）

- FEAT-007 evidence 门禁 submit：`sigmarun submit`（14 §2.3 九步事务：校验先行零残留、in_scope minimatch 重算（不信自报）、D8 输出截断+脱敏 `[REDACTED:kind]`、handoff 代写、revision/history 返工承载、D6 review_skipped）；storage 脱敏升级为替换管道。修复 FEAT-004 潜伏缺陷：run 级策略字段 `default_policy` 此前被错读为 `policy`（覆盖静默失效）。测试 131/131，覆盖 92.3%/78.0%。（Refs: FEAT-007）

- FEAT-006 dispatch 端到端：`worktree register/adopt`（claimed→working、回收保留-认养链 16 §3.5、base_commit 机械采集）、`run show`（dispatch 第 1 步）、新包 `@sigmarun/adapters` + `adapter install --tool=claude-code|codex`（/team-plan、/team-dispatch、/team-publish 模板 + Codex skill + AGENTS.md 标记对幂等注入；RULES 十诫逐字、--as/--task/--role/--loop、D5 单任务停机）。测试 117/117，覆盖 92.7%/79.7%。（Refs: FEAT-006）

- FEAT-005 Context Plane：新包 `@sigmarun/context`——`msg post/list`（12 §6 消息池，INV-011 不进 events，`--open` 派生开放问题）、`context hydrate`（must_read 组包：brief→run-memory→L4 项目记忆（D19）→上游 handoff/evidence；context_hydrated 事件为 AUD-028 留锚）、`graph validate`（AUD-021/022 防篡改复检）、`memory update`（secret 拒收、无出处警告）。测试 103/103，覆盖 92.6%/79.5%。（Refs: FEAT-005）

- FEAT-004 claim-next + 锁 + 回收：新包 `@sigmarun/dispatch`——`agent register`（D17 label 幂等）、`claim-next`（BR-001 九守卫 + 10 §7 排序 + 定向/--dry-run + worktree 建议）、`heartbeat`/`release`/`reclaim`（BR-004 三阶回收，previous_attempts 永不清零）、`approve-paths`（AUD-004）、3×TTL 惰性 sweep（blocked 豁免）。错误码 +12（含回填 17 §3 的 claim_not_found/not_claim_owner）。测试 85/85，覆盖 93.2%/80.2%。（Refs: FEAT-004）

- FEAT-003 publish：`sigmarun task publish`（draft→ready 双写、planned→active 激活、幂等跳过、D18 跨 run 重叠 warn/block + `--force`、`cross_run_overlap_detected` 事件）。测试 60/60，覆盖 93.5%/80.5%。（Refs: FEAT-003）

- FEAT-002 plan 导入：`sigmarun run import`（payload 校验必拒表 + 警告、AUD-021 环检测 inline、D17 指纹防重 `duplicate_payload`、project.lock 短事务、events 提交点写序）；storage 新增 mkdir 锁与 secret 模式集。测试 52/52，覆盖 93.8%/80.8%。（Refs: FEAT-002）

- FEAT-001 `.team` 基座：`sigmarun init`（幂等初始化 + D4 gitignore）与 `sigmarun doctor`（九项自检，fail 自带修复指引）；storage 基元（team-root 解析、原子写 + rev 乐观锁、未知字段 round-trip）；统一 envelope（17 §2，英文）。测试 25/25，覆盖 91%/73%。（Refs: FEAT-001）
