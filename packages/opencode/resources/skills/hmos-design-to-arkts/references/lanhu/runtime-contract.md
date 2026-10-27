# 蓝湖 Full/Fast 运行契约

沿用入口 references/runtime-contract.md 的五种 Controller 操作、状态机、Todo、Gate、blocked 和全局运行索引规则。蓝湖支持 --source lanhu --variant full|fast；不转到 Figma/Pixso，不在恢复时切换 variant。

Fast 五阶段为获取输入、设计与实现、交互补全、质量与构建、总结。Full 六阶段与 Figma Full 对齐：获取输入、方案确认并实现、交互补全、质量与构建、视觉校准、总结。来源和 variant 锁定，所有后续查询使用同一 snapshotId 和 resolvedVersion。Fast 运行目录/索引为 .deveco/design-to-arkts-fast/runs/<runId> 与 .deveco/design-to-arkts-fast/run-index.json；Full 为 .deveco/design-to-arkts/runs/<runId> 与 .deveco/design-to-arkts/run-index.json。

输入和阶段 2 产物遵循 [input-contract.md](input-contract.md)。init 后直接 stage-start 1；成功入口必须原样同步 todoPayloadPath 的 .todos，再执行阶段。正常完成阶段直接 stage-complete passed，再 stage-start 下一阶段；最终阶段同步全 completed Todo 后回复。

Fast 阶段 2 自动接受方案，仍执行组件识别、Solution Design、资源安装、独立页面及 Index 注册、初次构建。Agent 不修改工具生成的原始证据、视觉识别文件、verified.json、receipt 或 Controller Gate。

Full 阶段 2 confirmationContinuesStage=true：先完成方案并 request，Controller 冻结八文件 hash；主 Agent 获得用户 accepted 后返回 resume_confirmed_stage，同一阶段继续实现，禁止再次 stage-start/Todo 或自动接受。status 恢复相同确认问题或确认后 checkpoint；revision 清除 snapshot 后重新确认。已确认方案缺失/变化按 confirmation_snapshot_invalid 阻塞，不自动恢复文档绕过确认。

Full 阶段 3/4/5 复用 Figma Full 规范和原能力；第 5 阶段直接复用同一视觉校准 Gate、阈值/轮数、评分产物及启用/禁用分支，参考图由蓝湖 input-contract 适配。

Fast 设计文档缺失使用 Controller 返回的恢复 payload：restore_document 由 Solution Design 只补文档；resume_design_generation 由 hmos-d2a-lanhu-to-arkui 的 restore_design_artifacts 模式只恢复方案产物，保持 run state phase。均使用原 recoveryInvocationId、ledger 和 retry，禁止实现、安装、路由修改和构建。缺少上游证据则 blocked。
