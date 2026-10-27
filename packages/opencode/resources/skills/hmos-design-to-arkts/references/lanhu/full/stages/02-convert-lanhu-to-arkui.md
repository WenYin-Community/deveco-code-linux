# 02 设计并实现 ArkUI 页面（需人工确认）

初次入口读取 stage-start.todoPayloadPath，将 .todos 原样提交一次 todowrite；用户确认后为同阶段续跑，不再 stage-start 或重放 Todo。

加载并完整执行 `references/capabilities/hmos-d2a-lanhu-to-arkui/INSTRUCTIONS.md`，传入 orchestrator=hmos-design-to-arkts、workflowStage=2、confirmationPolicy=manual、runStatePath=<runDir>/stage2/hmos-d2a-lanhu-to-arkui-run.json、runDir 和 projectRoot。使用蓝湖固定节点、干净参考图及资源，后续沿用 Solution Design、最佳实践和工程注册能力。

## 确认前

只完成分析、资源计划和方案。可以下载资源到 runDir 验证，但不修改工程代码、工程资源或导航，不执行实现构建。按 input-contract 完成 project-analysis、image-only 的 recognize_ui_components、component-analysis、component-tree、system-ui-policy、viewport-boundary-spec、asset-selection；由 Solution Design 唯一写入 design-doc.md，并在 ledger 记录同 invocationId completed。

将能力 phase 设为 awaiting_confirmation，confirmationPolicy=manual，锁定原 inputs hash，然后调用 Controller confirm --stage 2 --decision request。Controller 冻结视觉识别、组件分析、组件树、设计文档，以及蓝湖的工程分析、系统 UI、视口和资源计划，共八个文件的 hash。

展示实际方案、资源处理、页面入口、交互推断和局限，发起一次明确的组件方案确认。等待用户选择：接受方案 / 提出修改；不得自动接受，不追加泛化的“是否继续”。

## 接受或修订

- 接受：调用 confirm --decision accepted；只有 snapshot 和当前文件一致才成功。写 stage2/component-confirmation.json，decision=accepted、invocationId 与能力记录一致。收到 resume_confirmed_stage 后沿用相同 invocationId，phase=implementing，继续能力的资源工程复制、页面/路由注册和初次构建。不得重新取稿、重做已确认分析或再次问确认。
- 修改：调用 confirm --decision revision-requested，清除旧 snapshot；按 stage_start 返回重新进入阶段，保持蓝湖 snapshot/version 不变，修订受影响方案。视觉输入 image/requirements hash 未变时复用原识别文件。将 phase 重新设为 awaiting_confirmation 后再次 request。
- 等待时恢复：status 返回 resume_confirmation 时展示同一份方案，禁止重新生成；确认后恢复：resume_confirmed_stage 直接续做实现。

确认后的八份方案文件保持只读。缺失或变化时报告 confirmation_snapshot_invalid；阶段 2 未完成时走 revision 重新确认，后续阶段不得通过设计文档自动恢复绕过用户确认。

## 完成

phase=completed，保留 manual policy、accepted 记录、真实资源绑定、独立 @Component 页面和 Index 注册、初次构建报告；必需产物见 input-contract。Controller stage-complete 2 会验证确认快照和工程，并唯一写入 Full run-index；Agent 不提前登记。失败按稳定 reason code blocked。
