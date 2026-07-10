# FEAT-008 经验卡片（status/watch/audit/repair）

- **一句话**：watch+audit 两包落地——权重 progress+Needs-user（M32）、watch 单实例 tick（sweep 同段代码）、audit 14 规则+26 登记跳过（exit 0、findings=data、抓到真实历史越界）、repair（备份/账本前滚/幂等）；149/149、90.8%/75.1%。
- **可复用**：规则注册表+ctx 缓存；persistSweep 同锁多段写技法；"空态是答案"查询语义。
- **坑**：多出口函数里"稍后统一保存"=半提交隐患；meta 计数器要先于修复事件写；豁免权威跟规则合同（task.json 非 list 行）。
- **证据**：docs/05-features/FEAT-008/verification.md；`Refs: FEAT-008`。
