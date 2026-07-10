# Changelog

## Unreleased

- FEAT-009 review gate：`review claim/approve/request-changes` + `resume`（14 §3 全节：INV-008 自批双点拦截（含 previous_attempts 历任 owner）、D15 `claim-next --role=reviewer` 合成 review_work、20 分钟评审租约 + 惰性回收、must_fix 镜像 message pool 回链、owner claim 原地复活返工环、REVIEW 每轮新文件、require_review=false 的 skipped_by_policy 最小记录）；adapter 补 /team-review、/team-status。测试 159/159，覆盖 90.7%/75.3%。（Refs: FEAT-009）

- FEAT-008 status/watch/audit/repair：新包 `@sigmarun/watch`（`status`——权重 progress/风险/M32 Needs-user 带命令、`run list`/`task show`/`evidence show`、`watch`——单实例锁/tick=sweep+快照/终态退出）与 `@sigmarun/audit`（`audit run`——14 条规则 + 26 条登记跳过、exit 0、findings=data、无锁快照；`repair`——账本前滚/执行前备份/state_repaired/幂等）。修复 FEAT-004 sweep 半提交隐患（sweepRun 提取 + 即时持久化）。登记实现债：写事务事件 rev_after（AUD-032）。测试 149/149，覆盖 90.8%/75.1%。（Refs: FEAT-008）

- FEAT-007 evidence 门禁 submit：`sigmarun submit`（14 §2.3 九步事务：校验先行零残留、in_scope minimatch 重算（不信自报）、D8 输出截断+脱敏 `[REDACTED:kind]`、handoff 代写、revision/history 返工承载、D6 review_skipped）；storage 脱敏升级为替换管道。修复 FEAT-004 潜伏缺陷：run 级策略字段 `default_policy` 此前被错读为 `policy`（覆盖静默失效）。测试 131/131，覆盖 92.3%/78.0%。（Refs: FEAT-007）

- FEAT-006 dispatch 端到端：`worktree register/adopt`（claimed→working、回收保留-认养链 16 §3.5、base_commit 机械采集）、`run show`（dispatch 第 1 步）、新包 `@sigmarun/adapters` + `adapter install --tool=claude-code|codex`（/team-plan、/team-dispatch、/team-publish 模板 + Codex skill + AGENTS.md 标记对幂等注入；RULES 十诫逐字、--as/--task/--role/--loop、D5 单任务停机）。测试 117/117，覆盖 92.7%/79.7%。（Refs: FEAT-006）

- FEAT-005 Context Plane：新包 `@sigmarun/context`——`msg post/list`（12 §6 消息池，INV-011 不进 events，`--open` 派生开放问题）、`context hydrate`（must_read 组包：brief→run-memory→L4 项目记忆（D19）→上游 handoff/evidence；context_hydrated 事件为 AUD-028 留锚）、`graph validate`（AUD-021/022 防篡改复检）、`memory update`（secret 拒收、无出处警告）。测试 103/103，覆盖 92.6%/79.5%。（Refs: FEAT-005）

- FEAT-004 claim-next + 锁 + 回收：新包 `@sigmarun/dispatch`——`agent register`（D17 label 幂等）、`claim-next`（BR-001 九守卫 + 10 §7 排序 + 定向/--dry-run + worktree 建议）、`heartbeat`/`release`/`reclaim`（BR-004 三阶回收，previous_attempts 永不清零）、`approve-paths`（AUD-004）、3×TTL 惰性 sweep（blocked 豁免）。错误码 +12（含回填 17 §3 的 claim_not_found/not_claim_owner）。测试 85/85，覆盖 93.2%/80.2%。（Refs: FEAT-004）

- FEAT-003 publish：`sigmarun task publish`（draft→ready 双写、planned→active 激活、幂等跳过、D18 跨 run 重叠 warn/block + `--force`、`cross_run_overlap_detected` 事件）。测试 60/60，覆盖 93.5%/80.5%。（Refs: FEAT-003）

- FEAT-002 plan 导入：`sigmarun run import`（payload 校验必拒表 + 警告、AUD-021 环检测 inline、D17 指纹防重 `duplicate_payload`、project.lock 短事务、events 提交点写序）；storage 新增 mkdir 锁与 secret 模式集。测试 52/52，覆盖 93.8%/80.8%。（Refs: FEAT-002）

- FEAT-001 `.team` 基座：`sigmarun init`（幂等初始化 + D4 gitignore）与 `sigmarun doctor`（九项自检，fail 自带修复指引）；storage 基元（team-root 解析、原子写 + rev 乐观锁、未知字段 round-trip）；统一 envelope（17 §2，英文）。测试 25/25，覆盖 91%/73%。（Refs: FEAT-001）
