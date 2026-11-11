# 04 - 完成 HDS 适配、质量审计与最终构建

## 阶段元数据

- id: 04
- title: 04 - 完成 HDS 适配、质量审计与最终构建
- variant: fast
- designSource: others-visual
- instruction: references/others-visual/fast/stages/04-quality-and-build.md
- 必用能力: ArkTS 代码质量 skill；需要 HDS 时使用 `hmos-d2a-arkui2hds`
- 子 Agent: 可用于质量审计，但主 Agent 负责最终产物和 `<designToArktsFastRunDir>/capability-invocation-ledger.json`

## 强制阶段入口 Todo 同步

读取 `stage-start.todoPayloadPath`，将 `.todos` 原样调用一次 `todowrite`；成功前不得执行阶段工作。

## 目标

在阶段 2 的静态页面与阶段 3 的业务交互之上完成 HDS 适配、质量审计和最终构建，不重新设计页面结构。Fast 没有后续独立视觉校准，因此本阶段必须清零所有可静态发现的 critical/major 视觉与边界问题。

## 执行

1. 读取阶段 2/3 的最终代码、`design-doc.md`、`component-tree.md`、`stage2/image-assets-manifest.json`、`stage2/initial-build-report.json`、`stage3-interaction-report.md`、`system-ui-policy.json`、`viewport-boundary-spec.json` 和 `requirement-clarification.json`。
2. 读取 `design-doc.md` 的 HDS 组件替换映射，根据项目依赖、设计语义和用户偏好写入 `<designToArktsFastRunDir>/hds-decision.json`。`hdsRequired=true` 时必须加载能力 `hmos-d2a-arkui2hds`（注册表 → references/capabilities/hmos-d2a-arkui2hds/INSTRUCTIONS.md），并完整执行，在 ledger 记录同一 `invocationId` 的 invoked 与 completed；不需要时记录可审计的不调用理由，不得伪造该能力调用。
3. 调用 DevEco Code 当前可用的 ArkTS/HarmonyOS 代码质量 skill 执行静态检查，修复类型、状态、生命周期、资源、路由和 API 使用问题，不得通过删除真实 UI、替换占位块或降级组件来通过构建。
4. 独立审计几何布局、HDS、系统 UI 沉浸、顶部碰撞、视口边界、安全区单位和坐标归一化；假状态栏、假 Home Indicator、整页绝对定位和缺失真实资源均视为阻塞问题。Fast 无后续独立视觉校准，所有可静态发现的 critical/major 视觉与边界问题必须在本阶段清零。
5. 执行最终构建/类型检查：失败时正向定位并做局部修复后重跑；缺少 `devecocli` 等构建工具时按权限边界报告/请求授权，不得静默全局安装。
6. 写入 `stage4-quality-audit.json`、`stage4-quality-audit.md`、`stage4-build-report.md`、`hds-decision.json` 和所需审计报告；把相关能力调用记录更新为 completed。

## Ledger 生命周期

沿用阶段 2、3 已建立的 `<designToArktsFastRunDir>/capability-invocation-ledger.json`，不创建第二份 ledger：

- 调用任何 ArkTS 代码质量 skill 前，写入该实际 skill 的 `invoked` 记录和唯一 `invocationId`。
- `hds-decision.json.hdsRequired=true` 时，调用 `hmos-d2a-arkui2hds` 前记录独立的 `invoked` 生命周期；`hdsRequired=false` 时不伪造该能力调用。
- 每次 skill 调用成功并且输出完成校验后，使用原 `invocationId` 将对应记录更新为 `completed`，记录实际输入、输出和结果。
- 调用失败时记录真实失败状态和错误，不得写成 `completed`。
- 阶段 4 通过前，必用质量 skill 必须存在匹配的 completed 记录；HDS required 时 `hmos-d2a-arkui2hds` 也必须存在 completed 记录。

## 必需产物

```text
<designToArktsFastRunDir>/
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

全部审计通过且构建成功后调用：

```text
workflow.mjs --mode stage-complete --run-dir <designToArktsFastRunDir> --stage 4 --result passed
```

无法继续时使用稳定 reason code 完成 blocked，不得切换设计源链路。
