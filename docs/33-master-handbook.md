# 33. sigmarun 一本通(用户 · 高级用户 · 开发者)

> 日期:2026-07-24(v0.2.3 / 模板 0.6.7)
> **这是唯一需要从头读的文档。** 三个身份三个部分,各自自足;其余 docs 是深潜材料,文末有地图。

---

# Part I · 用户(只用聊天窗)

**一次性准备(每 repo 一次):**
```bash
npm i -g sigmarun && cd 你的项目 && sigmarun adapter install --tool=all
```
没有 init 步骤——AI 发现没初始化会自己补(RULE 11)。

**日常三句话:**

| 你想 | 你打 |
|---|---|
| 提需求让 AI 拆 | `/team-plan 给结算页加优惠券` |
| 开工 | `/team-do` |
| 进度 + 该我干嘛 | `/team-status` |

**高级用法:** `/team-do RUN-0002`(指定需求)· `/team-do TASK-0003`(定向领任务)· `--as 窗口名`(固定身份)· `--loop`(连跑)· `/team-review|verify RUN`(第二窗口专职评审/验证)· `/team-dispatch RUN --task= --role= --loop`(全参入口)。不指定时:多个活跃需求 AI 列清单**问你**,绝不猜。

**评审/验证/集成去哪了?** 轻量 run(默认)**根本没有**这三道门——`done` 即收尾。full run(plan 时 AI 问"要独立评审+验证吗?"你说要才开)里它们也**不自动执行**:到点时 `/team-status` 会把门命令递给你("TASK-2 等评审 → 开个新窗口跑 /team-review RUN-xxxx"),评审必须换窗口(INV-008 不许自评)。

**9 条验收(判据全在聊天窗,S0 是总纲):** S1 建需求前必有拆分确认 · S2 只做被批准的一块,做完停 · S3 每个等待态带下一步 · S4 双窗口不同时改同一批文件 · S5 提问答复后继续,不答不瞎干 · S6 删除先预览后执行 · S7 关窗口不丢状态 · S8 终点交还 git · S9 半成品接管先问人 · **S0 全程 AI 没让你跑任何 sigmarun 命令(排障除外),否则记产品 bug**。细节与场景全文见 [31](31-user-journey-and-acceptance.md)。

---

# Part II · 高级用户/操作员(直接用 CLI)

你也可以完全不经聊天窗,拿 CLI 当"项目协作数据库"直接操作。所有命令加 `--json` 得机器面(envelope:`ok/code/data/next_actions`);不加是人面。**任何写命令都在 run.lock 内原子完成并留事件,人和 AI 混用不会撞。**

### 观察(只读,随便跑)

| 干嘛 | 命令 |
|---|---|
| 需求清单(带 user_state+下一步) | `sigmarun run list` |
| 单需求进度 + 需要你处理的 | `sigmarun status <RUN-ID>` |
| 需求详情/任务汇总 | `sigmarun run show <RUN-ID>` |
| 任务列表(可筛) | `sigmarun task list <RUN-ID> [--status=] [--owner=] [--type=]` |
| 单任务全档案(含 previous_attempts) | `sigmarun task show <RUN-ID> <TASK-ID>` |
| 证据面板 | `sigmarun evidence show <RUN-ID> <TASK-ID>` |
| 事件账本(唯一真相,可筛) | `sigmarun events <RUN-ID> [--task=] [--type=] [--since=<seq>] [--limit=]` |
| 谁在干什么 | `sigmarun agent list <RUN-ID>` |
| 任务依赖图 | `sigmarun graph show <RUN-ID>` / `graph validate` |
| 消息池 | `sigmarun msg list <RUN-ID> [--open] [--task=]` |
| 版本+模板代际 | `sigmarun --version` |

### 导入与推进(自己当操作员)

| 干嘛 | 命令 | 注意 |
|---|---|---|
| 手写 payload 建需求 | `sigmarun run import <payload.json> [--lightweight] [--force]` | payload 最小示例见 [29 §5](29-architecture-journey-and-quickstart.md);同 payload 重导会 `duplicate_payload`(指纹去重),`--force` 破例 |
| 放行草稿任务(full) | `sigmarun task publish <RUN-ID>` | planned→active |
| 追加一个任务 | `sigmarun task add <RUN-ID> --file=<task.json>` | full 需再 publish |
| 领任务(你自己也是 agent) | `sigmarun claim-next <RUN-ID> --agent=<你的名> [--task=] [--dry-run]` | 轻量首领自注册;`--dry-run` 只看会领谁 |
| 轻量收工 | `sigmarun done <RUN-ID> <TASK-ID> --agent=<你的名>` | |
| full 交证据 | `sigmarun submit <RUN-ID> <TASK-ID> --agent= --evidence=<draft.json>` | draft 字段见 docs/14 §2.1 |
| 发消息(以人的身份) | `sigmarun msg post <RUN-ID> --from=user --type=<question\|answer\|decision\|...> --body="..." [--task=] [--reply-to=]` | `--from=user` 免注册 |
| 收尾/归档 | `sigmarun report <RUN-ID>` → `sigmarun run archive <RUN-ID>` | 轻量全终态才放行 |

### 人专属动作(设计上只给人,AI 被模板禁止代跑)

| 干嘛 | 命令 | 为什么只给人 |
|---|---|---|
| 暂停/恢复需求 | `sigmarun run pause <RUN-ID>` / `run resume` | 意图判断 |
| 取消需求(红线) | `sigmarun run cancel <RUN-ID>` 先**预览**,`--yes` 才执行 | 破坏性 |
| 取消单任务 | `sigmarun task cancel <RUN-ID> <TASK-ID>` | 同上 |
| 即时收走活租约(不等 90min) | `sigmarun reclaim <RUN-ID> <TASK-ID> --force --agent=user` | 只有人可抢活锁 |
| 批准越界路径 | `sigmarun approve-paths <RUN-ID> <TASK-ID> --paths=<glob,...>` | 授权是人的 |
| 答复后解冻任务 | `sigmarun unblock <RUN-ID> <TASK-ID> --agent=user` | 确认"答完了" |
| 晋升项目记忆(L4,进 git) | `sigmarun memory promote <RUN-ID> --entry="…" --section=Architecture\|Interfaces\|Constraints\|Pitfalls --from=<refs>` | 长期事实要人把关 |

### 运维与恢复

| 干嘛 | 命令 | 注意 |
|---|---|---|
| 环境体检 | `sigmarun doctor [--fix]` | 坏锁等真问题会 `ok:false`+exit 9,不假绿 |
| 完整性审计 | `sigmarun audit run <RUN-ID>` | findings 是数据;有 error 级 **exit 9**(CI 可拦),`--json` envelope 仍 ok:true |
| 按账本修复(备份先行,幂等) | `sigmarun repair <RUN-ID>` | 能清崩溃残留(含幽灵 claim);绝不动活 claim |
| 恢复点 | `sigmarun backup list` → `sigmarun restore <backup-id> [--dry-run]` | restore 上 run 锁,不穿透在途 |
| 归档导出(进 git 的复盘包) | `sigmarun export <RUN-ID> [--to=<dir>] [--full] [--force]` | 出 .team 之外,密文扫描阻断式 |
| 升级模板 | `sigmarun adapter install --tool=all --update` | `--version` 会报 installed 代际漂移 |
| 磁盘 schema 升级 | `sigmarun migrate` | 逐 run 上锁 |

---

# Part III · 开发者(接手代码)

### 三层法则
1. **Slash command 是模板不是代码**:13 命令 = `adapters/src/templates.ts` 字符串常量,`adapter install` 渲染成 `.claude/commands/*.md` + `.agents/skills/*/SKILL.md`;共享注入块 RULES/COLLAB/MIDRUN/DISPATCH_FLOW 改一处全变。**改 AI 行为=改字符串+bump TEMPLATE_VERSION**。
2. **cli.ts 是唯一入口、零业务**:argv→委托→envelope→`EXIT_BY_CODE`;新命令必进 `COMMAND_SURFACE`。
3. **包函数是真实现**:八包栈 `storage→core→dispatch·context→watch·audit→(adapters)→cli`;写操作 run.lock 内、`appendEvent` 为提交点;状态词表单源 `core/state-machine.ts`。

### 命令→代码速查(全表见 [32](32-slash-command-to-code-map.md))
plan→`importRun`/`publishTasks`(core) · do→**`claimNext`(dispatch/claim-engine,防撞车核心)**+done(core/run-ops) · status/runs/tasks/task/evidence→watch/progress.ts(读模型) · dispatch→register+hydrate(context)+worktree(dispatch)+`submitEvidence`(core/submit) · review→dispatch/review(INV-008;request_changes 原地复活 owner claim) · verify→dispatch/verify · integrate→core/integrate(gateway 不碰 git)。

### 七张对账表:漂移怎么被机器拦住

**机制**(以命令面为例,`cli/test/docs-reconciliation.test.ts` 真代码):
```ts
const { mvp } = docCommands();              // A 面:解析 docs/17 §1 的 markdown 表格
const surface = new Set(COMMAND_SURFACE);   // B 面:代码里的命令清单常量
// 双向差集必须都为空——文档承诺没实现会红,实现了没写文档也会红
expect({ promisedNotBuilt, builtNotPromised }).toEqual({ promisedNotBuilt: [], builtNotPromised: [] });
// 第二条:逐条真跑,清单不许撒谎
for (const cmd of COMMAND_SURFACE) expect(runCli(cmd)).not.toMatch(/Unknown command/);
```
**拦在三道门**:①本地 `npm test`;②CI(push/PR 必跑);③`release.yml` 发布前重跑全量——**漂移连 npm 都出不去**。七张表:命令面↔docs/17 · 退出码↔docs/17 §2.2 · 事件目录↔docs/18 · 依赖矩阵(architecture.test)· skill 字段↔代码校验器(field-protocol)· 发布 README 单源(release-packaging)· 用户旅途可执行(journeys)。另有 `npm run smoke`(CI job)守发布产物本身。

### 改哪去哪
AI 行为→templates.ts(+bump)| 校验/状态→对应包+state-machine | 加命令→cli.ts+COMMAND_SURFACE+docs/17 | 退出码→EXIT_BY_CODE+docs/17 §2.2 | 发布→build-release.mjs(自清+重建)| 事件→events.ts+EVENT_STATUS。**心法:改完跑 `npm test`,红的那张对账表=你漏同步的地方。**

---

# 文档地图(其余何时看)

[00](00-user-guide.md) 深度用户参考(full 细节)· [14](14-evidence-review-verification-contract.md) evidence/review/verify 字段契约 · [15](15-run-task-state-machine-and-lifecycle.md) 状态机权威 · [17](17-cli-mcp-contract-and-error-model.md) 命令面+envelope+退出码契约 · [26](26-lightweight-mode.md) 轻量宪法 · [27](27-product-reality-audit-v0.2.0.md) 产品现实审计 · [28](28-test-journey-and-cases.md) 测试地图 · [29](29-architecture-journey-and-quickstart.md) 架构六图+机制上手 · [30](30-three-layer-test-playbook.md) 三层验证 · [31](31-user-journey-and-acceptance.md) 用户旅途全文 · [32](32-slash-command-to-code-map.md) 命令映射全表
