# 测试旅程与用例地图

`prodfix/integration`→main 合并后 · **59 测试文件 / 393 用例**(`npm test`,vitest 直编源码)· force-clean 全绿 · typecheck 干净

三种"旅程"读法:①端到端用户旅程(跨子系统的流),②按子系统的用例覆盖,③横切不变量守卫(对账/一致性测试),④19 项产品现实修复各由哪条测试锁定。

---

## 1. 端到端用户旅程(跨子系统)

| 旅程 | 步骤链 | 主要测试文件 |
|---|---|---|
| **轻量(solo 最常见)** | init → import --lightweight → claim-next(自注册)→ 干活 → done → report(全 done)→ archive | `core/lightweight`(9)· `core/init`(7)· `dispatch/claim`(14) |
| **full 流水线** | import → task publish → agent register → claim-next → worktree register → submit(evidence)→ review → verify → integrate → report | `core/publish`(8)· `dispatch/worktree`(11)· `core/submit-success`(6)/`submit-invalid`(11)· `dispatch/review`(15)· `dispatch/verify`(6)· `core/integrate`(10) |
| **崩溃恢复** | audit run(检损)→ repair(账本驱动、备份优先、幂等)· backup → restore(可逆) | `audit/audit`(13)· `audit/repair`(5)· `audit/repair-ghost-claim`(11)· `core/backup`(4)· `storage/backup`(2) |
| **多窗口并发(唯一硬核心)** | 8+ 路真子进程并行 claim 同批/同一任务 → 每任务≤1 活 claim、seq 无缝、零双认领 | `cli/concurrency`(1,真子进程)· `storage/lock`(9,含"不抢活锁/mkdir→meta 竞态/死 pid 即抢") |
| **onboarding** | --version(gateway+模板代际)→ init → doctor(健康/坏锁诚实)→ adapter install(Claude `.claude/commands`、Codex `.agents/skills`)→ /team-plan | `core/doctor`(10)· `core/init`(7)· `adapters/install`(8)· `cli/cli`(31) |
| **等用户 / 观测** | 未答问题、blocker 答了没 unblock、awaiting_review 等 → needs_user 有可跑命令、user_state 不谎报 | `watch/status`(14)· `dispatch/block`(3)· `dispatch/lease`(10) |

---

## 2. 按子系统的用例覆盖

- **storage(7 文件/29)**:原子写+rev 乐观锁、mkdir 锁(抢占/竞态/硬上限)、备份、日志、schema migrate-on-read、密文围栏、team-root 解析序。
- **core(23 文件/~140)**:init、doctor、envelope 契约、events(读/rev/**崩溃安全 seq**)、export(阻塞式密文扫)、import(happy/**must-reject 表**/dedup/cycle)、integrate+report、**lightweight 全链**、migrate、p1-surface 生命周期、publish、run show、**submit(happy/**11 条 mechanical 失败**/字段名 P0-4)**、TxKernel 版本写闸。
- **dispatch(11 文件/76)**:claim-next(14,含目录/并行/limit)、worktree register(11)、review(15,含 D15 synthesis/INV-008)、verify(6)、lease/heartbeat(10)、block、cleanup、register(+**P1-6 注册指引**)。
- **context(5 文件/29)**:graph validate、hydrate(读路径 must_read)、memory promote(INV-012)、msg post(INV-011 不镜像事件)+**P1-6 msg 指引**。
- **adapters(2 文件/16)**:install(版本头/RULES/幂等/**Codex→.agents/skills**)+ **field-protocol-reconciliation(8,新守卫)**。
- **watch(2 文件/17)**:status(14,Needs-user/派生进度/**不谎报**)、watch --once。
- **audit(3 文件/29)**:audit run(findings 是数据、exit 0/**error→exit 9**)、repair(5)、**repair-ghost-claim(11,P1-9 红线)**。
- **cli(6 文件/45)**:cli 前端(31,parse/delegate/exit 码/--version/--help/**人面列表**)、concurrency、conformance、**docs/journeys/release-packaging/field-protocol 四类对账**。

---

## 3. 横切不变量守卫(对账/一致性测试)—— 防 drift 的机器守卫

| 守卫 | 对账什么 | 文件 |
|---|---|---|
| **命令面** | docs/17 §1 命令表 ↔ 真实 CLI 命令(无幽灵行/无漏行)+ 每命令真能 dispatch | `cli/docs-reconciliation`(4) |
| **退出码** | EXIT_BY_CODE ↔ docs/17 §2.2 文档退出码行 | 同上 |
| **envelope** | 每命令一个良构 envelope、统一失败类 | `cli/conformance`(1) |
| **用户旅程** | 旅程可执行、有终点、无缠绕(product-axis) | `cli/journeys`(5) |
| **架构依赖** | docs/20 §5 依赖矩阵 ↔ 实际 import(单骨架) | `core/architecture`(5) |
| **发布单源** | npm README = 根 README、无 stale 标记(P0-2) | `cli/release-packaging`(3) |
| **★字段协议(新)** | **skill 模板 ↔ gateway 校验器:代码要的每个字段,skill 必点名**(plan/evidence/verify/review,×Claude/Codex) | `adapters/field-protocol-reconciliation`(8) |

> ★ 新守卫补的正是 drift 空白:此前 P0-4(output_ref/output_file)、cmd_id、Codex plan/review 漏字段都能溜进来,因为没有一道测试把 skill 教 AI 构造的字段和代码校验的字段绑一起。现在有了。

---

## 4. 19 项产品现实修复的测试锁定

| 修复 | 锁定测试 |
|---|---|
| P0-2 README 单源 | `cli/release-packaging` |
| P0-3 Codex .agents/skills | `adapters/install` |
| P0-4 evidence 字段名 | `core/submit-field-names` |
| P0-5 seq 崩溃安全 | `core/events-append-seq` |
| P0-6 坏 JSON 恢复 | `audit/repair` |
| P1-1 版本可见 | `cli/cli`(--version 块) |
| P1-2/1-3 观测/review 命令 | `watch/status` |
| P1-6 注册指引(4 emitter) | `dispatch/register-guidance` + `context/msg-guidance` |
| P1-7 doctor 诚实 | `core/doctor` |
| P1-8 restore 上锁 | `core/backup`(P1-8 用例) |
| P1-9 幽灵 claim 红线 | `audit/repair-ghost-claim`(含"活 claim 不被碰"守卫) |
| P1-10 锁不忙等/抢占 | `storage/lock` |
| P1-11 findings 渲染 | `cli/cli` |
| P1-12 audit exit 码 | `cli/cli`(audit exit 9 用例) |
| 断点#1 人面列表 | `cli/cli`("HUMAN-face validation …") |
| 字段协议一致 | `adapters/field-protocol-reconciliation` |

> P0-1/P1-1(版本 bump/发布线)由 `release-packaging` + `cli --version` 覆盖;P1-4/P1-5(入口/worktree 依赖)是模板/引导文案,由 `install` 存在性 + 真机 golden journey 覆盖(模板文案无独立单测,靠 clean-install 旅程实跑)。

---

## 已知测试盲区(诚实标注,进残余/下一阶段)

- ~~发布产物层无单测~~ **已补**:`npm run smoke`(`scripts/smoke-tarball.mjs`)打真 tarball → 装到隔离前缀 → 驱动装出来的 CLI 跑 14 项断言(版本/adapter 路径/轻量旅程/断点#1);CI 新增 `smoke` job(ubuntu/node22)每次 push/PR 跑。测试直编源码测不出的"陈旧包/files 漏列/bin shebang/装错路径"由它兜住。
- **模板文案的语义**:field-protocol 守卫查"字段被点名",不查"用法解释正确";真机 golden journey 是唯一端到端验证,非自动化每次跑。
- **repair 的 done/integrated/cancelled 可清子例**只验了 ready/verified/integrated 三种,其余共用同一 `CLEANABLE` 分支(未逐一单测)。
- **跨用户 pid、时钟回拨**等锁边界只读码未黑盒压。
