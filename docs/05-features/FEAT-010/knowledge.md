# FEAT-010 — 项目知识

## 决策记录

- integrate 的 git 边界：gateway 只发"序 + 指令文本"、收"record 回执"——D11（gateway 不执行）在最有诱惑力的地方（合并）也未破例。
- `--failed` 自动落最小 VERIFY 记录：事件合同（#38 必带 verify_id）倒逼出的设计——**当事件字段必带时，产生该字段的记录就不能是可选的**。
- 依赖门冲突化解：BDD-008 背景（链上任务先后 verified）与 10 §6 严格档（done）相撞——按 10 §6 既写的"run policy 放宽"落 `deps_satisfied_when`，默认不变、测试用放宽档，两份合同零修改。
- verifier 合成无状态：无 schema 就不造 claim 文件；竞态由状态门（approved→verified 单向）天然消解。

## 经验教训

- 跨 FEAT 的状态链 fixture（driveToVerified）比单测贵一个数量级——把"驱动到某状态"做成助手而不是在每个测试里手搓，是复合 FEAT 测试可维护性的关键。

## 可复用模式

- mapTaskToRework（changes_requested + owner claim 复活）——review/verify/integrate 三个失败路径共用。
- 阻断式扫描（全收集→全扫→全写或全不写）——任何"出 .team"的口子照此办理。

## 应避免的做法

- 不要让 report 在还有 verified 未 record 时通过（残留 verified = 集成没做完的机器证据）。
- 不要把 export 目标放行到 gitignore 域（归档的意义就是入库可追溯）。
