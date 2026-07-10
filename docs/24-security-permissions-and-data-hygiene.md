# 24. Security, Permissions, and Data Hygiene

> 日期：2026-07-09
> 状态：v0.1 设计草案
> 依据：产品负责人 2026-07-09 明确要求（安全/权限/越权写 `.team`/secret redaction/日志脱敏）；[13](13-design-audit-and-next-breakdown.md) M27（信任模型未声明）、附录 B F3；[14](14-evidence-review-verification-contract.md) §2.2（D8 原始输出落盘是 secret 的主要入口）
> 目标：声明 MVP 信任模型与权限边界，定义 secret redaction 管道与日志脱敏规则，把"越权写 `.team`"从模糊担忧变成可检测事件。**本文档是 [18](18-audit-rule-catalog-and-trust-model.md) 信任模型小节的全文。**

---

## 1. 信任模型声明（M27 闭合）

### 1.1 MVP 信任假设

```text
参与者假设：合作式（cooperative）
  - coding agent 会犯错、会遗忘、会幻觉，但不主动作恶
  - 操作 repo 的人拥有 repo 的全部权限（.team/ 只是普通文件）
执行环境假设：单机、单用户账户、本地文件系统
```

### 1.2 三层防御与各自的诚实边界

| 层 | 手段 | 能防什么 | 防不了什么 |
|---|---|---|---|
| 约定层 | skill/slash 模板固定流程、AGENTS.md 规则 | agent 无意的乱序、跳步 | agent 忽略提示词 |
| 接口层 | gateway 校验（schema、状态机、身份、in_scope、rev） | 经 CLI 的非法操作 | **绕过 CLI 直接改文件** |
| 审计层 | rev/seq/一致性矩阵/事件链检查 | 事后检出绕过与篡改痕迹 | 完美伪造（连 rev/seq/事件一起改） |

**明确不承诺**（写进 README 边界）：拜占庭容错、恶意人类防护、密码学完整性。事实链的最终强度 = 文件系统权限 + git 历史（export 后）。Phase 3 可选增强：events 哈希链、记录签名、独立 runner 复核 evidence——在 [13](13-design-audit-and-next-breakdown.md) P2 已登记。

### 1.3 为什么 MVP 不做强制层

`.team/` 在用户自己的 repo 里，任何能跑 agent 的进程都有文件写权限——OS 层面不存在"gateway 才能写"的隔离手段（除非引入独立服务账户/daemon，与 D14 冲突且收益存疑）。因此 MVP 的正确姿势是**让绕过变得可检测且无利可图**（§3），而不是假装能阻止。

### 1.4 STRIDE 威胁表（2026-07-10 补齐，关闭 G3-14）

单机单用户信任域（ASM-002）下逐维声明——覆盖手段、残余风险、接受理由三列缺一不可：

| 维度 | 威胁场景 | 覆盖手段 | 残余与裁决 |
|---|---|---|---|
| **S**poofing | 冒用他人 AGENT-ID / label 领任务、交证据 | label 为约定级身份（D17 幂等注册）；同机进程本就同权 | **接受**：单机信任域内身份伪造 = 自己骗自己；跨机身份属 Phase 3 |
| **T**ampering | 绕过 CLI 直改 claims/状态/账本 | `rev` 乐观锁 + `seq` 连续性 + 一致性矩阵 + mtime 弱信号（§3）；L4 记忆经 git review | **检出而非阻止**（§1.3 既定姿势）；`team repair` 可恢复 |
| **R**epudiation | 事后否认"谁在何时做了什么" | events append-only（seq + actor + rev_after 对账）；export 归档进 git 二次固化 | 低：删账本本身即为强证据（seq 断号，AUD） |
| **I**nfo Disclosure | secret 经 checks 输出落盘 / 经 export 入库 / 经 envelope 回显；上游文本注入诱导外泄 | redaction 管道（§4，8 类模式）+ export 阻断式二次扫描 + envelope 不回显内容（§5）+ 注入硬化（19 RULES 3） | 正则是 best-effort（§4.3 已声明）；纵深=项目自配 gitleaks 类 checks |
| **D**oS | 恶意/失控进程囤锁、刷任务、撑爆账本 | 锁 5s 超时 + stale takeover（17 §4）；per-agent claim 上限（M36）；包络警告（M39）；watch 单实例锁 | **部分接受**：本地工具，DoS 即自伤；无速率限制（明示不做） |
| **E**oP | 实现者自批、planner 伪造运行态、adapter 越权写 | INV-007/008 原语内阻断（P0-inline）；payload 禁写字段表（09 §9）；权限矩阵（§2）+ RULE 4 不变量条款（19） | 约定+检出双层；无 OS 级强制（§1.3） |

结论：T/R/I/E 四维有主动防线，S/D 两维在单机信任域内**显式接受**并写明边界——与 §1.2"诚实边界"表一致。跨机/多用户场景触发时本表全表重评（Phase 3）。

---

## 2. 权限边界矩阵

"谁可以经 gateway 做什么"。执行者身份 = `agent register` 登记的 AGENT-ID + role；user 身份 = 无 agent 上下文的直接 CLI 调用（MVP 以此区分，诚实标注：**这是约定级身份，不是认证**）。

| 操作 | planner | implementer | reviewer | integrator | user | watch/dashboard |
|---|---|---|---|---|---|---|
| run import / publish / pause / cancel | import✓ | — | — | — | ✓ | — |
| claim-next / release / heartbeat | — | ✓ | ✓(review claim) | ✓ | — | — |
| submit（本人 task） | — | ✓ | — | — | — | — |
| review approve/request-changes | — | **✗ 本人历任 task**（INV-008） | ✓ | ✓ | ✓ | — |
| verify 记录 | — | — | ✓ | ✓ | ✓ | — |
| approve-paths | — | ✗（可请求） | — | ✓ | ✓ | — |
| reclaim / unblock 他人 task | — | — | — | ✓ | ✓ | watch：sweep 自动回收 ✓（D9 规则内）；dashboard：✗ |
| 改他人 evidence / review 记录 | ✗ | ✗ | ✗ | ✗ | ✗（只能追加新记录） | — |
| 直接编辑 claims/*、counters、events | ✗ 全员经 CLI 禁止；文件层无法阻止 → §3 检测 | | | | | ✗ |
| export | — | — | — | ✓ | ✓ | — |

裁决原则：**记录永远只追加不覆盖**（review 多轮、evidence revision 归档、events append-only）；"修正"表达为新记录引用旧记录，不表达为改写。

注：watch 与 dashboard 的写权并不相同——watch 拥有且仅拥有"sweep 触发的合法回收"这一种写（D9/D14），dashboard 零写路径（[23](23-dashboard-information-architecture.md) §7 的 N1–N8 清单）。

---

## 3. 越权写 `.team/` 的检测（"防不了就要看得见"）

| 信号 | 机制 | 检出的绕过行为 |
|---|---|---|
| `rev` 跳变/倒退 | [17](17-cli-mcp-contract-and-error-model.md) §5.2：正常写严格 +1 | 直改 mutable JSON |
| `events.jsonl` seq 断号/时间倒流 | 行内 seq + 计数器 | 删改审计账本 |
| 状态-事件失配 | [18](18-audit-rule-catalog-and-trust-model.md) event-gap 规则：状态变化无对应事件 | 只改状态不补事件 |
| task×claim 一致性矩阵违例 | [15](15-run-task-state-machine-and-lifecycle.md) §4.3 | 手工"完成"任务 |
| 文件 mtime 晚于最后事件 ts 且无对应写命令 | audit 弱信号（warn） | 任何直改 |
| worktree diff 与 evidence.changed_files 不符 | submit 时机械比对 git（[16](16-git-worktree-and-team-root.md) §3.4） | 谎报改动范围 |

对应 audit 规则（编号归 18 号）：`direct_state_edit_suspected`（error）、`event_gap`（warn/error）、`seq_discontinuity`（error）。adapter 模板中保留一贯禁令："Never edit `.team/runs/*/claims/*.json` directly"（[07](07-skill-plugin-execution-form.md) 已有，维持）。

---

## 4. Secret Redaction 管道（用户点名的 P0）

### 4.1 入口盘点：secret 从哪进 `.team/`

| 入口 | 风险 | 处理点 |
|---|---|---|
| **命令原始输出**（D8 required_checks 必附） | **最高**：测试/构建日志常打印 env、连接串、token | submit 落盘前（§4.2 管道） |
| evidence/message/handoff 的自由文本 | agent 复述配置时带出密钥 | 同上管道，全文扫描 |
| plan payload 的 context/prompt | 用户目标里粘贴了凭据 | import 时扫描（warn，不改写用户原文——提示用户重写） |
| `team export` 导出物 | 进入 git，**不可撤回** | 导出前二次全量扫描，命中即中止（[16](16-git-worktree-and-team-root.md) §7） |
| envelope 错误信息 | 回显文件内容会把 secret 带进 agent 会话与终端日志 | [17](17-cli-mcp-contract-and-error-model.md) §2.1 规则 6：永不回显内容 |

### 4.2 管道规则

```text
写入路径：agent 提交内容 -> gateway redact(content) -> 截断 -> 落盘
扫描时机：submit / message post / memory update / verify / import(warn-only) / export(阻断式)
替换格式：[REDACTED:<kind>]，并在文件头部 metadata 记 redaction_count
```

内置模式表（`team.redaction.v1`，正则实现，MVP 集合）：

| kind | 模式特征 |
|---|---|
| `aws_key` | `AKIA[0-9A-Z]{16}`；`aws_secret_access_key\s*[=:]` 后值 |
| `private_key` | `-----BEGIN (RSA\|EC\|OPENSSH\|PGP) PRIVATE KEY-----` 块整段 |
| `jwt` | `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+` |
| `github_token` | `gh[pousr]_[A-Za-z0-9]{36,}` |
| `npm_token` | `npm_[A-Za-z0-9]{36}` |
| `generic_bearer` | `[Bb]earer\s+[A-Za-z0-9._-]{16,}` |
| `env_assignment` | `(?i)(password\|passwd\|secret\|token\|api_?key)\s*[=:]\s*\S+`（值部分替换） |
| `connection_string` | `\w+://[^:\s]+:[^@\s]+@`（凭据段替换） |

扩展与豁免：项目级 `\.team/redaction.json` 可追加自定义模式与 allowlist（如测试用假 token 前缀）；allowlist 命中记 warning 便于复查。

### 4.3 诚实边界与纵深

1. **正则是 best-effort**：高熵字符串启发式（P1）、语义识别（永不做，gateway 无 LLM）都有漏网。残余风险声明进 README。
2. 纵深建议：把 `gitleaks`/`trufflehog` 这类扫描器列为 run 的 required_check 之一（由 agent 执行、gateway 记录——不新增 gateway 能力）；export 目标目录建议纳入项目 CI 的 secret 扫描。
3. **redaction 不可逆**：原文不留副本（否则脱敏无意义）。若脱敏破坏了证据可读性，owner 在 evidence 的 risks 里说明并改用安全的复现方式。

---

## 5. 日志与输出脱敏

| 输出面 | 规则 |
|---|---|
| envelope `message`/`data` | 只含 ID、枚举、路径、计数；**禁止**嵌入文件内容片段（17 §2.1 规则 6） |
| stderr 诊断 | 同 redaction 管道过滤后输出 |
| `team watch` 控制台/NDJSON | 事件摘要仅 ID 与枚举；message body 不进 watch 输出（要看去 dashboard/`message list`，两者读的是已脱敏的落盘内容） |
| events.jsonl payload | 结构性字段（ID、状态、计数），**自由文本一律不进 events**——这同时是 INV-011（events≠messages）的安全面理由 |
| MCP tool result | 与 CLI envelope 同源同规则（17 §9） |

---

## 6. 路径与文件系统安全

作为安全控制重申并加严 [10](10-claim-next-lock-and-conflict-rules.md) §8.1 的规范化规则：

1. 所有 payload/claim/approval 中的路径：repo-relative、POSIX 分隔、禁 `..`、禁绝对路径；规范化后再比对。
2. **symlink 逃逸检查**：evidence 的 changed_files、export 的收集范围，先 realpath 再校验仍在 repo/worktree 根内；越界 → error。
3. worktree 路径必须位于 `worktree_root` 下；`team worktree register` 拒绝任意路径注册。
4. export 目标（16 §7）：repo 内、非 ignored、非 `.team/` 内、realpath 校验。
5. redaction/审计等 gateway 自身配置文件同样带 `rev`，防静默篡改降级防线。

---

## 7. 隐私与数据卫生

| 事项 | 规则 |
|---|---|
| `.team/` 内容敏感性 | 含用户目标原文（source_prompt）、计划、代码路径——D4 已保证不入 git；文档提醒：备份/同步工具（云盘）会带走它 |
| export 审阅 | 导出即"发布"：打印完整文件清单 + redaction 扫描报告，用户确认后才写入（16 §7 已定，此处补：`--yes` 跳过确认仅限 CI） |
| 保留与清理 | run archive 时提示可删的运行态文件；`team run purge <RUN>`（P1）整体删除 run 目录（终态才允许，需确认，写 `run_purged` 事件到 project 级日志） |
| agent 会话信息 | agents/*.json 只存 tool、role、时间戳，**不存** API key、账户名、机器指纹 |

---

## 8. MVP 验收场景

| 场景 | 预期 |
|---|---|
| 测试日志含 `AKIA` 开头 20 位串 | 落盘 outputs 中为 `[REDACTED:aws_key]`，evidence 头部 redaction_count ≥1 |
| message 正文粘贴了 `-----BEGIN RSA PRIVATE KEY-----` 块 | 整块替换，message 可正常入池 |
| export 内容命中任一模式 | 导出中止，列出文件与行号（`export_redaction_hit`，exit 6） |
| 手动编辑 task-claims.json 后跑任意写命令 | `rev_conflict`；`team audit claims` 报 `direct_state_edit_suspected` |
| 删除 events.jsonl 中间一行 | audit 报 `seq_discontinuity`（error） |
| payload 的 context 含 `password=...` | import 成功但返回 warning，提示改写后重新 import |
| evidence 的 changed_files 少报一个已改文件 | submit 时与 git diff 机械比对拒绝（`evidence_invalid`） |
| implementer 请求 approve-paths | 返回"已记录请求，需 user/integrator 批准"，不直接生效 |

---

## 9. 对现有文档的修订指令

| 文档 | 修订 |
|---|---|
| README | 边界节新增："安全 = 合作式信任 + 事后审计，非拜占庭防御"；Out of Scope 补密码学完整性（Phase 3） |
| [09](09-team-run-import-payload-schema.md) | §8.2 警告表增加"payload 文本命中 secret 模式" |
| [14](14-evidence-review-verification-contract.md) | §2.2 脱敏行引用本文 §4.2 管道（已预留） |
| [16](16-git-worktree-and-team-root.md) | §7 二次扫描引用 §4.2 模式表（已预留）；export 增加 `--yes` 限 CI 注记 |
| [17](17-cli-mcp-contract-and-error-model.md) | reason code 表补 `export_redaction_hit` 已有、增 `path_escape_detected`；§2.1 规则 6 引用本文 §5 |
| [18](18-audit-rule-catalog-and-trust-model.md) | 信任模型小节指向本文；新增规则：direct_state_edit_suspected、seq_discontinuity、secret_leak_suspected、path_escape_detected |

---

## 10. 遗留到其他文档的接口

- 高熵启发式扫描（P1）、events 哈希链 / 记录签名 / 独立 runner（Phase 3）→ 13 号 P1/P2 清单已登记
- redaction 模式表的实现与测试夹具 → 实现仓库
- 插件分发的供应链完整性（npm provenance、lockfile 策略）→ 22 号 packaging
- dashboard 展示已脱敏内容的边界说明 → [23](23-dashboard-information-architecture.md)
