# FEAT-003 publish（draft→ready，run 激活）

状态：**已交付**（2026-07-10）｜ 源：Slice 2.5 ｜ 依赖：FEAT-002 ｜ 被依赖：FEAT-004+

制品：[mvp-scope](mvp-scope.md) · [verification](verification.md) · [self-check](self-check.md) · [knowledge](knowledge.md)（卡片在 project-knowledge/features/FEAT-003.md）

代码：`packages/core/src/publish.ts` + enum/exit/cli 扩展；测试 +8（累计 60）。留待项去向：BDD-002-02 claim 半场 → FEAT-004 已闭合；minimatch 重叠判定 → FEAT-007（随 in_scope 文件级判定，见 FEAT-004 mvp-scope 改派理由）。
