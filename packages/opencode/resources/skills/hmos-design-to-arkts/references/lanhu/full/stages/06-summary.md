# 06 总结

读取 stage-start.todoPayloadPath，把 .todos 原样提交一次 todowrite 后执行。

核对阶段 1—5：蓝湖固定设计版本/快照及完整节点、资源交付与真实工程绑定、manual 确认快照和 accepted 记录、能力 completed checkpoint、交互补全、HDS/质量与最终构建、视觉校准启用或明确禁用分支。

写 completeness-report.md，记录生成和修改文件、页面入口、功能、实际视觉分数/轮次/退出理由或跳过原因、已知限制、复现方式。分别说明 MCP 取数、MCP 切图和用户素材的实际验证状态；不将 developer-provided 当作蓝湖自动切图成功。

只读核对 Full run-index 中本 run 的页面身份和历史页面保留情况，不修改记录或刷新 contentSha256。

在调用最终 `stage-complete` 前，明确本次实际交付的页面，并向 run 根目录写入交付评分产物 `final-visual-score.json`：交付最后一次有效截图对应页面且评分后未再修改时写 `{ "status": "recorded", "source": "calibration_round", "round": N }`；恢复历史候选且能核实与当时评分实现一致时同样用 `calibration_round` 记录实际轮次；本阶段修改了影响渲染的实现或无法核实恢复内容时，按 `hmos-d2a-arkui-scoring-workflow` 的「总结阶段单次交付复评」对当前页面重新构建、部署、截图并评分，写入 `delivery_check` 产物；无法得到可用评分时写 `{ "status": "unavailable" }`。该文件只描述评分依据，Controller 在最终阶段通过时校验并把实际分数写入 `workflow-state.json` 的 `analytics.finalScore`。

所有 Gate 和真实工程一致后，按主 Skill 的「交付任务完成率验收」读取本 run 的 `design-doc.md`，对照本次交付代码与已有证据逐项判定，把报告写入 run 根目录 `task-completion.json`；确认落盘后 stage-complete --stage 6 --result passed；按返回的 sync_final_todo_then_finish 同步最终 completed Todo，再输出总结。真实阻塞不能用报告或建议冒充完成。
