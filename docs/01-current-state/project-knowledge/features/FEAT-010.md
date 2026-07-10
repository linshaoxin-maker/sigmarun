# FEAT-010 经验卡片（verify + integrate + export）

- **一句话**：MVP 主链收官——VERIFY 记录（D11 结构校验、verdict⇔gate）、拓扑序集成记账（gateway 不碰 git、--failed 自动最小记录保事件合同、path claim hold 终点释放）、阻断式脱敏 export（唯一出 git 口）；172/172、89.7%/73.5%；北极星全链真机走通。
- **可复用**：mapTaskToRework 三失败路径共用；阻断式扫描（全收集→全扫→全写或全不写）；driveToVerified 状态链助手。
- **坑**：事件必带字段倒逼记录不可选；BDD 与上游规则相撞时先找上游既写的放宽档（deps_satisfied_when）。
- **证据**：docs/05-features/FEAT-010/verification.md；`Refs: FEAT-010`。
