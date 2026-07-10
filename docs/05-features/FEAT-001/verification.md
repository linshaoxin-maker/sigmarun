# Feature 验证报告：FEAT-001 `.team` 基座 + init/doctor

> 2026-07-10 ｜ enabler（G4-1 正当性在案）｜ 测试先行证据：实现前 6/6 测试文件 RED（vitest run，模块未实现）

## 1. 四可检验验收

| 检验项 | 结论 | 说明 |
|---|---|---|
| 可感知 | ✅ | 用户执行 `sigmarun init` 看到初始化结果；`doctor` 逐项自检可读 |
| 可演示 | ✅ | 真实二进制冒烟：临时 git 仓库 `init --json` 返回合法 envelope；`doctor` 9 项全 pass（见 §3） |
| 可端到端 | ✅ | argv → cli → core 原语 → storage 原子写 → `.team/` 落盘 → doctor 复检，链路完整 |
| 可独立上线 | ✅（enabler 口径） | 不依赖任何后续 FEAT；npm 包即交付物 |

## 2. 用户感知说明

在 git 仓库内运行 `sigmarun init`：创建 `.team/`（project.json、counters.json、templates/、locks/）并把 `.team/` 追加进 `.gitignore`；重复执行不覆盖、给出 already_initialized 警告。运行 `sigmarun doctor`：git 仓库/团队根/初始化/node 版本/锁能力/.gitignore 条目/tracked 污染/schema 版本逐项报告，每个失败项自带修复指引。`--json` 输出 17 §2 统一 envelope（英文，D16）。

## 3. 演示脚本执行记录（真实二进制，非测试桩）

| 步骤 | 操作 | 预期 | 实际 | 通过 |
|---|---|---|---|---|
| 1 | 临时目录 `git init` | 干净仓库 | 通过 | ✅ |
| 2 | `node packages/cli/dist/bin.js init --json` | ok:true envelope，teamRoot 指向 `.team` | `{"ok":true,"code":"OK","message":"Initialized .team coordination directory."…}` | ✅ |
| 3 | `… doctor` | 全部 check pass | 末四项 pass（gitignore/tracked/project_schema/counters_schema），无 fail | ✅ |

## 4. BDD / 场景锚

- BDD-001 Background（"已 init 且 doctor 全绿"）→ core/test/doctor.test.ts `all checks pass on a freshly initialized repo`
- 17 §12 "doctor 在被污染仓库运行" → doctor.test.ts `AUD-030: detects tracked .team files…`（断言含 `git rm` 指引）
- 21 §10 场景 1（未知 major）→ doctor.test.ts `unknown project schema major is reported as unsupported`
- ERR-006（非 git 环境）→ init/doctor/cli 三处 `not_a_git_repo` 断言，exit 8 映射（cli.test.ts）

## 5. 技术验证汇总（Gate 5）

| Gate | Status | Evidence |
|---|---|---|
| G5-1 构建 | PASS | `npm run build`（tsc -b 三包）exit 0 |
| G5-2 契约符合性 | PASS | self-check.md 契约表，零 `[偏离]` |
| G5-3 单元/集成测试 | PASS | vitest 25/25；行覆盖 91.03%（≥80）、分支 73.21%（≥70）；bin.ts 0%（进程壳，见 self-check 说明） |
| G5-4 回归测试 | N/A | 首个 FEAT，无既有行为可回归；impact matrix 001 行的守门（doctor 自检、NFR-006 round-trip）即本期测试 |
| G5-5 验证报告 | PASS | 本文件 |
| G5-6 活文档 | PASS | traceability P5 回填、CHANGELOG、progress 均已更新 |
| G5-7 知识沉淀 | PASS | knowledge.md + project-knowledge/features/FEAT-001.md |
| G5-8 追溯矩阵终版 | PASS | matrix "P5 回填" 表 FEAT-001 行无空白 |
| G5-9 Git commit | PASS | 见提交 hash（commit message 含 `Refs: FEAT-001`） |
| G5-10 mvp-scope | PASS | mvp-scope.md |
| G5-11 implementation-plan | PASS | implementation-plan.md（CP1，含函数契约与依赖方向） |
| G5-12 自检报告 | PASS | self-check.md |
| G5-13 性能基准 | N/A | FEAT-001 无关联性能 NFR（NFR-003 锁事务属 FEAT-004 宿主） |
| G5-14 安全扫描 | SCA **BLOCKED** / Secrets PASS / SAST N/A | `npm audit` registry audit 端点报错（日志：~/.npm/_logs/2026-07-10T14_11_22_567Z-debug-0.log），网络恢复后补跑；新增代码经 24 §4.2 模式集 grep 零命中；SAST 工具未引入（P1 backlog：semgrep 进 CI） |
| G5-15 架构守护 | PASS（inspection） | 依赖方向 cli→core→storage 经 import 清单人工核查（storage 仅 node 内建；core 仅 storage+zod；cli 仅 core）；dependency-cruiser 接入记 P1 backlog（22 §8 选型已定） |
| G5-16…23 条件门 | N/A | 无 CI/staging/灰度/PR 政策（solo 本地阶段）；CI 建设在 P1 backlog（17 §10 测试矩阵为其内容基线） |

## 6. 残余与待办

- [P1] CI 接入（三平台矩阵 + coverage + dependency-cruiser + semgrep/gitleaks + npm audit 重试）——G5-14/15 的工具化。
- [P2] `resolveTeamRoot` 的 worktree 内 tracked `.team` 警告分支（16 §2.2）留给 FEAT-004（引入 worktree 时一并测）。
