# Feature 验证报告：FEAT-007 evidence 门禁 submit

> 2026-07-11 ｜ 用户可见 ｜ RED 14/14 先行 → GREEN 131/131（新增 14）

## 1. 四可检验

| 项 | 结论 | 说明 |
|---|---|---|
| 可感知 | ✅ | `sigmarun submit`：接受即状态翻转 + 警告面板；拒绝即逐条错误清单（F1 的正反两面） |
| 可演示 | ✅ | 真机：submit → 越界/脱敏双警告 → 落盘日志含 `[REDACTED:github_token]` → run show 显示 submitted → 非法目标 exit 7 |
| 可端到端 | ✅ | working→submitted 九步事务（14 §2.3）全链 + D6 skip 分叉 + 返工 revision 承载 |
| 可独立上线 | ✅ | review gate 默认开（等 FEAT-009 接审）；require_review=false 时本 FEAT 已可走完 approved |

## 2. 场景锚

| 锚 | 测试 |
|---|---|
| BDD-005-01 快乐路径 | submit-success `writes evidence + outputs + handoff…`（gateway 字段/outputs/handoff 代写/task+claim submitted/path claim hold/#27 payload） |
| D8 输出策略 | `redacts secrets in outputs and truncates…`（首 50+末 200、256KB、`[REDACTED:kind]`、output_truncated） |
| AUD-014 inline | `recomputes in_scope with minimatch…`（**不信 agent 自报**；FEAT-003/004 挂账的 minimatch 升级在此闭合） |
| D6 半场 | `require_review=false…`（approved + review_skipped，actor=policy） |
| AUD-028 提交半场 | `context_ack is reconciled…`（对账 hydrate must_read → warning） |
| 返工 revision（BDD-006 回环承载） | `resubmission archives…`（history/rev-1.json + revision 2） |
| 14 §2.1 字段规则（必拒族） | submit-invalid 七例：非 owner/非 working、changed_files 空、acceptance 错配、skipped 无 note、输出缺失、handoff 缺失、坏 JSON——均零变更 + #28 事件 |
| required_checks 覆盖 | `fails on uncovered checks and unknown cmd_ref; passes once covered` |

## 3. Gate 5

| Gate | Status | Evidence |
|---|---|---|
| G5-1/2/3 | PASS | build exit 0；131/131，覆盖 92.31%/77.97%（阈 80/70）；契约零偏离（handoff 由 gateway 代写为 14/12/19 一致裁决，mvp-scope 书面） |
| G5-4 回归 | PASS + **缺陷修复** | 全部 117 既有用例持续绿；实现期发现 FEAT-004 潜伏缺陷——claim-engine 读 `rdoc.policy`，而 run.json 权威字段为 `default_policy`（02 §5），run 级策略覆盖此前被静默忽略；三处修正（claimNext/heartbeat/submit），D6 用例即其回归锁 |
| G5-5…12 | PASS | 本文件 + self-check + knowledge + 卡片 + 矩阵/CHANGELOG/progress + commit（Refs: FEAT-007） |
| G5-13 NFR-004 脱敏 | PASS | 替换管道三落点（outputs/summary/handoff）各有用例；messages warn 档已随 FEAT-005 |
| G5-14 | Secrets PASS（本 FEAT 即脱敏管道本体）；SCA 仍 BLOCKED | — |
| G5-15 | PASS（inspection） | submit 在 core（matrix 定位）；仅依赖 storage+minimatch |
| G5-16…23 | N/A | 同前 |

## 4. 残余（书面）

- [FEAT-009] changes_requested→working 回环触发与 review claim（revision 承载面已就位）。
- [FEAT-008] evidence show 面板、AUD-011/013/014/028 audit 复检面。
- [P1] out_of_scope 严重度 run policy 可配；`evidence.changed_files` 由 git diff 机械生成的 adapter 侧闭环（16 §3.4 第 3 条，模板已写入）。
- [Phase 3] 独立 runner 防伪造（D11 边界不变）。
