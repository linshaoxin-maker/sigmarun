# FEAT-010 实现计划

## 改动面

| 文件 | 动作 |
|---|---|
| packages/dispatch/src/verify.ts | verifySubmit（task/run 双目标）+ synthesizeVerify |
| packages/dispatch/src/claim-engine.ts | verifier 分支 |
| packages/core/src/integrate.ts | integrateStart / integrateRecord / reportRun |
| packages/core/src/export.ts | exportRun（阻断式扫描） |
| storage errors | +export_target_invalid / export_redaction_hit |
| cli | verify submit / integrate start·record / report / export 路由 |

## 测试（RED 先行）

- dispatch/test/verify.test.ts（6）：task pass 全链（VERIFY 记录/事件对/approved→verified）；exit_code×status 不一致拒；verdict 与 gate 矛盾拒；task fail→changes_requested+复活；run fail→failures_mapped 逐个翻转；verifier 合成 verify_work。
- core/test/integrate.test.ts（4）：start 拓扑序 [T1,T2,T3]（T1→T2 依赖）+ integrating；record 成功→integrated+path claim 释放；--failed→最小 VERIFY+changes_requested+继续；report→reported+两清单+main 零新提交。
- core/test/export.test.ts（4）：正常导出清单；secret 注入→export_redaction_hit+零写入；gitignore 目标拒；--force 覆盖。
- fixture：driveToVerified（claim→worktree→submit→review→verify pass 链式助手）。

## 风险

- integrate 测试的 verified 前置较重（三任务全链）——助手复用既有原语，串行 ~3s 可接受。
- export 的 check-ignore 在测试 tmp 仓库可靠（.gitignore 内容可控）。
