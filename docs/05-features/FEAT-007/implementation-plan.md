# FEAT-007 实现计划

## 改动面

| 文件 | 动作 |
|---|---|
| packages/storage/src/redaction.ts | +redactText（替换管道） |
| packages/storage/src/errors.ts | +evidence_invalid |
| packages/core/src/submit.ts | submitEvidence（九步事务 + 校验清单 + in_scope minimatch + D8 输出） |
| packages/core/src/index.ts | 导出 submitEvidence、fileInScope |
| packages/cli/src/cli.ts | submit 路由 + exit 映射 |
| core deps | minimatch |

## 事务骨架

openRun → run.lock → working+owner 门 → 读 draft → validate（纯函数，错误列表）→ 全过才写：outputs（截断+脱敏）→ handoff → evidence.json（revision/history）→ evidence.md → task/claim 翻转 → D6 skip 分叉 → events（evidence_submitted [+review_skipped]）提交点；validate 失败 → evidence_invalid 事件 + 零状态变更。

## 测试（RED 先行）

- core/test/submit-success.test.ts：全链快乐路径（evidence.json 各 gateway 字段/outputs 落盘/handoff 写入/task+claim submitted/path claim hold/事件 payload 计数）；脱敏替换；截断标记；越界 warning + 计数；require_review=false → approved+review_skipped；context_ack 缺项 warning；返工 revision+history。
- core/test/submit-invalid.test.ts：非 owner / 非 working；required check 未覆盖；acceptance 数量错；skipped 无 note；输出文件缺失；handoff 缺失；changed_files 空——均 evidence_invalid + task 留 working + evidence 目录不生成 + #28 事件。
- cli：submit 路由（成功 + evidence_invalid exit 4）。

## 风险

- fixture 需要 working 态：复用 worktree.test 的真实 worktree 建法（helper 抽到 dispatch/test/fixture.ts）。
- 截断规则边界（首 50+末 200）用行数断言而非字节。
