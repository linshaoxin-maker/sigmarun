# FEAT-007 经验卡片（evidence 门禁 submit）

- **一句话**：F1 正面锚落地——submit 九步事务（校验先行零残留、in_scope minimatch 重算、D8 截断+`[REDACTED:kind]` 脱敏、handoff 代写、revision/history、D6 skip trace）；131/131、92.3%/78.0%。
- **可复用**：truncate+redact 管道件；emitInvalid（失败事件+错误清单）闭包；"可机械重算的自报字段一律重算"。
- **坑**：**兜底逻辑会掩盖读错的键**——`(undefined ?? 默认)` 让 `policy` vs `default_policy` 错读静默存活三个 FEAT；跨文件消费前 grep 生产方。
- **证据**：docs/05-features/FEAT-007/verification.md；`Refs: FEAT-007`。
