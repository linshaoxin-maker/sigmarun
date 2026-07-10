# FEAT-005 — 项目知识

## 决策记录

- 开放问题不落盘、纯派生（M23）：question 减去被 answer.in_reply_to 命中的集合，list 与 hydrate 共用一个纯函数——单一事实源是 messages.jsonl。
- hydrate 是"读 + 单事件"：唯一写入是 context_hydrated（AUD-028 对账锚），组包本身零副作用。
- L4 记忆入 pack 走 project.json 的 project_memory_path 指针而非硬编码路径——改指针即换记忆位置。

## 经验教训

- **以实写为准，不以记忆为准**：task-graph 边字段是 `kind`，初稿按文档草案记忆写成 `type`，RED 后 grep run-import 修正。跨包消费一个文件格式前，先读生产方代码。

## 可复用模式

- 追加型 jsonl + 计数器分配（MSG 同 EVENT）：锁内取号、appendFileSync、计数器原子写回。
- "warn-only 先行、拒收后至"的安全分级：消息体 warn（不阻塞协作）、记忆拒收（进入事实源前拦截）。

## 应避免的做法

- 不要给消息写审计事件（INV-011）；需要审计痕迹的动作走带 message_ref 的状态事件。
- 不要在 hydrate 中做语义压缩/摘要——gateway 只做机械组包（13 §5.1 裁决）。
