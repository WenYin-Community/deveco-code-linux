# 03 - 补全 ArkTS 业务交互逻辑

## 阶段元数据

- id: 03
- title: 03 - 补全 ArkTS 业务交互逻辑
- variant: full
- designSource: others-visual
- instruction: references/others-visual/full/stages/03-complete-interaction-logic.md
- 加载能力 `hmos-d2a-arkts-logic-completer`（注册表 → references/capabilities/hmos-d2a-arkts-logic-completer/INSTRUCTIONS.md），并完整执行

## 强制阶段入口 Todo 同步

读取 `stage-start.todoPayloadPath`，将 `.todos` 原样调用一次 `todowrite`；成功前不得执行阶段工作。

## 目标

在阶段 2 已确认的 `component-tree.md`、`design-doc.md` 和静态布局上补全需求明确或可安全推断的状态、事件、导航、数据和动效，不重新设计页面结构。

## 执行

1. 读取 `requirement-clarification.json`、`stage2/generated-ui-manifest.json`、`stage2/component-confirmation.json`、`stage2/implementation-report.md`、`design-doc.md`、`component-tree.md` 和阶段 2 已实现的 ETS 文件。
2. 在 `<designToArktsRunDir>/capability-invocation-ledger.json` 记录并加载能力 `hmos-d2a-arkts-logic-completer`（注册表 → references/capabilities/hmos-d2a-arkts-logic-completer/INSTRUCTIONS.md），并完整执行；缺失或调用失败时阻塞，不得以主 Agent 手写替代。
3. 区分阶段 2 已实现的基础组件状态与尚未实现的业务行为，避免重复绑定事件或创建两套状态源。
4. 补全列表数据、选中态、输入、点击、页面跳转、加载/空/错误态和必要动效；真实接口未提供时遵循 `requirement-clarification.json` 中的数据策略。
5. 保持首帧稳定，异步数据不得导致首帧结构跳变；不破坏内容组件与 Index 注册结构的边界，不改写已确认的 `design-doc.md`、`component-tree.md` 与只读的 `stage1/visual-spec.json`。
6. 执行构建/类型检查，写入 `stage3-interaction-report.md`，记录功能映射、修改文件、未实现项和构建/类型检查结果；把 `<designToArktsRunDir>/capability-invocation-ledger.json` 中该能力记录更新为 completed。

## 必需产物

```text
<designToArktsRunDir>/
├── stage3-interaction-report.md
└── capability-invocation-ledger.json
```

## 完成条件

- `hmos-d2a-arkts-logic-completer` 在 `<designToArktsRunDir>/capability-invocation-ledger.json` 中为 completed。
- 需求功能映射完整、无重复状态源；交互逻辑已覆盖选中态、输入、点击、跳转及各数据态。
- 页面结构、已确认的组件树与 Index 注册关系未被重设，首帧结构稳定。
- 构建/类型检查通过，`stage3-interaction-report.md` 与实际代码一致。

满足条件后调用：

```text
workflow.mjs --mode stage-complete --run-dir <designToArktsRunDir> --stage 3 --result passed
```

能力缺失、业务逻辑无法构建或需求输入不合法时使用稳定 reason code 完成 blocked，不得切换设计源链路。
