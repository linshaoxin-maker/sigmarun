# FEAT-002 plan 导入（payload → RUN/TASK）

状态：**已交付**（2026-07-10）｜ 源：Slice 2 ｜ 依赖：FEAT-001 ｜ 被依赖：FEAT-003…011

| 制品 | 文件 |
|---|---|
| 范围 / 方案 | [mvp-scope.md](mvp-scope.md) / [implementation-plan.md](implementation-plan.md) |
| 自检 / 验证 | [self-check.md](self-check.md) / [verification.md](verification.md) |
| 知识 | [knowledge.md](knowledge.md)（摘要在 project-knowledge/features/FEAT-002.md） |

代码：`packages/storage/src/{lock,redaction,errors}.ts`、`packages/core/src/{events,payload,run-import}.ts`、cli 路由扩展；测试 +27（累计 52）。合同 backflow：`duplicate_payload` 已回填 17 §3 / 09 §6。
