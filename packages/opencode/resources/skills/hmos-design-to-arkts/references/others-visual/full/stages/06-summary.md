# 06 - 总结

## 阶段元数据

- id: 06
- title: 06 - 总结
- variant: full
- designSource: others-visual
- instruction: references/others-visual/full/stages/06-summary.md

## 强制阶段入口 Todo 同步

读取 `stage-start.todoPayloadPath`，将 `.todos` 原样调用一次 `todowrite`；成功前不得执行阶段工作。

## 目标

校验阶段 1 至 5 的业务产物、实际工程文件和 `<designToArktsRunDir>/capability-invocation-ledger.json`，核对本设计源输入身份与产物链，生成 `completeness-report.md`，并以最终阶段完成命令结束整个运行。本阶段只读取和核对，不新增、补写或修改前序阶段的产物；总结阶段不得引用其它设计源链条的身份字段，本来源身份核对以截图 SHA-256 与阶段 1–5 产物链为准。

## 执行

> Todo 同步后读完本阶段说明。工具提示还有后续行时按 offset 继续读取。提交阶段 6 前，先按下文「交付评分产物」确认实际交付页面，向 run 根目录写入 `final-visual-score.json` 并确认落盘；再按主 Skill 的「交付任务完成率验收」写入 `task-completion.json` 并确认落盘。两份报告就位后，才可执行最终的 `stage-complete --stage 6 --result passed`。缺少可信评分时显式记录 `{"status":"unavailable"}`，明确禁用校准时沿用跳过分支。

1. 校验阶段 1 至 5 的业务产物、实际工程文件和 `<designToArktsRunDir>/capability-invocation-ledger.json`，不得只根据 Todo 或对话总结判断。
2. 核对阶段 1-5 产物链：截图 SHA-256（与 `inputs-manifest.json` 记录一致）、`stage1/visual-spec.json`、组件识别结果、组件树、设计方案、交互实现、HDS 决策、最终构建和视觉校准报告。
3. 核对页面身份与历史保护：`run-index.json` 由 Controller 在阶段 2 通过后写入（本来源与 Figma/MasterGo/others-html 共用同一份），Agent 不得手写或改写。页面身份以阶段 1 的工程接入快照（`inputs-manifest.json.integrationSnapshot`）、阶段 2 的 `component-tree.md` 与实际工程文件为准：确认目标页面文件、组件名、路由、注册位置与 `design-doc.md` 和 `stage2/generated-ui-manifest.json` 一致，历史页面与默认入口未被覆盖。发现冲突时报告为阻塞问题，不得在总结阶段自行修改工程文件或索引。
4. 写入 `<designToArktsRunDir>/completeness-report.md`，列出生成/修改文件、页面路由、功能实现情况、视觉评分（`roundsCompleted`、末轮分数与阈值、`completionReason`，并按结束原因分桶列出残留差异清单）、已知限制和复现方式；`max-rounds-reached` 是兜底停机**不是失败**，不得使用「失败」字样。
5. 按主 Skill 的「交付任务完成率验收」读取本 run 的 `design-doc.md`，对照本次交付代码与已有证据逐项判定，把报告写入 run 根目录 `task-completion.json`，确认落盘。
6. 只有所有必需产物存在、阶段链连续、`completeness-report.md` 与实际工程一致，且 `final-visual-score.json` 与 `task-completion.json` 均已落盘时，才允许执行文末的阶段完成命令。

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
├── completeness-report.md
└── capability-invocation-ledger.json
```

## 完成条件

- `completeness-report.md` 存在，内容与实际工程和阶段 1-5 产物链一致，覆盖生成/修改文件、页面路由、功能实现、视觉评分、已知限制和复现方式。
- `capability-invocation-ledger.json` 中阶段 2 至 5 的必需能力均有匹配的 completed 记录（HDS 视 `hds-decision.json.hdsRequired` 而定）。
- 页面身份、注册位置与历史保护核对通过，未发现被覆盖的历史页面或默认入口。
- 所有必需产物存在且阶段链连续；任一必需条件不满足时不得请求 `passed`，先修复证据，无法继续时使用稳定 reason code 完成 blocked。

阶段完成（此前 `final-visual-score.json` 与 `task-completion.json` 均须已落盘）：

```text
workflow.mjs --mode stage-complete --run-dir <designToArktsRunDir> --stage 6 --result passed
```

Controller 返回 `sync_final_todo_then_finish` 后，读取返回的 `todoPayloadPath`，把全量 completed `.todos` 原样调用一次 `todowrite`，再向用户输出最终总结；最终阶段后不得运行 `stage-start`。
