# 04 - 完成 HDS 适配、质量审计与最终构建

## 阶段元数据

- id: 04
- title: 04 - 完成 HDS 适配、质量审计与最终构建
- variant: full
- designSource: others-visual
- instruction: references/others-visual/full/stages/04-quality-and-build.md
- 必用能力: ArkTS 代码质量 skill；需要 HDS 时使用 `hmos-d2a-arkui2hds`
- 子 Agent: 可用于质量审计，但主 Agent 负责最终产物和 `<designToArktsRunDir>/capability-invocation-ledger.json`

## 强制阶段入口 Todo 同步

读取 `stage-start.todoPayloadPath`，将 `.todos` 原样调用一次 `todowrite`；成功前不得执行阶段工作。

## 目标

在阶段 2 的静态布局与阶段 3 的业务交互之上完成 HDS 适配、质量审计和最终构建，不重新设计页面结构，也不通过降级实现通过审计。

## 执行

1. 读取阶段 2/3 的最终代码、`design-doc.md`、`component-tree.md`、`system-ui-policy.json`、`viewport-boundary-spec.json`、`stage2/image-assets-manifest.json`、`stage2/initial-build-report.json`、`stage3-interaction-report.md` 和 `requirement-clarification.json`。
2. 读取 `design-doc.md` 的 HDS 组件替换映射，根据项目依赖、设计语义和用户偏好写入 `<designToArktsRunDir>/hds-decision.json`。`hdsRequired=true` 时必须加载能力 `hmos-d2a-arkui2hds`（注册表 → references/capabilities/hmos-d2a-arkui2hds/INSTRUCTIONS.md），并完整执行，在 `<designToArktsRunDir>/capability-invocation-ledger.json` 记录同一 `invocationId` 的 invoked 与 completed；不需要时记录可审计的不调用理由，不得伪造该能力调用。
3. 调用 DevEco Code 当前可用的 ArkTS/HarmonyOS 代码质量 skill 执行静态检查：调用前在 ledger 写入该实际 skill 的 `invoked` 与唯一 `invocationId`，成功并通过输出校验后使用同一 id 更新为 `completed`，失败时记录真实失败状态。修复类型、状态、生命周期、资源、路由和 API 使用问题，不得通过删除真实 UI、替换占位块或降级组件来通过构建。
4. 独立执行几何布局、HDS、系统 UI 沉浸、顶部碰撞、视口边界、安全区单位和坐标归一化审计。假状态栏、假 Home Indicator、整页绝对定位和缺失真实资源均视为阻塞问题。
5. 执行最终构建/类型检查：失败时正向定位并做局部修复后重跑；缺少 `devecocli` 等构建工具时按权限边界报告/请求授权，不得静默全局安装。
6. 写入 `stage4-quality-audit.json`、`stage4-quality-audit.md`、`stage4-build-report.md`、`<designToArktsRunDir>/hds-decision.json` 和所需审计报告；把相关能力调用记录更新为 completed。

## 必需产物

```text
<designToArktsRunDir>/
├── stage4-quality-audit.json
├── stage4-quality-audit.md
├── stage4-build-report.md
├── hds-decision.json
└── capability-invocation-ledger.json
```

## 完成条件

- `hds-decision.json` 已写入且字段可用于审计；`hdsRequired=true` 时 `hmos-d2a-arkui2hds` 在 ledger 中为 completed，`hdsRequired=false` 时有可审计的不调用理由。
- 实际使用的 ArkTS 代码质量 skill 在 ledger 中为 completed，无伪装完成记录。
- 质量审计所有 critical/major 问题清零；几何布局、HDS、系统 UI、视口边界、安全区单位和坐标归一化审计通过；无假状态栏、假 Home Indicator、整页绝对定位或缺失真实资源。
- 最终构建/类型检查通过，`stage4-build-report.md` 与实际执行的命令和结果一致。
- 实现仍未偏离已确认设计：字号/圆角/色板与 stage1/visual-spec.json 对得上（阶段 4 只修缺陷，不调视觉；视觉调整属于阶段 5 且必须在其报告里逐条记录）。

所有 critical/major 问题清零、HDS 决策落实、资源完整且最终构建通过后，调用：

```text
workflow.mjs --mode stage-complete --run-dir <designToArktsRunDir> --stage 4 --result passed
```

无法继续时使用稳定 reason code 完成 blocked，不得切换设计源链路。
