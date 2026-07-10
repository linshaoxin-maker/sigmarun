# FEAT-006 实现计划

## 改动面

| 文件 | 动作 |
|---|---|
| packages/dispatch/src/worktree.ts | registerWorktree / adoptWorktree |
| packages/dispatch/src/claim-engine.ts | applyReclaim 扩展：worktree → abandoned + previous_attempts 带 worktree 字段 |
| packages/core/src/run-query.ts | runShow（只读，无锁） |
| packages/adapters/src/{templates.ts,install.ts,index.ts} | 模板常量（19 全文，sigmarun 命名）+ installAdapters |
| packages/cli/src/cli.ts | 路由 worktree register/adopt、run show、adapter install |
| 根接线 | adapters 包（vitest/build/cli deps/tsconfig） |

## 测试（RED 先行）

- dispatch/test/worktree.test.ts：register 全断言（working/entry/base_commit/事件序）；非 owner / 未 claimed / 坏 branch / 路径缺失四守卫；reclaim→abandoned+previous_attempts 带路径；adopt 全链（owner 转移+worktree_adopted+working）；无可 adopt → invalid_transition。
- core/test/run-show.test.ts：概要+rollup+计数；run_not_found。
- adapters/test/install.test.ts：claude-code 三文件+template_version+RULES 块+sigmarun 命名；重装跳过 / --update 覆盖；AGENTS.md 标记幂等；codex SKILL.md。
- cli：run show + adapter install 路由用例。

## 风险

- 真实 git worktree 在测试临时仓库中创建（helpers 的 repo 是真 git 仓库，`git worktree add` 可用）；macOS realpath 已在 helpers 处理。
- worktrees.json 首写走 readOrDefault+saveState 既有模板。
