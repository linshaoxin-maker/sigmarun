# Glossary — sigmarun

> 2026-07-10 建立（关闭 G0-5）。权威定义在语料库，此处一行速查；ID 格式正则见 [../17 §6](../17-cli-mcp-contract-and-error-model.md)。

| 术语 | 一行定义 | 权威 |
|---|---|---|
| Run / `RUN-ID` | 一次项目级协作运行，跨工具协作入口 | 02 §5、15 §2 |
| Task / `TASK-ID` | 可认领、可执行、可评审的工作单元（run-scoped，命令一律双参） | 03 |
| Agent / `AGENT-ID` | 一个工具会话身份；`--as <窗口名>` 经 label 幂等注册 | 02 §7、D17 |
| Claim / lease | agent 对 task 的租约（默认 30min，捎带续租） | 10 |
| Path claim | task 对文件范围的占用声明（minimatch 语义） | 10 §8 |
| Review claim | reviewer 对 submitted 任务的短租约 | 14 §3.1 |
| Gateway | 无智能的确定性原语层（CLI/MCP/watch 三前端同核） | 08、20 |
| `.team/` | repo-local 事实源目录（gitignore，git common-dir 解析） | 02、16、D4 |
| Worktree | 任务隔离执行目录（仓外 `../.team-worktrees/`） | 16 §3 |
| Evidence | 完成的结构化证明（json+md+outputs，无 submit 即无完成） | 14 §2 |
| Hydrate / context pack | 领取后注入的上游 handoff/决策/风险必读集 | 12 §8 |
| Message pool | run 内 typed 协作消息（≠ events 审计账本） | 12 §6、INV-011 |
| Events / seq | append-only 审计账本；追加即事务提交点 | 02 §8、17 §5.3 |
| `rev` | 可变状态文件的乐观锁版本号（防绕过检出） | 17 §5.2 |
| Sweep | 写原语/watch 顺带执行的过期租约处理 | 15 §5.1 |
| Stale / reclaim | 租约过期的派生标注 / 回收（3×TTL 自动，带 previous_attempts） | 15 §5、D9 |
| Needs user | status 中"等人处理"清单（批准/提问/停等/回收确认） | 08 §6.1、M32 |
| Envelope | 全命令统一 JSON 返回（ok/code/data/next_actions，英文，D16） | 17 §2 |
| Review gate | submitted→approved 的强制评审关（自批永禁；policy 可关留痕） | 15 §9、D6 |
| Verification | checks 由 agent 执行、gateway 记录的验证记录 | 14 §4、D11 |
| Integrate / export | DAG 拓扑序合并出集成分支 / 脱敏留档导出 | 16 §4/§7 |
| Watch | 用户手启的常驻只读巡检器（30s，唯一合法写=sweep 回收） | 17 §7、D14 |
| Project memory (L4) | git-tracked 跨 run 决策库（`docs/team/MEMORY.md`，MEM-ID） | 25、D19 |
| `MEM-ID` / promote | 项目记忆条目 / 经人确认的机械晋升 | 25 §4 |
| AUD-xxx | 审计规则编号（P0-inline 五条在原语内阻断） | 18 §4 |
| INV-xxx | 领域不变量（如 INV-007 实现者不能自标 done） | 11 §3.3 |
| D1–D19 | 产品决策账本 | 13 §2.1 |
| FEAT-xxx | 交付单元（P4） | 02-phases/P4-feature.md |
