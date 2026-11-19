# 06 - 总结

## 阶段元数据

- id: 06
- title: 06 - 总结
- variant: full
- designSource: figma
- instruction: references/figma/full/stages/06-summary.md

## 强制阶段入口 Todo 同步

读取 `stage-start.todoPayloadPath`，将 `.todos` 原样调用一次 `todowrite`；成功前不得执行阶段工作。

## 执行

1. 校验阶段 1 至 5 的业务产物、实际工程文件和 `<designToArktsRunDir>/capability-invocation-ledger.json`，不得只根据 Todo 或对话总结判断。
2. 核对 Anchor 输入身份、React 源 hash、`hmos-d2a-react-to-arkui` 运行记录、组件确认、交互实现、HDS 决策、最终构建和视觉校准。
3. 写入 `<designToArktsRunDir>/completeness-report.md`，列出生成/修改文件、页面路由、功能实现情况、视觉评分、已知限制和复现方式。
4. 只读核对运行索引：确认本运行的页面记录存在，且 `pageFile`、`componentName`、`route`、`registrationMode`、`registrationFile` 与实际工程一致。当前运行记录已由 Controller 在阶段 2 完成时写入；本阶段不得新增、修改或删除 `run-index.json` 记录，不得刷新 `contentSha256`，不得切换默认页面或覆盖历史运行。发现记录缺失或身份冲突时，应将其报告为阻塞问题，不得在总结阶段自行修复索引。
5. 在调用最终 `stage-complete` 前，明确本次实际交付的页面，并向 run 根目录写入交付评分产物 `<designToArktsRunDir>/final-visual-score.json`：
   - 交付最后一次有效截图对应的页面，且评分后未再修改实现时，写 `{ "status": "recorded", "source": "calibration_round", "round": N }`，N 为实际交付页面对应的那一轮校准评分。
   - 本阶段恢复某个历史候选页面，且能依据现有恢复、构建部署记录确认恢复的就是当时评分的完整实现时，同样使用 `calibration_round` 并记录实际恢复的评分轮次；只改轮次号不能说明页面已恢复。
   - 总结阶段修改了影响渲染的实现，或无法核实恢复内容与历史候选一致时，按 `hmos-d2a-arkui-scoring-workflow` 的「总结阶段单次交付复评」对当前页面重新构建、部署、截图并评分，写入 `delivery_check` 产物。
   - 无法得到可用的交付评分时写 `{ "status": "unavailable" }`。
   - `final-visual-score.json` 只描述评分依据；Controller 在最终阶段通过时校验该文件，并把实际分数随完成状态写入 `workflow-state.json` 的 `analytics.finalScore`。
6. 本阶段已有工作和验证完成后，按主 Skill 的「交付任务完成率验收」读取本 run 的 `design-doc.md`，对照本次交付代码与已有证据逐项判定，把报告写入 `<designToArktsRunDir>/task-completion.json`；确认落盘后，再执行本阶段的最终提交。交付评分产物与任务验收报告都要在最终提交前就位。
7. 只有所有必需产物存在且阶段链连续时调用：

```text
workflow.mjs --mode stage-complete --run-dir <designToArktsRunDir> --stage 6 --result passed
```

Controller 返回 `sync_final_todo_then_finish` 后，读取返回的 `todoPayloadPath`，把全量 completed `.todos` 原样调用一次 `todowrite`，再向用户输出最终总结；最终阶段后不得运行 `stage-start`。
