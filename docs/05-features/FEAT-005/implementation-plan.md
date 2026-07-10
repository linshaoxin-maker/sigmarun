# FEAT-005 实现计划

## 改动面

| 文件 | 动作 |
|---|---|
| packages/context/{package.json,tsconfig.json} | 新包（deps: core+storage） |
| packages/context/src/context-plane.ts | postMessage / listMessages / hydrateContext / validateGraph / updateRunMemory |
| packages/context/src/index.ts | 导出 |
| packages/cli/src/cli.ts | 路由 msg post / msg list / context hydrate / graph validate / memory update |
| 根 package.json / vitest / cli deps+tsconfig | context 包接线 |

## 要点

- messages.jsonl 追加走 run.lock（MSG 序号分配），但**不写 events**（INV-011 测试锚定）。
- 开放问题派生：question 集合减去被 answer.in_reply_to 命中的集合——list 与 hydrate 共用一个纯函数。
- hydrate 只读 + 单事件；上游入边从 task-graph.json 的 blocks/produces_context_for 反查。
- run-memory.md 是 markdown（非 json state）：tmp+rename 原子替换，无 rev。

## 测试（RED 先行）

- msg.test.ts：post 全字段+计数器；type/body/未注册守卫；secret warn；**events.jsonl 不增行**；list 过滤 + --open 派生（answer 关闭 question）。
- hydrate.test.ts：基础 pack + context_hydrated 事件；上游 handoff 文件入 must_read；D19 docs/team/MEMORY.md 继承；risks 模板；previous_attempts 透传；task_not_found。
- graph.test.ts：合法图 ok；手改注环 → AUD-021 复检出；悬空边 → AUD-022。
- memory.test.ts：正常替换；secret 拒收；无出处 warn。
