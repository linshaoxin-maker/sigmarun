# 当前状态（current-state）

> 最后刷新：2026-07-15（整改 R4 收官）。上一版停在 2026-07-10「P5 未开始」，中间 P5 全量交付、多轮真机验证、roadmap 两阶段、轻量模式与整改 R0–R4 均未刷新——该文件的失鲜本身是 2026-07-15 审查的发现之一。

## 一句话

sigmarun 0.1.0：八包 monorepo（storage/core/dispatch/context/adapters/watch/audit/cli），全特性 + 轻量模式 + 整改 R0–R4 完毕；311 测试全绿（含真进程并发、13 个卡点场景回归、四张机器对账）；npm 发布仅差用户侧动作（填 repository OWNER、`npm publish`）。

## 里程碑（倒序）

- 2026-07-15 整改 R0–R4（全面审查 → remediation-design v1.0，D21–D24 裁决）：P0 worktree 修复、13 个复现卡点全关、模式墙+轻量终局+审计轻量档、INV-008 实质贡献判据、block/reopen/--force、TxKernel（版本闸门+lock_takeover+五骨架归一）、needs_user 全流水线、agent 视图、人面渲染、watch 心跳、guidance 注册表、语料库机器对账。
- 2026-07-13/14 roadmap Phase 1/2 + 轻量模式（events/doctor --fix/prune/--verbose；migrate/backup+restore/release 自动化；lightweight + /team-plan(light) + /team-do）。
- 2026-07-11 P5 全特性（FEAT-001…011）+ P1 面 + 真机 dogfood ×3 + 发包功能测试 + 开源就绪审查（12 修）+ 英译起步。

## 打开的事

- 发布：填 GitHub OWNER、`npm publish --access public --tag next`、推 tag 走 release workflow（用户侧）。
- P1/P2 挂账：`deinit`；`memory show`；audit 子命令族；完整 RunTx 写句柄类型化；MCP serve（形态 C）；docs 全量英译；docs/23 dashboard。
- 已知限制（记档非缺陷）：锁 stale=30s 无续期（超长事务理论接管窗，CLI 体量概率极低）；appendEvent 两步非原子（AUD-033 检出 + repair 前滚闭环）。

## 权威指针

- 阶段与验收：docs/02-phases/remediation-design-2026-07-15.md（P-1…P-4）
- 决策：docs/13 D1–D24 + docs/04-decisions/ADR-020…024
- 轻量模式：docs/26；命令面：docs/17 §1（机器对账）
