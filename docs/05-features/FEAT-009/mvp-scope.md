# FEAT-009 MVP Scope — review gate（含 D15 自主领取）

> 源：05 Slice 8 ｜ 锚：UC-006 · BDD-006-01…05（-06/07 归 FEAT-010）+ BDD-005-07 ｜ 合同：14 §3 全节、15 §3.3/§7/§9、18 #30–33、AUD-015 inline、INV-008、D6/D15

## In（dispatch 包扩展 + core/submit 小补）

- **`review claim <RUN> <TASK> --agent`**（14 §3.1）：run.lock 内守卫——task=submitted、reviewer ≠ 历任 owner（**INV-008**：task claims 全历史 + previous_attempts；拒绝码 `self_approval_forbidden`）、单 active review claim/task；租约 20 分钟（`review_ttl_minutes ?? 20`）；task submitted→reviewing；事件 `review_claimed`（round=evidence revision）。
- **D15 合成（claimNext reviewer 分支）**：`claim-next --role=reviewer` 从 submitted 队列合成虚拟工作项（等待最久优先=evidence submitted_at asc），命中即落**同一种** review claim；envelope `data.kind="review_work"`（task、round、evidence_ref、checklist_source）；不写 task-list 新行；无候选照常 `no_claimable_task`。
- **`review approve|request-changes <RUN> <TASK> --agent --review=<draft.json>`**（14 §3.2）：
  - 守卫：active review claim 且属本人（否则 not_claim_owner）；写记录前 **AUD-015 inline 复检**。
  - REVIEW 记录 `reviews/<TASK>/REVIEW-<TASK>-NN.json`（team.review.v1，NN=round 两位，**每轮新文件永不覆盖**，M8）；draft 供 checklist/findings/scope_check/acceptance_opinion。
  - approve：task reviewing→approved、review claim→completed、事件 `review_approved`。
  - request-changes：**必须 ≥1 条 must_fix**（否则 schema_invalid 零变更）；must_fix findings 先入 message pool（type=request_changes，得 MSG id 回填 finding.message_ref——12 §6 镜像规则）；task reviewing→changes_requested；**owner task claim 复活**（submitted→active + 续租，15 §4.4：path claim 全程未释放）；事件 `changes_requested`（must_fix_count）。
- **`resume <RUN> <TASK> --agent`**：15 §3.3 `changes_requested→working`（owner、同 claim）显式原语——BDD-006-04 的"复工"动作；事件 `task_started`（payload.resumed=true）。（04 §1.1 canonical 表若无此名 → 回填检查项。）
- **review 租约惰性回收**（BDD-006-05）：review claim 过期 → 下一次 review claim/合成前先释放（task reviewing→submitted、事件 `review_released` actor=sweep）。
- **skip 记录补全**（14 §3.2 最后一行，FEAT-007 留口）：require_review=false 的 submit 同时写 `decision:"skipped_by_policy"` 最小 REVIEW 记录——"每个 approved 任务都有 review 记录"审计不变量无例外。
- repair 的事件→状态映射表补 review 族（review_claimed→reviewing 等）。
- 错误码 `self_approval_forbidden` 入 enum + exit 6。
- adapter 模板补装（FEAT-008 书面改派并入本 FEAT）：`team-review.md` + `team-status.md`。

## Out（书面）

- decision=`block`（review_blocked 事件面）→ 与 verify 面一起随 FEAT-010（15 §4.4 block 边未进本期状态断言）。
- task 级 `review.required` 覆盖 run 级 false（15 §9 更严格者胜）→ 与 verify gate 一起 FEAT-010 收口。
- reviewer checklist 的 run 模式默认集（15 §10）→ 记录来源字段即可，内容随 FEAT-010。
