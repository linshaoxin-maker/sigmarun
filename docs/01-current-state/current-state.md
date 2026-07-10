# Current State — sigmarun / Team Run Protocol

> 更新：2026-07-10 ｜ Mode: Full ｜ Layout: workspace-grouped
> 本目录是方法论工作区；设计语料库是同级的编号文档 00–25（保持原位，不迁移）。

## 项目是什么

面向 AI4Coding 的 repo-local 多智能体协作协议 + gateway（CLI 名 `sigmarun`，D12）。Claude Code / Codex 出智能，gateway 出秩序，`.team/` 是事实源。北极星验收见 [../README.md](../README.md)。

## 现在有什么（2026-07-10 快照）

| 资产 | 状态 | 位置 |
|---|---|---|
| 设计语料库 27 份（用户手册 00 + 设计 01–12 + 审计决策 13 + 合同 14–25） | **全部定稿**，经三轮 review + reconciliation 回写 | `../00-*.md` … `../25-*.md` |
| 决策账本 D1–D19 | 已定 | [../13 §2.1](../13-design-audit-and-next-breakdown.md) |
| 缺口台账 M1–M43 + 失败模式 F1–F5 | 全部裁决/登记 | 13 附录 B/C |
| Codex 触发实测（两轮，跨 0.142.5/0.144） | 全判据通过 | [../19 §8](../19-agent-adapter-pack-claude-codex.md) + `../testkit-codex-trigger/` |
| 代码 | **尚无一行**（实现仓库未创建） | — |
| 本方法论工作区 | 本轮建立 | `01-current-state/` `02-phases/` `03-architecture/` `04-decisions/` `05-features/` |

## 阶段完成度（详见各 phase 文档的 gate 表）

| 阶段 | 状态 | 一句话 |
|---|---|---|
| P0 Idea | ✅ G0 全绿 | 定位/边界/旅途/风险/glossary（2026-07-10） |
| P1 Requirement | ✅ G1 全绿 | R-001…013、UC-001…009、NFR×9、UX×5、ASM×6、安全合规 |
| P2 Spec | ✅ G2 全绿 | Functional Spec + BR-001 + ERR-001…006 + 17 §3 全量错误码映射 + **BDD 55 场景** |
| P3 Design | ✅ G3 全绿 | 4+1/C4/合同/ADR/STRIDE/impact matrix（G3-17 SKIPPED 留痕） |
| P4 Feature | ✅ G4 全绿 | FEAT-001…011 + 依赖 DAG + Impact Matrix（G4-7 N/A） |
| P5 MVP | 未开始 | **唯一剩余**：commit 基线 → TS monorepo → FEAT-001 |

## 下一步（按序）

1. `git commit` 设计基线（待用户发令；worktree 目前全部为本项目新增文件，无无关改动）。
2. P5 开工：仓库根按 [../20](../20-c4-l2-l3-component-contracts.md) 九包建 TS monorepo，从 FEAT-001 起逐个走 `05-features/FEAT-XXX/`（失败测试先行）。

## project-knowledge

见 [project-knowledge/README.md](project-knowledge/README.md)（随首批条目启用）。
