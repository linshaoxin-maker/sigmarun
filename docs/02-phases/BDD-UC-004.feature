# BDD for UC-004 定向派活（源：D17、10 §2.1、15 §7）
Feature: 定向派活
  作为项目负责人
  我想点名某个窗口去做某个任务
  以便按我的判断分工

  Background:
    Given "RUN-0001" active，"TASK-0003" 为 ready
    And 窗口已以 "--as 左窗" 注册

  # BDD-004-01 主流程
  Scenario: 点名领取成功
    When 用户执行 "/team-dispatch RUN-0001 --as 左窗 --task TASK-0003"
    Then "左窗" 应领到 "TASK-0003"（而非其他任务）

  # BDD-004-02 扩展 2a：目标被占
  Scenario: 点名已被占的任务时报因停止
    Given "TASK-0003" 已被 "右窗" 领取
    When 用户点名 "左窗" 领 "TASK-0003"
    Then 返回 code 应为 "task_already_claimed"
    And "左窗" 不得改领其他任务（无新 claim 产生）

  # BDD-004-03 扩展 2a：依赖未满足
  Scenario: 点名依赖未完成的任务
    Given "TASK-0004" depends_on "TASK-0001" 且后者未 done
    When 用户点名领 "TASK-0004"
    Then 返回 code 应为 "deps_blocked"
    And data 应指明阻塞它的 "TASK-0001"
