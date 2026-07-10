# FEAT-007 MVP Scope — evidence 门禁 submit

> 源：05 Slice 6 ｜ 锚：UC-005（BDD-005-01…08 主群）+ F1 失效模式正面锚 ｜ 合同：14 §2 全节（schema/字段规则/D8 输出策略/submit 九步事务）、15 §3.3 working→submitted、18 #27/28 + AUD-011/013/014/028 inline 半场、24 §4 脱敏管道、INV-007/010

## In

- **`submit <RUN> <TASK> --agent --evidence=<draft.json>`**（core/submit.ts，matrix 定位 core/lifecycle）：
  - 事务九步（14 §2.3）：run.lock → 状态门（working + owner）→ **全量机械校验先行（零变更回滚）** → in_scope 重算 → outputs 落盘（截断+脱敏）→ evidence.json/evidence.md/handoff 写入 → task/claim → submitted（path claim 按 hold 保持，15 §4.2）→ D6 半场（require_review=false → approved + `review_skipped`，actor=policy）→ `evidence_submitted` 提交点。
  - 校验清单（每失败一条进 data.errors，整体 `evidence_invalid` exit 4 + 事件 #28）：summary/changed_files 非空；required_checks_results 覆盖 task.required_checks 每条（skipped 必须带 note）；对应 command 存在且原始输出文件存在；acceptance 与 task.acceptance 数量+文本逐条对齐、status ∈ met/unmet/partial；handoff 内容必供（gateway 代写 context/tasks/<TASK>.md——RULE 2 下 agent 不可直写 .team，FEAT-005 留债的写半场）；context_ack 有上游时必填且引用存在。
  - **in_scope 由 gateway 重算**（不信 agent 自报，AUD-014 精神）：minimatch 文件级判定——FEAT-003/004 挂账的升级在此落地；越界 → warning + `out_of_scope_count`（严重度可配随 P1）。
  - **D8 输出策略**：draft `commands[].output_file` → 读取 → 截断（首 50 行+末 200 行，256KB 上限，`output_truncated`）→ 脱敏（`[REDACTED:kind]`，storage/redaction 升级出替换管道）→ `outputs/<cmd_id>.log`。
  - **AUD-028 提交半场**：context_ack 与最近一次 context_hydrated.must_read 对账，缺失 → warning `handoff_not_acknowledged`。
  - **返工 revision**：已有 evidence → 归档 `history/rev-N.json`、revision+1（changes_requested 回环的承载面，回环触发随 FEAT-009）。
- storage/redaction.ts 升级：`redactText(text)`（模式替换 + hits），scanForSecrets 保留。
- 文本字段（summary/handoff/risks…）同过脱敏管道：命中即替换 + 警告（24 §4）。
- 错误码 `evidence_invalid` 入 enum + exit 4（17 §3 既有，非新增）。
- cli 路由 `submit`。

## Out（书面）

- review/changes_requested 回环触发、review claim → FEAT-009（本 FEAT 仅承载 revision 递增与 D6 skip 半场）。
- `evidence show` 查询面板 → FEAT-008；AUD-011/013/014 的 audit 复检面 → FEAT-008。
- 独立 runner 亲自执行 checks（防伪造）→ Phase 3（D11：输出真伪不验，只验结构一致）。
- out_of_scope 严重度 run policy 可配（默认 warn）→ P1 配置面。

## Draft 输入形状（agent 侧产物，非 .team 内文件）

team.evidence.v1 去 gateway 计算字段：`summary/changed_files[{path,change_type}]/commands[{cmd_id,cmd,exit_code,output_file?}]/required_checks_results/acceptance/context_ack?/handoff(内容字符串)/risks?/deviations?/follow_ups?`——`in_scope/submitted_at/revision/claim_id/agent_id/output_ref` 一律 gateway 填。
