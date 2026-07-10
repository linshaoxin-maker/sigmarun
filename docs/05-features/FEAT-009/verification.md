# Feature 验证报告：FEAT-009 review gate（含 D15 自主领取）

> 2026-07-11 ｜ 用户可见 ｜ RED 10/10 先行 → GREEN 159/159（新增 10）

## 1. 四可检验

| 项 | 结论 | 说明 |
|---|---|---|
| 可感知 | ✅ | `review claim/approve/request-changes`、`resume`、`/team-review`+`/team-status` 模板；自批被结构化拒绝 |
| 可演示 | ✅ | 真机：owner 自批 → INV-008 拒；reviewer 合成领审（kind=review_work round 1）→ approve → 不可变记录落盘 |
| 可端到端 | ✅ | submit→review claim→decide→（approve→approved ｜ request_changes→复活→resume→working→重 submit→round 2）全环 |
| 可独立上线 | ✅ | 实现者从此无法自标 done；verify/integrate 随 FEAT-010 |

## 2. 场景锚

| 锚 | 测试 |
|---|---|
| BDD-006-01 D15 合成 | review.test `claim-next --role reviewer synthesizes…`（kind/claim/round/evidence_ref；不入 task-list） |
| BDD-006-02 自批拒 | `any historical owner is rejected…`（显式+合成两路）+ `previous_attempts owners are also barred`（reclaim 历史也算，INV-008 全口径） |
| BDD-006-03 无 must_fix 拒 | `request-changes without a must_fix…`（schema_invalid + 零变更） |
| BDD-006-04 返工环 | `request-changes revives the owner claim…`（同 claim 复活续租、path claim 全程 active、findings 镜像 message pool + message_ref 回链、resume→working、重 submit rev 2、REVIEW-…-01/02 并存永不覆盖） |
| BDD-006-05 租约回收 | `…an expired review lease is swept back to submitted`（review_released actor=sweep）+ 重复领审 task_already_claimed |
| 14 §3.1 领审全断言 | `explicit review claim…`（20 分钟租约、round=revision、reviewing 翻转、#30 事件） |
| 14 §3.2 skip 记录（FEAT-007 留口闭合） | `require_review=false submit writes a minimal skipped_by_policy review record` |
| AUD-015 inline 双检 | claim 守卫 + decide 写记录前复检（`only the claim holder can decide` 锚 not_claim_owner 面） |

## 3. Gate 5

| Gate | Status | Evidence |
|---|---|---|
| G5-1/2/3 | PASS | build exit 0；159/159，覆盖 90.69%/75.25%（阈 80/70）；偏离见 §4 |
| G5-4 回归 | PASS | 149 既有用例持续绿（repair 事件映射表扩 review 族随此验证） |
| G5-5…12 | PASS | 本文件 + self-check + knowledge + 卡片 + 矩阵/CHANGELOG/progress + commit（Refs: FEAT-009） |
| G5-13 | N/A | 无量化 NFR 挂本 FEAT |
| G5-14 | Secrets PASS（review 记录无凭据面；镜像消息走既有池）；SCA 仍 BLOCKED | — |
| G5-15 | PASS（inspection） | review.ts 在 dispatch 包内与 claim-engine 同层互引；cli→dispatch 既有边 |
| G5-16…23 | N/A | 同前 |

## 4. 残余（书面）

- [FEAT-010] decision=block（review_blocked）、verify 合成（BDD-006-06/07）、task 级 review.required 覆盖（15 §9 更严格者胜）、checklist 模式默认集内容（15 §10）。
- [记录] `resume` 为 15 §3.3 changes_requested→working 边的实现命名——04 §1.1 canonical 表对齐待回填检查（backflow 标记）。
- [记录] guard 序修正：重复领审检查先于状态门（reviewing 态由 claim 造成，重复者应得 task_already_claimed 而非 no_claimable_task）。
