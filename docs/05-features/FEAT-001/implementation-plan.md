# FEAT-001 实现方案（CP1）

## 模块拆分（对齐 [20 §3](../../20-c4-l2-l3-component-contracts.md) 九包，本期落地 3 包）

| 模块 | 职责 | 文件 |
|---|---|---|
| @sigmarun/core envelope | envelope 构造 + GatewayError(code) + reason code 枚举子集 | packages/core/src/envelope.ts |
| @sigmarun/core schemas | team.project.v1 / team.counters.v1（zod passthrough，21 §4.2） | packages/core/src/schemas.ts |
| @sigmarun/core lifecycle | initProject / doctorProject 原语（业务规则，前端无逻辑） | packages/core/src/lifecycle.ts |
| @sigmarun/storage team-dir | team root 解析（git common-dir，16 §2 顺序：--team-root > TEAM_ROOT > git） | packages/storage/src/team-dir.ts |
| @sigmarun/storage atomic-write | readState/writeStateAtomic（tmp+rename、rev+1、未知字段保留）、锁能力探测 | packages/storage/src/atomic-write.ts |
| @sigmarun/cli | argv 解析 → primitive → envelope 打印 + exit code 映射（17 §2.2） | packages/cli/src/{cli,bin}.ts |

## 契约引用

- envelope/exit code：17 §2；reason codes：17 §3（本期子集：OK / usage_error / not_a_git_repo / bare_repo_unsupported / team_root_not_found / rev_conflict / unsupported_schema_version / io_error）
- team root：16 §2（含"worktree 内本地 .team 警告"留 FEAT-004 处理 worktree 后补，本期实现主路径 + bare 拒绝）
- project.json 字段：02 §6；tracked .team 检测：16 §1.4 / AUD-030

## 依赖方向（20 §5 强制）

cli → core → storage；storage 不依赖任何业务包；测试按包内单元 + lifecycle 集成（真实 git fixture）。

## 测试先行清单（红 → 绿）

| 测试文件 | 覆盖 |
|---|---|
| storage/test/team-dir.test.ts | 仓库根/子目录解析一致；非 git 目录 → not_a_git_repo；bare → bare_repo_unsupported |
| storage/test/atomic-write.test.ts | rev 严格 +1；期望 rev 不符 → rev_conflict；**未知字段 x_custom round-trip 保留**；tmp 残留清理 |
| core/test/envelope.test.ts | envelope 形状（17 §2 七字段）；失败必带 next_actions（NFR-009）；message 英文 |
| core/test/init.test.ts | 结构创建齐全；.gitignore 追加且只追加一次；幂等二次执行 ok+warning；project.json 字段对齐 02 §6 |
| core/test/doctor.test.ts | 初始化后全绿；非 git → not_a_git_repo；tracked .team fixture → 该项 fail + 指引（AUD-030）；project.json 改 v9 → unsupported_schema_version 检出 |

## 风险与缓解

- git 子进程输出跨平台差异 → 统一 trim + 绝对路径归一（realpath）
- 测试污染真实仓库 → 全部用 os.tmpdir 下临时 git fixture，afterEach 清理
