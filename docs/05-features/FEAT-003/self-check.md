# FEAT-003 自检报告

## 契约符合性

| 契约 | 实现 | 偏离 |
|---|---|---|
| 15 §6 publish 流程（子集/全量、幂等跳过） | core/publish.ts | 无 |
| 15 §2.3 planned→active + run_activated(published_count) | 同上 | 无 |
| 15 §2.4 状态门（仅 planned/active 可发布） | 同上 | 无 |
| D18/16 §5 跨 run 检查（warn 默认/block+--force；发布前置零变更） | findCrossRunOverlaps | **声明**：重叠判定为保守前缀祖先法（10 §8.2 第 2 行），minimatch 全量判定随 FEAT-004 dispatch/path-conflict——mvp-scope 已书面化，非静默偏离 |
| 18 §2 #11/#2/#45 事件（actor user/policy、payload 字段） | appendEvent 调用段 | 无 |
| 17 §2.2 exit（run_not_active→7、not_found→5、cross_run_conflict→6） | cli EXIT_BY_CODE | 无 |

## 测试 / 质量

- 60/60（新增 8）；覆盖 93.48%/80.51%；RED 先行在案；真机冒烟 2 步。
- publish.ts ≈ 170 行（<500）；publishTasks ≈ 100 行——超 50 阈值豁免同前例（单事务线性写序）；TODO 0；依赖方向合规（inspection）。
- 回归：52 既有用例全绿。

## 安全

- 新增代码无 secret 面；SCA BLOCKED（跨 FEAT）；envelope 不回显文件内容。
