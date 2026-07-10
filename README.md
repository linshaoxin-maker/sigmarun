# sigmarun

**让多个 AI 编程窗口（Claude Code、Codex）像一个小团队一样协作同一个项目**——repo-local 的 `.team/` 协作协议 + gateway CLI。coding agent 出智能，gateway 出秩序，`.team/` 是事实源。

> 北极星验收：一个 Claude Code 生成的 `RUN-ID`，能被 Codex 用 `/team-dispatch` 领取唯一 `TASK-ID`、写回 evidence，用户能用 `/team-status` 查到可信 progress。

## 快速入口

| 想看什么 | 去哪 |
|---|---|
| 怎么用（用户视角） | [docs/00-user-guide.md](docs/00-user-guide.md) |
| 设计总索引 + 决策账本 D1–D19 | [docs/README.md](docs/README.md) · [docs/13 §2.1](docs/13-design-audit-and-next-breakdown.md) |
| 方法论工作区（P0–P5 / gate / traceability） | [docs/02-phases/progress.md](docs/02-phases/progress.md) |
| FEAT 清单与开发计划 | [docs/02-phases/P4-feature.md](docs/02-phases/P4-feature.md) |

## 仓库布局

```text
sigmarun/
├── docs/            # 设计语料库（00–25）+ ai-dev-methodology 工作区 + Codex 触发 testkit
└── (packages/ …)    # TS monorepo 九包，随 P5 开工建立（docs/20 §3）
```

## 状态

设计层定稿（26 份文档、D1–D19、双路径触发实测通过）；**P1 需求形式化是开工前最后一步**（[docs/02-phases/P1-requirement.md](docs/02-phases/P1-requirement.md)）。
