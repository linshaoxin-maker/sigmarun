# FEAT-011 实现计划

## 改动面

| 文件 | 动作 |
|---|---|
| packages/context/src/memory-promote.ts | promoteMemory / memoryCandidates |
| packages/audit/src/engine.ts | AUD-036…040 规则批（rules_skipped 相应销账） |
| packages/watch/src/progress.ts | memory_oversize 风险 |
| packages/core/src/lifecycle.ts | doctor +project_memory_committable |
| packages/storage/src/errors.ts | +memory_entry_invalid |
| packages/cli/src/cli.ts | memory promote / candidates 路由 |

## 测试

context/test/memory-promote.test.ts（8）：晋升全断言（骨架/条目/戳/事件/计数器）；四类拒收（无 refs/悬空 ref/secret/坏分区）+ 零写入；supersedes 全链 + 悬空拒；gitignore 目标拒；candidates；AUD-036/037/038/040 注入即中 + status 风险。

## 备注

- RED 形态：测试先于实现编写（模块缺失即失败）；本轮未单独留 RED 运行记录——偏离登记于 verification G5-2。
