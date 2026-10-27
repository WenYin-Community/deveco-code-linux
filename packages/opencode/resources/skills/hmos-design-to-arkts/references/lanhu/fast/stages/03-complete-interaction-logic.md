# 03 补全 ArkTS 交互逻辑

## 阶段入口

读取本次成功 stage-start 返回的 todoPayloadPath，原样把 .todos 调用一次 todowrite。同步成功后才执行以下工作。正常完成后 stage-complete --stage 3 --result passed；失败使用现有稳定 reason code blocked，并保存具体原因。

加载 hmos-d2a-arkts-logic-completer（references/capabilities/hmos-d2a-arkts-logic-completer/INSTRUCTIONS.md）全文并执行。消费 requirement-clarification、design-doc、组件树和已生成页面，实现明确需求内的交互、校验、状态和路由。

静态设计未提供业务 API 时按用户需求处理模拟/本地数据，标出推断，不声称已经连接真实 API。保留已有资源和导航壳，恢复时避免重复接线。写 stage3-report.json，status=completed，包含改动文件、已实现行为、验证和剩余事项。
