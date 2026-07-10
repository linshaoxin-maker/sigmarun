# FEAT-009 — 项目知识

## 决策记录

- 显式领审与 D15 合成共用 grantReviewClaim：两条入口一个守卫面，防止合成路径漏检 INV-008。
- 镜像消息**先写**（取 MSG id）再写 REVIEW 记录：message_ref 回链要求消息先存在——同锁内两段写，次序即合同。
- writeJsonStateNew 落 REVIEW 记录：文件已存在即抛错——"每轮新文件永不覆盖"（M8）由存储原语机械保证而非纪律。
- 守卫排序原则：**由后果查因果**——reviewing 态是 review claim 的后果，重复领审者应得 task_already_claimed；状态门只拦"真的不在可审状态"。

## 经验教训

- 跨包留口要当期登记（FEAT-007 的 skip 记录留口在本 FEAT 闭合——mvp-scope 里"留待"条目是唯一防遗忘机制，验证报告残余表必须逐条销账）。

## 可复用模式

- historicalOwners（claims 全史 ∪ previous_attempts）——INV-008 的单一事实函数，verify gate（FEAT-010）直接复用。
- "复活而非新建"的 claim 语义：状态翻转+续租，id/attempt 不变——审计链天然连续。

## 应避免的做法

- 不要在 skip 路径造 review claim（没有 reviewer 就没有自批面；skip 记录 reviewer_agent_id=null）。
- 不要让合成工作项进 team-task-list（"谁在等审"是派生事实，写进去就要维护两份真相）。
