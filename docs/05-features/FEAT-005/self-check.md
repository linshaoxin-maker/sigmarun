# FEAT-005 自检报告

## 契约符合性

| 契约 | 实现 | 偏离 |
|---|---|---|
| 12 §6 消息 schema（十类 type、to 路由、in_reply_to、refs、status） | postMessage/MESSAGE_TYPES | status 简化：question/blocker→open、其余→resolved（追加式池内 status 不回写，开放性由派生判定——M23 一致） |
| INV-011 消息不镜像 events | 无 appendEvent 调用 + 显式测试 | 无 |
| 12 §8 hydrate pack | must_read（brief→run-memory→L4→上游 handoff/evidence）+ messages/open_questions/risks/previous_attempts | pack 字段挂 envelope.data（同 FEAT-004 先例） |
| 18 #39 context_hydrated | actor=agent（--agent）/user，payload.must_read | 无 |
| D19 读路径 | project.json 的 project_memory_path 指针，存在才入 must_read | 无 |
| AUD-021/022 | validateGraph：blocks 环 DFS + 悬空边/目录缺失 | 只读体检不写事件（audit 事件面随 FEAT-008） |
| 12 §7 / BR-005 精神 | memory update：secret 拒收、无 Source: 警告、tmp+rename | refs 硬校验留 FEAT-011（书面） |

## 测试 / 质量

- 103/103（新增 18）；覆盖 92.62%/79.51%；RED 17 先行；真机冒烟六命令。
- context-plane.ts ≈ 370 行、最大函数 hydrateContext ≈ 90 行——均在既有豁免口径内；TODO 0。
- 实现期修正：task-graph 边字段为 `kind`（run-import 实写），初稿误用 `type`——测试先失败后修正，无合同影响。

## 安全

- memory 拒收 secret（写前扫描，旧文件保全）；msg 体 warn-only（升级路径书面归 FEAT-007）；envelope 不回显文件内容。
