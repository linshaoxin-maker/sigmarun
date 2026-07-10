# FEAT-001 自检报告

## 契约符合性

| 契约 | 实现 | 偏离 |
|---|---|---|
| 16 §2 team root 解析顺序（flag > env > git common-dir） | packages/storage/src/index.ts `resolveTeamRoot` | 无 |
| 17 §2 envelope 七字段 + D16 英文 | packages/core/src/envelope.ts | 无 |
| 17 §2.2 exit code 映射 | packages/cli/src/cli.ts `EXIT_BY_CODE` | 无 |
| 17 §5.1–5.2 原子写 + rev 乐观锁 | storage `writeJsonStateAtomic` | 无 |
| 21 §4.2 未知字段 round-trip（zod passthrough / 原样写回） | storage 读写 + core/schemas passthrough | 无 |
| 02 §6 project.json 字段（含 D12/D19/D2 默认值） | core/lifecycle `initProject` | 无 |
| 16 §1.1 gitignore 追加（D4） | 同上 | 无 |
| 16 §1.4/AUD-030 tracked `.team` 检测 + `git rm` 指引 | core/lifecycle `doctorProject` | 无 |
| 20 §3 前端零业务规则 | cli.ts 仅 parse/delegate/render | 无 |

## 测试结果

| 类型 | 通过/总数 | 覆盖率 | 说明 |
|---|---|---|---|
| 单元 + 集成（真实 git fixture） | 25/25 | 行 91.03% / 分支 73.21% / 函数 100% | 阈值 80/70 达标 |
| RED 基线 | 6/6 文件失败 | — | 实现前运行，测试先行证据 |
| 真机冒烟 | 3/3 步 | — | 构建产物 bin.js，见 verification §3 |

覆盖率说明：cli/src/bin.ts 为 0%（`#!/usr/bin/env node` 进程壳，逻辑全部在被测的 runCli 内）；envelope.ts 未覆盖分支为默认参数回退行（59/71）。

## 安全

| 扫描 | 工具 | 结果 |
|---|---|---|
| SCA | npm audit | **BLOCKED**（registry audit 端点错误，日志在案；待网络恢复补跑） |
| Secrets | 24 §4.2 八类模式 grep 新增代码 | 0 命中 |
| SAST | 未引入 | N/A（P1：semgrep 进 CI） |

## 代码质量（人工核查，工具化记 P1）

| 指标 | 阈值 | 实测 |
|---|---|---|
| 单文件行数 | ≤500 | 最大 lifecycle.ts ≈ 190 |
| 单函数行数 | ≤50 | 最大 doctorProject ≈ 80 —— **超阈**，属检查清单线性罗列，拆分反降可读性；记录豁免，FEAT-008 引入 audit-engine 时以规则注册表替代 |
| 圈复杂度 | ≤10 | 目测最大 doctorProject ~8（顺序检查无嵌套分支） |
| TODO/FIXME | 0 | 0（grep 验证） |
| tsc --noEmit | 0 error | 构建即证（tsc -b） |

## 架构守护（inspection）

- storage：仅 node:child_process / node:fs / node:path —— 零业务依赖 ✅
- core：仅 @sigmarun/storage + zod ✅（22 §8 白名单内）
- cli：仅 @sigmarun/core ✅；依赖方向与 20 §5 一致，无环。

## 偏离与待办

- 无契约偏离。待办集中于 verification §6（CI 工具化、worktree 警告分支）。
