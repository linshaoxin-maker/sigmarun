# FEAT-001 — 项目知识

## 决策记录

- 跨包测试用 vitest alias 指向各包 `src/index.ts`（源对源），运行时经 tsc -b 项目引用出 dist——测试零构建、发布有类型，两全（模式候选）。
- doctor 采用 audit 同款语义：诊断命令自身成功即 `ok:true`，失败项作为 data.checks + warnings 携带（17 §5.1 先例延伸到 doctor）。
- `writeJsonStateNew`（rev=1 拒覆盖）与 `writeJsonStateAtomic`（expectedRev 严格匹配）分离——init 幂等语义不需要读-改-写路径。

## 经验教训

- macOS 下 `os.tmpdir()` 返回 `/var/...` 而 git 输出 `/private/var/...`：team root 解析与测试 fixture 都必须过 `realpathSync`，否则路径断言随机失败（首轮 RED→GREEN 之间唯一的环境坑）。
- `git rev-parse --is-bare-repository --git-common-dir` 一次调用拿两个事实，减少子进程开销；bare 判定必须先于 common-dir 使用。

## 可复用模式

- **检查项自带修复指引**：doctor 每个 fail 的 detail 就是可执行动作（`git rm -r --cached .team/`），warnings 与 next_actions 复用同一文案——NFR-009 的实现套路，后续 audit findings 沿用。

## 应避免的做法

- 不要在测试里操作真实仓库的 `.team`（一律 tmp fixture + afterEach 清理）；不要信任未 realpath 的路径比较。
