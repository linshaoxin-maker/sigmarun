# FEAT-007 自检报告

## 契约符合性

| 契约 | 实现 | 偏离 |
|---|---|---|
| 14 §2.1 schema 字段规则表 | validate 清单逐条（summary/changed_files/checks 覆盖+skipped note+输出存在/acceptance 逐条/handoff/context_ack） | context_ack "有上游时必填" 收敛为对账警告（AUD-028 本就是 warn 级；硬拒会卡住无 hydrate 记录的手工流） |
| 14 §2.2 D8 输出 | 首 50+末 200、256KB、`[REDACTED:kind]`、required check 输出必存 | 无 |
| 14 §2.3 九步事务 | 状态门→校验先行→in_scope 重算→落盘→翻转→D6→事件提交点；失败零变更 + #28 | 步序 4/5 合并实现（同锁内），语义一致 |
| 15 §4.2 path claim hold | submit 后 path claim 保持 active | 无 |
| in_scope 重算 | minimatch(dot)（agent 自报 flag 丢弃） | 冲突判定（glob-vs-glob）仍保守前缀法——本 FEAT 升级的是文件级（AUD-014 口径），mvp-scope 界定清楚 |
| 24 §4 脱敏 | outputs+summary+handoff 替换管道；msg 体 warn 档（FEAT-005 既有） | events/messages 历史行不回溯清洗（append-only；审计面随 FEAT-008） |

## 测试 / 质量

- 131/131（新增 14）；覆盖 92.31%/77.97%；RED 14 先行；真机冒烟（redaction 落盘 grep 验证）。
- submit.ts ≈ 330 行单事务函数 ≈ 240 行——线性校验清单+写序风格，沿用 importRun/claimNext 豁免口径；TODO 0。
- **缺陷修复（G5-4 注记）**：`default_policy` 字段名错读——集成新消费方（submit 读 require_review）时暴露；教训入 knowledge。

## 安全

- 脱敏管道本体交付：正则替换 `[REDACTED:kind]`，密文不再以任何形式进入 .team 持久面（outputs/summary/handoff 三落点用例锁定）。
- envelope 不回显 evidence 正文，只报计数与路径。
