# FEAT-002 实现方案（CP1）

## 模块拆分

| 模块 | 职责 | 文件 |
|---|---|---|
| storage/lock | `acquireLock(dir,{timeoutMs,staleMs})` → release；退避重试；stale 接管 | packages/storage/src/lock.ts |
| storage/redaction | 24 §4.2 八类 secret 模式 `scanForSecrets(text)`（本期 warn-only，FEAT-007 复用为替换管道） | packages/storage/src/redaction.ts |
| core/events | `appendEvent(runDir, evt)`：events.meta.json seq 分配 + jsonl 追加（调用方持锁） | packages/core/src/events.ts |
| core/payload | zod `team.plan_payload.v1`（09 §3–5）+ `validatePayload` → {errors, warnings}（含伪造字段扫描、路径规范、DAG 环检测） | packages/core/src/payload.ts |
| core/run-import | `importRun({payloadDoc, force})` 原语：锁内分配 ID → 状态文件 → events 提交点 | packages/core/src/run-import.ts |
| cli | `run import <file> [--force]` 子命令路由 | packages/cli/src/cli.ts（扩展） |

## 关键契约

- 写入顺序（17 §5.3）：tasks/* → task-list → task-graph → run.json → plan/memory → counters → **events 最后**。
- ID 格式（17 §6）：`RUN-%04d`（project counters，project.lock 内）/ `TASK-%04d`（run counters）。
- 事件（18 §2 #1/#10、§3）：actor = source.agent_id ? agent : user；`run_created.payload.rev_after` 携带本事务各文件 rev。
- 失败零残留：校验全部通过后才创建 run 目录；目录创建后的 io 失败 → 尽力回滚删除并报 io_error。

## 测试先行清单

| 文件 | 覆盖 |
|---|---|
| core/test/import-success.test.ts | BDD-001-01：全套文件落盘、draft 状态、ID 映射、events seq 1..3、graph 无 status、counters 递增、连续导入得 RUN-0002 |
| core/test/import-validation.test.ts | BDD-001-02/03 + 09 §8.1 参数化八案：逐条错误定位 + **零落盘**断言 |
| core/test/import-dedup.test.ts | BDD-001-04：同 payload 二次导入 → `duplicate_payload` 指向 RUN-0001；`--force` 得 RUN-0002 |
| core/test/import-cycle.test.ts | AUD-021：blocks 环 → 拒绝 + 环路径提示 + 零落盘 |
| core/test/import-warnings.test.ts | BDD-001-05 + 09 §8.2：无 paths 警告、secret 文本警告、ready 降级警告，导入仍成功 |
| storage/test/lock.test.ts | 占锁超时 `lock_timeout`；stale（mtime>30s）接管成功；释放后可再获取 |
| cli/test/cli.test.ts（扩展） | `run import --json` exit 0；缺文件参数 → usage_error |
