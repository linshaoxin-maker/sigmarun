# BDD for UC-008 集成与留档（源：16 §4/§7、24 §4）
Feature: 集成与留档
  作为项目负责人
  我想把通过的任务合成一个分支并留下脱敏档案
  以便走正常 PR 流程且可复盘

  Background:
    Given "RUN-0001" 有 3 个 verified 任务，依赖为 T1→T2、T3 独立

  # BDD-008-01 主流程：拓扑序合并
  Scenario: 按依赖序合入集成分支
    When 用户执行 "/team-integrate RUN-0001"
    Then 应创建 "team/RUN-0001/integration" 分支
    And 合并顺序应为 T1、T2、T3（拓扑序，--no-ff）
    And 三个任务应变为 "integrated"

  # BDD-008-02 单点失败不卡全局
  Scenario: 某任务合并后检查失败被回退
    Given T2 合并后 focused checks 失败
    Then T2 的 merge 应被 revert 且 T2 变 "changes_requested"
    And T3 应继续正常合入
    And integration 报告应列出成功与回退清单

  # BDD-008-03 不自动合 main
  Scenario: 集成完成停在集成分支
    When 集成与全量验证完成、报告写出
    Then run 应变为 "reported"
    And "main" 分支不应有任何新提交

  # BDD-008-04 export 脱敏阻断（NFR-004）
  Scenario: 导出内容命中 secret 即中止
    Given 某 evidence 归档中含漏网的 "ghp_" 开头 token
    When 用户执行 "team export --run RUN-0001"
    Then 导出应中止且 code 为 "export_redaction_hit"
    And 输出应列出命中文件与位置，目标目录不产生文件

  # BDD-008-05 正常留档
  Scenario: 干净内容导出成功
    Given 归档内容无 secret 命中
    When 用户执行 export 至 "docs/team-runs/RUN-0001"
    Then 应产出 plan/report/integration 与各任务 evidence.md
    And 打印文件清单等待用户自行提交
