# 02 设计并实现 ArkUI 页面

## 阶段入口

读取本次成功 stage-start 返回的 todoPayloadPath，原样把 .todos 调用一次 todowrite。同步成功后才执行以下工作。正常完成后 stage-complete --stage 2 --result passed；失败使用现有稳定 reason code blocked，并保存具体原因。

加载能力 hmos-d2a-lanhu-to-arkui（references/capabilities/hmos-d2a-lanhu-to-arkui/INSTRUCTIONS.md）全文，完整执行，传递 orchestrator、workflowStage=2、confirmationPolicy=auto-accept、runStatePath、runDir 和锁定 projectRoot。

执行前在 capability-invocation-ledger.json 记录该能力 invoked，成功后更新 completed。能力必须完成识别、方案、资源安装、页面与 Index 注册、初次构建；不要求人工确认，不得只生成代码就结束。
