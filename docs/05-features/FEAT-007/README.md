# FEAT-007 evidence 门禁 submit

状态：**已交付**（2026-07-11）｜ 源：Slice 6 ｜ 依赖：FEAT-006 ｜ 被依赖：FEAT-008…010

制品：[mvp-scope](mvp-scope.md) · [implementation-plan](implementation-plan.md) · [verification](verification.md) · [self-check](self-check.md) · [knowledge](knowledge.md)（卡片在 project-knowledge/features/FEAT-007.md）

代码：core/submit.ts（九步事务 + 校验清单 + in_scope minimatch 重算 + D8 截断/脱敏 + handoff 代写 + revision/history + D6 skip）；storage/redaction 升级替换管道；cli submit 路由；测试 +14（累计 131）。顺带修复 FEAT-004 潜伏缺陷（default_policy 字段名错读）。留待：review 回环触发 → FEAT-009、evidence show/audit 复检 → FEAT-008。
