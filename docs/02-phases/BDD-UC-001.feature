# BDD for UC-001 规划一个 Run（源：09 §8/§11、13 D17、24 §4.1）
Feature: 规划一个 Run
  作为项目负责人
  我想让 planning agent 把目标拆成带验收标准的任务队列
  以便多窗口并行开工

  Background:
    Given 项目已执行 "sigmarun init" 且 doctor 全绿

  # BDD-001-01 主流程
  Scenario: 合法 payload 导入成功
    When 用户发起 "/team-plan 实现 auth phase 1"
    And planning agent 提交含 2 个任务、各带 acceptance 与 paths 的 payload
    Then 系统应返回 "RUN-0001" 与 task_id 映射表
    And ".team/runs/RUN-0001/team-task-list.json" 应存在且任务状态为 "draft"
    And events 中应有 "run_created" 与 2 条 "task_created"

  # BDD-001-02 扩展 3a：payload 违规
  Scenario: 任务缺 acceptance 被逐条拒绝
    When planning agent 提交的 payload 中任务 "auth-domain" 缺少 acceptance
    Then 导入应失败且 code 为 "schema_invalid"
    And data 中应指明 "auth-domain" 缺 "acceptance"
    And ".team/runs/" 下不应产生任何新目录

  # BDD-001-03 扩展 3a：伪造运行态字段
  Scenario: payload 携带 owner_agent_id 被拒
    When payload 的任务含字段 "owner_agent_id"
    Then 导入应失败且错误指明该字段仅能由 claim-next 写入

  # BDD-001-04 扩展 3b：计划指纹防重（D17）
  Scenario: 重复导入同一份计划被拦
    Given "RUN-0001" 已由内容哈希为 H 的 payload 创建
    When planning agent 再次导入内容哈希同为 H 的 payload
    Then 导入应被拒绝且提示 "already imported as RUN-0001"
    And 使用 "--force" 重试才允许创建新 run

  # BDD-001-05 扩展 3c：目标含 secret
  Scenario: 目标文本命中 secret 模式仅警告
    When 用户目标文本包含 "password=hunter2"
    Then 导入应成功但 warnings 含 secret 提示
    And 提示建议用户改写后重新导入
