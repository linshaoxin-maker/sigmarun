# FEAT-004 — 项目知识

## 决策记录

- **sweep 前置于 agent 上限守卫**：死租约若排在上限检查之后，持死锁 agent 的窗口重启后会被自己的尸体挡住（agent_claim_limit）——先扫尸再计数。
- 3×TTL 判定式取 `lease_until + (multiple−1)×TTL`：以"距 acquire 3×TTL（无心跳时）"为语义锚，心跳续租自然顺延。
- release 与 reclaim 共用一个状态翻转函数（applyReclaim），terminal status（released/reclaimed）与事件名由调用方注入——三种回收路径（owner 释放/手动/sweep）一处维护。
- 定向 claim（--task）返回具体守卫码，非定向返回 no_claimable_task + excluded 明细：agent 拿到的永远是"可行动的失败"。

## 经验教训

- zsh 下 `$BIN` 含空格不会分词：冒烟脚本用 shell 函数包 node 调用，不用字符串变量。
- noUncheckedIndexedAccess 下 `sorted[0]` 是 `T | undefined`：排序后取首元素要显式判空，即便逻辑上非空。

## 可复用模式

- **withRunLock(opts, startedAt, body)**：openRun→acquireLock→try/catch(GatewayError→envelope)/finally(release) 的事务包装器——后续 submit/review/verify 全部套用。
- **readOrDefault + saveState(rev|null)**：惰性建档文件（claims/approvals）的统一读写对，首写 writeJsonStateNew、后续乐观锁。

## 应避免的做法

- 不要在读取其他 task 的守卫检查里写任何文件（守卫段零副作用，sweep 是唯一例外且有事件留痕）。
- 不要让 heartbeat 失败静默：非 owner 心跳是身份错乱信号，必须结构化拒绝（not_claim_owner）。
