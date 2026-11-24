# 06 - 总结

## 阶段元数据

- id: 06
- title: 06 - 总结
- variant: full
- designSource: others-html
- instruction: references/others-html/full/stages/06-summary.md
- 子 Agent: 无

## 强制阶段入口 Todo 同步

读取 `stage-start.todoPayloadPath`，将 `.todos` 原样调用一次 `todowrite`；成功前不得执行阶段工作。

## 目标

核对整条 run 的产物链，写出交付报告 `completeness-report.md`。本阶段**只做核对与汇总，不改代码、不改校准结论**；发现缺陷应回到对应阶段修复，不得在本阶段直接改。

## 执行

> Todo 同步后读完本阶段说明。工具提示还有后续行时按 offset 继续读取。提交阶段 6 前，先按下文「交付评分产物」确认实际交付页面，向 run 根目录写入 `final-visual-score.json` 并确认落盘；再按主 Skill 的「交付任务完成率验收」写入 `task-completion.json` 并确认落盘。两份报告就位后，才可执行最终的 `stage-complete --stage 6 --result passed`。缺少可信评分时显式记录 `{"status":"unavailable"}`，明确禁用校准时沿用跳过分支。

1. 核对产物链：逐项确认以下文件存在且非空——`requirement-clarification.json`、`inputs-manifest.json`、`input-security-report.json`、`stage1/layout-facts.json`、`stage1/visual-spec.json`、`inputs-manifest.htmlSource.path` 指向的 HTML 源文件、`source/html/reference/`、`component-tree.md`、`design-doc.md`、`stage2/`（分析和构建报告）、`stage3-interaction-report.md`、`hds-decision.json`、`stage4/quality-audit.json`、`stage4/build-report.md`、`stage5-visual-calibration-report.json`、`capability-invocation-ledger.json`。
2. 核对工程侧：目标页面文件存在、无 `@Entry`；`Index.ets` 仍只有一个 `@Entry`；`EntryAbility.loadContent` 的路由值、`main_pages.json` 与磁盘文件名三处一致且未被改动（`onWindowStageCreate` 允许新增窗口配置）；`routerMap` 与 `.navDestination(builder)` 未并存。
3. 核对 `run-index.json`：本 run 的记录已由 Controller 在阶段 2 写入，字段与 `stage2/generated-ui-manifest.json` 一致。
4. 核对 `capability-invocation-ledger.json`：`hmos-d2a-html-to-arkui`（阶段 1 取证）、`hmos-d2a-solution-design`、`hmos-d2a-arkts-logic-completer` 均为 completed；执行视觉校准时，`hmos-d2a-arkui-scoring-workflow` 为 completed，且 round 1 至 `roundsCompleted` 各有一条 `hmos-d2a-ui-reconstruction-score` 的 completed 记录（`visualCalibration.enabled=false` 跳过校准时两者不得出现）；`hmos-d2a-arkui2hds` 仅在 `hdsRequired=true` 时出现，否则不得出现。
5. 写 `completeness-report.md`，必须包含以下小节：
   - **生成/修改文件清单**（分新增与修改）
   - **路由与可达性**：`reachability` 结论、注册方式、临时预览是否已恢复
   - **功能实现表**：引用 `stage3-interaction-report.md` 的交互结论，不重新判断
   - **校准结论**：`roundsCompleted`、末轮分数与阈值、`completionReason`，以及按结束原因分桶的残留差异清单（引用末轮问题摘要与对应截图路径）；`max-rounds-reached` 是兜底停机**不是失败**，总结中不得出现「失败」字样；用过临时预览时写明恢复状态
   - **权威产物与实现的一致性核对**：说明实现取值是否来自 `layout-facts.json`，列出报告中仍未闭合的差异项
   - **已知限制**：临时预览、占位页、近似实现、参考图未覆盖的区域等，逐条列出
6. 按主 Skill 的「交付任务完成率验收」读取本 run 的 `design-doc.md`，对照本次交付代码与已有证据逐项判定，把报告写入 run 根目录 `task-completion.json`，确认落盘。
7. 完成后先读取 `workflow-state.json` 的 `todoPayloadPath`，调用 `todowrite` 同步最终 TODO 状态，再调用 `stage-complete --stage 6 --result passed`；本阶段通过即整条 run 完成。

## 交付评分产物

在调用最终 `stage-complete --stage 6 --result passed` 前，确认本次实际交付的页面，并向 run 根目录写入 `final-visual-score.json`：

| 交付情况 | 产物 |
|---|---|
| 确认交付当前已评过的候选页面 | `{"status":"recorded","source":"calibration_round","round":N}`。N 是实际采用版本被截图并评分的轮次。 |
| 确认交付的是某个经核实的历史候选 | 同样写 `calibration_round`，取实际采用轮次。校准报告的末轮数据仍如实记录。 |
| 现有证据无法确认实际交付页面对应哪轮 | 若该流程已有允许的交付复评结果，引用现有 `delivery_check` 产物。否则写 `{"status":"unavailable"}`。 |
| 校准明确跳过 | 沿用已有 skipped 校准报告。Controller 直接记录 `skipped`。 |

- 评分指针只描述评分依据；Controller 在阶段 6 通过时校验该文件，并把实际分数随完成状态写入 `workflow-state.json` 的 `analytics.finalScore`。
- 本阶段保留只读核对职责，代码修改、构建部署或临时预览一律在前序阶段处理；评分指针不作为 Controller 的新业务 gate。

## 必需产物

```text
<designToArktsRunDir>/
└── completeness-report.md
```

## 完成条件

- 第 1–4 步的核对全部通过；任何缺失项都必须回到对应阶段补齐，不得在报告中"说明"了事。
- `completeness-report.md` 含全部六个小节，且：
  - 校准结论里的 `roundsCompleted`、末轮分数、`completionReason` 与 `stage5-visual-calibration-report.json` **完全一致**（不得四舍五入出不同结论）；
  - "一致性核对"小节写明了差异项数与残留项，且与阶段 5 报告末轮的问题摘要一一对应；
  - **不得**把"设计文档未被改动"写成合规优点，也不得用"忽略差异""近似等价"掩盖未闭合项。
- 报告里不出现与本设计来源无关的其它来源字段（如 figma 的 `node-id`、pixso 的 DSL 路径）。

通过后调用（此前 `final-visual-score.json` 与 `task-completion.json` 均须已落盘）：

```text
node <skillRoot>/scripts/workflow.mjs --mode stage-complete --run-dir <designToArktsRunDir> --stage 6 --result passed
```

产物缺失、核对不一致时使用稳定 reason code 完成 blocked，并说明需要回到哪个阶段修复。