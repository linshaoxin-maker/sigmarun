# BDD for UC-003 领取并执行（源：10、15 §7/§8、17 §3、19 §3.2、D5/D17、F-c）
Feature: 领取并执行任务
  作为项目负责人
  我想让多个窗口并发领任务而互不踩脚
  以便安全地并行推进

  Background:
    Given "RUN-0001" 处于 active 且有 2 个无依赖的 ready 任务
    And 窗口以 "--as 左窗" 注册为 "AGENT-codex-001"

  # BDD-003-01 主流程
  Scenario: 领取成功并注入上下文
    When "左窗" 执行 dispatch
    Then 应领到唯一 "TASK-ID" 且租约 30 分钟
    And hydrate 返回的 must_read 应含该任务的 task.md 与 run-memory
    And 任务状态应为 "working" 且 events 含 "task_claimed" "context_hydrated"

  # BDD-003-02 并发互斥（NFR-001）
  Scenario: 两窗口并发只有一个拿到同一任务
    Given 仅剩 1 个 ready 任务
    When "左窗" 与 "右窗" 同时执行 claim
    Then 恰有一个窗口领到该任务
    And 另一窗口收到 code "no_claimable_task"

  # BDD-003-03 路径冲突阻断
  Scenario: paths 重叠的任务领不出
    Given "TASK-0001" 已被领且 path claim 为 "src/auth/**"
    And "TASK-0002" 的 paths.allow 为 "src/auth/session/**"
    When "右窗" 执行 claim
    Then 返回 code 应为 "path_conflict"
    And data.blocked_by 应指明 "TASK-0001" 与其 agent

  # BDD-003-04 同窗口上限（M36/D17）
  Scenario: 已持任务的窗口不能再领
    Given "左窗" 已持有 active claim
    When "左窗" 再次执行 claim
    Then 返回 code 应为 "agent_claim_limit"
    And next_actions 应提示先 submit 或 release

  # BDD-003-05 label 幂等（D17）
  Scenario: 同名窗口重复 dispatch 不产生新身份
    When "左窗" 再次以 "--as 左窗" 注册
    Then 返回的 AGENT-ID 应与首次一致
    And agents 目录不应新增文件

  # BDD-003-06 扩展 5a：沙箱拒建 worktree（F-c）
  Scenario: worktree 创建被环境拒绝时诚实停报
    Given 执行环境对 ".git" 只读
    When agent 尝试创建建议的 worktree 失败
    Then agent 应停止并报告阻塞与人工路径
    And 不应改动 ".team/" 下任何文件（哈希不变）

  # BDD-003-07 干完即停（D5）
  Scenario: 未加 --loop 时完成一个任务即停止
    Given "左窗" 完成任务并 submit 成功
    Then agent 应输出含 TASK-ID 的汇报并等待用户
    And 不应自动发起下一次 claim

  # BDD-003-08 requires_approval 路径在 claim 阶段被拦（14 §5、BR-001 行 8）
  Scenario: 触碰需批准路径且无批准记录时领取被拒
    Given "TASK-0006" 的 paths.requires_approval 含 "src/users/**" 且无有效批准记录
    When "左窗" 点名领取 "TASK-0006"
    Then 返回 code 应为 "requires_approval"
    And next_actions 应含可复制的 "team approve-paths" 命令模板
    And 不应产生任何 claim 记录
