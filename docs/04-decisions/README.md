# 04-decisions — ADR 台账

**现行制度**：D1–D19 以台账形式维护于 [../13 §2.1](../13-design-audit-and-next-breakdown.md)（含背景、裁决、影响、复议记录），等效 ADR-001…019——**不重复建档**（path-resolution 反双份规则）。

## D → 主题速查

| D | 主题 | | D | 主题 |
|---|---|---|---|---|
| D1 | 形态 A→B→C 演进 | | D11 | gateway 不执行 checks |
| D2 | 首发 Claude Code + Codex | | D12 | 定名 `sigmarun` |
| D3 | TypeScript/Node + minimatch | | D13 | Codex 触发实测（已闭环） |
| D4 | `.team/` 全 gitignore | | D14 | 永不做 daemon；watch 进 MVP |
| D5 | dispatch 干完即停 | | D15 | review/verify 工作项合成 |
| D6 | review 默认必须、可关留痕 | | D16 | envelope 一律英文 |
| D7 | 允许多 active run | | D17 | 窗口可寻址 + 定向 + 防重 |
| D8 | required_checks 附原始输出 | | D18 | 跨 run 冲突 warn/block 可配 |
| D9 | stale 惰性探测 + 3×TTL 回收 | | D19 | L4 项目记忆 |
| D10 | 三模式全进 MVP | | | |

**新决策规则**：自 **ADR-020** 起在本目录建独立文件（模板：ai-dev-methodology `templates/adr.md`），并在 13 §2.1 追加一行指针，保持台账完整。
