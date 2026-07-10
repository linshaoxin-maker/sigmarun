# FEAT-006 自检报告

## 契约符合性

| 契约 | 实现 | 偏离 |
|---|---|---|
| 16 §3.1 register 校验（路径存在/是 worktree/branch 规范/owner） | worktree.ts：not_claim_owner→invalid_transition→schema_invalid→io_error 逐层 | base 与 run.base_branch 一致性校验降级为记录（base_commit 机械采集自 HEAD；分支祖先校验需 merge-base，随 FEAT-010 integrate 落地——书面） |
| 16 §3.2 worktrees.json schema | team.worktrees.v1 全字段 | 无 |
| 16 §3.5 reclaim/adopt | applyReclaim 联动 abandoned + adopt 转移 | 重做路径（-attempt-2 新 worktree）由 register 天然支持，未单列命令 |
| 18 #13/42/43 事件 | 全部写入（payload 字段对齐） | 无 |
| 19 §2 RULES / §3.1–3.3 / §4.1 / §6 | templates.ts 全文常量 | **命名声明**：`team` → `sigmarun`（D12）；submit/review 步骤为前向引用（FEAT-007/009 交付），mvp-scope 已书面化 |
| 22 §安装 | repo scope + template_version 头 + --update + AGENTS.md 标记幂等 | user scope 留 P1（书面） |
| run show（19 §3.2 第 1 步） | core/run-query.ts 只读无锁 | 从 FEAT-008 提前的改派已在 mvp-scope 书面化 |

## 测试 / 质量

- 117/117（新增 14）；覆盖 92.65%/79.66%；RED 13 先行；真机全链冒烟（含双工具安装幂等）。
- worktree.ts ≈ 190 行；templates.ts ≈ 250 行（字符串常量为主）；install.ts ≈ 80 行——均在阈内；TODO 0。
- 实现期修正：测试 fixture 仓库为 unborn HEAD，`git worktree add` 需先有 commit——测试助手内补空提交。

## 安全

- 模板逐字保留 RULES 4 的协议不变量（用户也不可越权直改 .team）与 F-c 沙箱守则；AGENTS.md 注入使用显式标记对，不吞用户既有内容。
- agents/adapters 无凭据面；SCA BLOCKED（跨 FEAT）。
