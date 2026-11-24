# 05 总结

## 阶段入口

读取本次成功 stage-start 返回的 todoPayloadPath，原样把 .todos 调用一次 todowrite。同步成功后才执行以下工作。

核对各阶段产物、最终构建、资源回执、页面注册与全局索引。写 stage5-report.json，status=completed，包含目标页面/路由、固定设计版本、资源状态、构建结果、已知限制，明确 Fast 未执行 Full 视觉评分。

随后按主 Skill 的「交付任务完成率验收」读取本 run 的 `design-doc.md`，对照本次交付代码与已有证据逐项判定，把报告写入 run 根目录 `task-completion.json`；确认落盘后再执行最终 stage-complete --stage 5 --result passed。失败使用现有稳定 reason code blocked，并保存具体原因。

最终 stage-complete passed 后，读取返回 todoPayloadPath 并把全量 completed .todos 原样提交 todowrite，再输出页面路径、入口和验证结果。不要在完成前声称生成成功。
