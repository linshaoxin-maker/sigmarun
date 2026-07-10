# FEAT-011 自检报告

## 契约符合性

| 契约 | 实现 | 偏离 |
|---|---|---|
| 25 §3.2 条目格式 | 一句话+⟨RUN·日期·refs[·supersedes]⟩；四固定分区+Superseded；MEM-ID 项目级计数器（project.lock） | 无 |
| 25 §3.1/24 §6 载体 | repo 内/非 .team/非 gitignore 三守卫 + doctor 检查 | realpath 归一沿 resolveTeamRoot 既有 |
| 25 §4 五步 | 候选发现（candidates 只列不选）→ 筛选措辞（人/agent）→ 确认（用户执行命令即确认）→ 机械落盘（refs 校验/redaction/编号/盖戳/supersedes）→ git 把关 | `--yes` 批量确认未做（单条即用户显式确认，P1 再议） |
| INV-012 项目级 | refs 必填+可解析（MSG 于本 run 池/路径存在）；secret 即拒 | 跨 run MSG refs 不可证伪——audit AUD-036 只兜底"无戳/路径失效"（书面） |
| 18 #47/48 + AUD-036…040 | 双事件 + 五规则全落地（rules_skipped 仅剩 rev_after/034） | 无 |
| BDD-009-05 | audit warn + status risk 双半场 | 无 |

## 测试 / 质量

- 180/180（新增 8）；覆盖 89.44%/73.24%；真机冒烟五步。
- memory-promote.ts ≈ 240 行；markdown 结构化编辑（分区插入/两行块搬移）集中一处；TODO 0。
- **流程偏离登记**：RED 运行记录本轮未单独截存（测试先写后实现的编写序成立）。

## 安全

- 晋升是继 export 后第二个"出 .team 入 git"口：redaction 拒收 + gitignore 拒 + git PR 终审三层。
