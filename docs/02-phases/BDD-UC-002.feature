# BDD for UC-002 发布任务队列（源：15 §6、16 §5、D18）
Feature: 发布任务队列
  作为项目负责人
  我想在审阅后放行任务队列
  以便控制 agent 何时可以开工

  Background:
    Given "RUN-0001" 处于 "planned" 且含 3 个 "draft" 任务

  # BDD-002-01 主流程
  Scenario: 全量发布并激活 run
    When 用户执行 "/team-publish RUN-0001"
    Then 3 个任务状态应变为 "ready"
    And run 状态应变为 "active"
    And events 应含 3 条 "task_published" 与 1 条 "run_activated"

  # BDD-002-02 发布前不可领取
  Scenario: draft 任务领不出来
    When 任一 agent 在发布前执行 claim
    Then 返回 code 应为 "run_not_active"
    And 不应产生任何 claim 记录

  # BDD-002-03 扩展 3a：跨 run 重叠（默认 warn，D7/D18）
  Scenario: 与另一 active run 路径重叠时警告
    Given "RUN-0002" 处于 active 且其任务 paths.allow 含 "src/auth/**"
    And "RUN-0001" 的任务 paths.allow 也含 "src/auth/**"
    When 用户发布 "RUN-0001"
    Then 发布应成功但 warnings 含跨 run 重叠清单
    And events 应含 "cross_run_overlap_detected"

  # BDD-002-04 扩展 3a：block 策略硬拦（D18）
  Scenario: cross_run_path_policy 为 block 时发布被拒
    Given "RUN-0001" 的 policy.cross_run_path_policy 为 "block"
    And 与 active 的 "RUN-0002" 存在 paths 交集
    When 用户发布 "RUN-0001"
    Then 返回 code 应为 "cross_run_conflict"
    And next_actions 应包含改 paths 或 "--force" 两条出路
