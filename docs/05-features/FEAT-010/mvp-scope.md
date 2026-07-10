# FEAT-010 MVP Scope — verify + integrate + export（复合，子项 010.1–010.3）

> 源：05 Slice 9 ｜ 锚：BDD-006-06/07 + BDD-008-01…05 ｜ 合同：14 §4、16 §4/§7、15 §2（integrating/reported）、18 #7/8/20/36–38、17 §3 export 双码、D7/D11、AUD-017、NFR-004

## 010.1 verify（dispatch/verify.ts）

- `verify submit <RUN> --agent --verify=<draft.json> [--task <TASK>]`（14 §4）：机械校验（D11 边界：exit_code×status 一致、output 存在、verdict=pass ⇔ 全部非 skipped gate pass、skipped 必须带 skip_reasons）→ `verification/VERIFY-%04d.json`（next_verify）+ outputs 落盘（截断+脱敏复用）→ 事件 `verification_started`+`verification_passed|failed`。
- task 级：approved→verified（BDD-006-07 的正门）；fail → changes_requested + owner claim 复活。
- run 级：fail 必须 failures_mapped 非空，逐个映射任务 → changes_requested + 复活（BDD-006-06）。
- **BDD-006-07 负门**：verified 无 pass 记录不可达——状态只经本原语翻转（AUD-017 的 inline 化）。
- `claim-next --role=verifier` 合成 `verify_work`（approved 队列等待最久优先；**无 verify claim 记录**——14 §4 无此 schema，合成为无状态建议；历任 owner 过滤沿用 historicalOwners，独立验证语义）。

## 010.2 integrate + report（core/integrate.ts）

- `integrate start <RUN>`：run active + ≥1 verified → run→integrating + `integration_started`；返回**确定性合并序**（verified 集上 blocks 边拓扑 + priority desc + task_id asc）、integration branch 名（team/<RUN>/integration）、各 task branch（worktrees.json）——**git 由 integrator 执行，gateway 只给序与记账**（16 §4.1/D11）。
- `integrate record <RUN> <TASK> --merge-commit=<sha>`：verified→integrated + **path claim 释放**（15 §4.2 hold 终点）+ `task_integrated`（merge_commit、released_claim_ids）。
- `integrate record --failed --reason=…`：自动落最小 VERIFY 记录（focused_tests fail，verdict fail，failures_mapped=[task]）→ verified→changes_requested + owner claim 复活 + `verification_failed`——单点回退不卡全局（BDD-008-02）。
- `report <RUN>`：守卫（integrating 且无残留 verified）→ 生成 integration.md（合入/回退清单+merge commit）与 report.md → run→reported + `run_reported`（report_ref）。**不合 main**（BDD-008-03：gateway 从不碰 git）。

## 010.3 export（core/export.ts）

- `export <RUN> [--to <dir>] [--full] [--force]`（16 §7）：目标守卫（repo 内、非 .team、未被 gitignore（git check-ignore）、已存在需 --force）→ 默认集（plan/report/integration/run-memory/evidence·md/REVIEW 渲染 md/VERIFY 索引 md）/--full 追加原始 json+outputs+events+graph → **阻断式二次扫描**（全部内容 scanForSecrets，命中 → `export_redaction_hit` + 命中清单 + 零写入，BDD-008-04/NFR-004）→ 落盘 + 文件清单与大小 → 用户自行 git add（gateway 不代提交）。

## Out（书面）

- review decision=block / task 级 review.required 覆盖（15 §9）——**延至收尾轮**（与 verify gate 收口一并，原 FEAT-009 留置顺延）。
- integration worktree 的实建/冲突解决（agent 侧，模板 team-integrate.md 随收尾轮补装）。
- run 级验证的独立 runner（Phase 3，D11 边界不变）。
- export 的归档锚点校验（MEM refs 用）→ FEAT-011。
