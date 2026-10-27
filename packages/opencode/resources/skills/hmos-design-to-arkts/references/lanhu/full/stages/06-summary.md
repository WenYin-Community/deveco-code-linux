# 06 总结

读取 stage-start.todoPayloadPath，把 .todos 原样提交一次 todowrite 后执行。

核对阶段 1—5：蓝湖固定设计版本/快照及完整节点、资源交付与真实工程绑定、manual 确认快照和 accepted 记录、能力 completed checkpoint、交互补全、HDS/质量与最终构建、视觉校准启用或明确禁用分支。

写 completeness-report.md，记录生成和修改文件、页面入口、功能、实际视觉分数/轮次/退出理由或跳过原因、已知限制、复现方式。分别说明 MCP 取数、MCP 切图和用户素材的实际验证状态；不将 developer-provided 当作蓝湖自动切图成功。

只读核对 Full run-index 中本 run 的页面身份和历史页面保留情况，不修改记录或刷新 contentSha256。所有 Gate 和真实工程一致后 stage-complete --stage 6 --result passed；按返回的 sync_final_todo_then_finish 同步最终 completed Todo，再输出总结。真实阻塞不能用报告或建议冒充完成。
