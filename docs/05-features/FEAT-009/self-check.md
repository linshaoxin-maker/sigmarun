# FEAT-009 自检报告

## 契约符合性

| 契约 | 实现 | 偏离 |
|---|---|---|
| 14 §3.1 review claim 四规则 | grantReviewClaim：INV-008（claims 全史+previous_attempts）、20min 租约、单 active/任务、显式与合成同一记录 | 无 |
| 14 §3.2 记录规则 | REVIEW-<TASK>-NN.json 每轮新文件（writeJsonStateNew 拒覆盖=M8 机械保证）；round=evidence revision；must_fix 镜像先行取 MSG id 回链；skip 最小记录 | decision=block 未做（书面留 FEAT-010） |
| 15 §7 D15 合成 | claimNext reviewer 无 --task 分支→synthesizeReview（等待最久=submitted_at asc）；data.kind=review_work；不写 task-list 新行 | verifier 合成随 FEAT-010 |
| 15 §3.3/§4.4 返工 | changes_requested：owner claim 原地复活+续租、path claim 未动；resume→working（task_started resumed=true） | resume 命名对 04 §1.1 的回填检查挂账 |
| 18 #30–33 | review_claimed(round)/review_released(sweep)/review_approved(review_id,round)/changes_requested(must_fix_count) | review_blocked 未发（同 block 留置） |
| AUD-015 inline | claim 守卫 + decide 复检双点 | 无 |
| 17 §3 self_approval_forbidden | enum + exit 6 | 17 §2.2 类表未列该码——归 conflict 类（exit 6），语义一致，不改表 |

## 测试 / 质量

- 159/159（新增 10）；覆盖 90.69%/75.25%；RED 10 先行（2 例实现期修正：guard 序、skip 记录缺失）；真机冒烟（自批拒/合成/approve/五模板）。
- review.ts ≈ 380 行；grantReviewClaim/reviewDecide 线性守卫+写序风格（既有豁免口径）；TODO 0。

## 安全

- INV-008 不受 require_review 开关影响（skip 路径不产生 review claim，自批面不存在）；review 记录不回显 evidence 正文。
