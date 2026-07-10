# FEAT-008 — 项目知识

## 决策记录

- audit 的"跳过登记制"：规则未落地必须出现在 rules_skipped 带原因——覆盖率是可见事实而非暗默；AUD-032 的 rev_after 实现债由此浮出并入账。
- repair 计划先行（dry plan → 空则直接返回）：备份只在确有修复时产生，幂等性免费获得。
- meta 计数器必须**先于** state_repaired 事件修复（否则 appendEvent 用旧 next_seq 造出重号——修复器自己制造 AUD-033）。
- 查询命令的"空态是答案"：evidence 缺失 → ok+null，而非 not_found（错误码留给"目标不存在"）。

## 经验教训

- **写入即时性**：sweep 在共享内存结构上做的变更，必须在同一守卫链可能提前 return 的每条路径前落盘——"稍后统一保存"在多出口函数里就是半提交隐患（FEAT-004 sweep 教训）。
- 豁免/例外的权威文件要跟规则合同走（15 §5.1 blocked 豁免读 task.json，不读 list 行）。

## 可复用模式

- 规则注册表 {id, check(ctx)} + ctx 缓存读——FEAT-009/010 的规则批直接往 RULES 里加。
- persistSweep（保存后手动步进内存 rev）——同锁内多段写的通用技法。

## 应避免的做法

- 不要让 audit 拿锁（无锁快照 + concurrent_writes_detected 才是合同）；
- 不要在 repair 里"顺手"修账本本身（events 是唯一不可修的东西——它是证据）。
