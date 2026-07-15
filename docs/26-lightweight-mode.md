# 26 · 轻量模式(Lightweight Mode)规范

> 状态:正式(2026-07-15,D21 裁决落地;实现同日交付于整改 R1)
> 目标:把轻量模式从"只活在 CHANGELOG 的暗特性"收编入宪法——定义它的动机、能力矩阵、对 INV-007 的显式豁免边界、审计口径、终局与模式墙。本文是轻量模式的唯一权威;[15](15-run-task-state-machine-and-lifecycle.md) §9、[18](18-audit-rule-catalog-and-trust-model.md) §6 的修订注均指向此处。
> 决策依据:D21(2026-07-15 产品负责人裁决,记录于 docs/02-phases/remediation-design-2026-07-15.md §6;正式 ADR-021 随 R4 落档)。

## 1. 动机与定位

用户反馈(2026-07-13):产品的核心用例——"把一个目标拆成几块,让任意工具窗口各领一块干完"——被完整质量流水线(publish/evidence/review/verify/integrate/worktree)埋住了。轻量模式是**同一引擎上的低仪式档位**,不是第二个产品:

- **同一套状态机、同一个账本、同一把锁**。轻量 run 与 full run 的差异只有"哪些命令开放",由 `core/mode.ts` 的 `resolveRunMode(run)` 单点判定(整改 §2.2③)。
- **五条命令闭环**:`init` → `run import --lightweight` → `claim-next`(任意 `--agent` 名首领即自动注册)→ 干活 → `done` → (全部完成后) `report` → `run archive`。
- 想要质量流水线时,不加 `--lightweight` 即 full 模式,两者可在同一 project 并存(`run list` 以 `lightweight` 字段区分)。

## 2. 能力矩阵(RunMode)

| 能力 | lightweight | full | 备注 |
|---|---|---|---|
| `done`(持有者直标完成) | ✅ | ❌(`mode_mismatch`) | full 的 done 只经 report 验收批翻 |
| `submit`(证据门) | ❌(`mode_mismatch`) | ✅ | 墙文案指路 `done` |
| `review`(claim/decide + reviewer 合成) | ❌ | ✅ | |
| `verify`(submit + verifier 合成) | ❌ | ✅ | |
| `integrate`(start/record) | ❌ | ✅ | |
| `report` | ✅(全任务终态时,自 active) | ✅(仅 integrating,验收批翻) | §5 |
| claim 首领自动注册 | ✅ | ❌(须 `agent register`) | |
| worktree/msg/hydrate/memory/watch/status/events | ✅ | ✅ | 模式无关 |

被墙命令一律返回 `mode_mismatch`(exit 7),消息给出本模式内的正解。**S3 教训**:在墙建立之前,轻量 run 上一次合法的 submit 会把任务推进 approved——`done` 够不着(DONE_FROM 止于 submitted)、本人 verify 撞 INV-008,任务就地搁浅。

## 3. INV-007 的显式豁免(修宪条款)

[15](15-run-task-state-machine-and-lifecycle.md) §9 原文"实现者不能标自己 done(INV-007)不受任何开关影响"**修订为**:

> INV-007 在 **full 模式 run 中**永不放开。轻量 run 显式豁免:`done` 由 claim 持有者执行,信任完成者、免证据门。豁免必须留痕——run.json 携带 `lightweight: true`,`task_done` 事件 payload 标注 `via: "done_command"`;审计据此切换口径(§4)。**INV-008(自批禁令)不豁免**:轻量 run 根本没有 review/verify 门,不存在"批"这个动作;若未来为轻量加可选评审,自批禁令原样适用。

反撞车保障不豁免:`done` 仅 claim 持有者可执行(`not_claim_owner`),路径冲突、租约、sweep 全部照常。

## 4. 审计口径(lightweight profile)

audit 引擎按 `run.lightweight` 单点分档(Ctx.lightweight):

| 规则 | full | lightweight | 理由 |
|---|---|---|---|
| AUD-011(done/submitted+ 无 evidence) | error | **info**(文案注明 D21 豁免) | 直标完成是本模式的正当形态,不是违规 |
| AUD-016(approved+ 无 review 记录) | error | **info** | 同上 |
| AUD-017(verified+ 无 verification) | error | **info** | 同上 |
| AUD-019(review_skipped 异常) | error/warn | **info** | 轻量无评审门 |
| 其余 36 条(账本/锁/路径/记忆/防篡改) | 不变 | **不变** | 与模式无关 |

验收命题(P-4 观测一致):健康轻量 run 的 audit **零 error**;豁免以 info 呈现——保可见性,不制造恐慌,也不与 status 的"0 风险"互相打架。

## 5. 终局(run 生命周期)

轻量 run 出生即 `active`(import 即发布)。终局**复用既有链条,不加新状态、不做隐式迁移**:

```
active --(全部任务 done/cancelled 后, 显式 report)--> reported --(run archive)--> archived
```

- `report` 在轻量 run 上的守卫:仅 active 且**零非终态任务**;有未完任务时拒绝并逐一列出。产物是简化版 `report.md`(任务清单与结果;无 integration.md——没有合并物),事件 `run_reported` payload 带 `mode: "lightweight"`。
- 最后一个 `done` 的信封 `next_actions` 给出 `sigmarun report <RUN>`——**run 不自我关闭**(显式账本优于魔法),但关闭动作永远递到手边。
- `watch` 的 TERMINAL 集合(reported/archived/cancelled)不变,report 后自然退出——S8 的无限静默循环由此消失。

## 6. 与 full 模式的关系

- **不可切换**:`lightweight` 是 import 时定的出生属性,没有(也不设)运行中改档命令——改档等于重写全部历史事件的语义。选错了就 `run cancel` 重开。
- **观测面**:`run list` 输出 `lightweight` 与 `progress_pct`,adapter 的 `/team-do` 据此只认领轻量 run(不再误击 full run,S3 连锁的入口)。
- **payload**:`--lightweight` 由 CLI flag 决定,payload schema 不新增字段;import 自动置 `require_review=false`、`require_verification=false`(与模式墙冗余但保守——即使墙有洞,policy 也不会造出强制评审的僵局)。

## 7. 验收场景(BDD 挂钩)

| 场景 | 断言 | 测试锚点 |
|---|---|---|
| 五命令闭环 | import→claim(自动注册)→done→report→archive 全 ok;watch terminal | core/test/lightweight.test.ts |
| 模式墙 | submit/review/verify/integrate/合成 在轻量 run 全部 `mode_mismatch` 且零 mutate | 同上("mode wall") |
| 终局拒绝 | 有未完任务时 report `invalid_transition` 并列出 | 同上 |
| 审计口径 | 健康轻量 run 零 error;AUD-011/016/017 以 info 可见 | audit/test/audit.test.ts |
| full 侧不变 | full run 的 done 仍拒(`mode_mismatch`)、report 仍需 integrating | 同上 + integrate.test.ts |
