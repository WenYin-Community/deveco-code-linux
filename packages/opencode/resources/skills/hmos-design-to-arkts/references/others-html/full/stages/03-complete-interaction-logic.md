# 03 - 补全 ArkTS 业务交互逻辑

## 阶段元数据

- id: 03
- title: 03 - 补全 ArkTS 业务交互逻辑
- variant: full
- designSource: others-html
- instruction: references/others-html/full/stages/03-complete-interaction-logic.md
- 必用能力：`hmos-d2a-arkts-logic-completer`
- 子 Agent: 无

## 强制阶段入口 Todo 同步

读取 `stage-start.todoPayloadPath`，将 `.todos` 原样调用一次 `todowrite`；成功前不得执行阶段工作。

## 目标

在阶段 2 已完成的静态布局上补全需求明确或可安全推断的状态、事件、导航、数据和动效。**不重新设计页面结构，不修改视觉取值**——结构与取值已在阶段 2 固化并从 `layout-facts.json` 取用。

## 执行

1. 读取 `requirement-clarification.json`、`stage2/generated-ui-manifest.json`、`stage2/component-analysis.md`、`stage2/implementation-report.md`、`component-tree.md`、`design-doc.md`、`stage1/visual-spec.json` 与阶段 2 的最终 ETS 文件。
2. 向 `<designToArktsRunDir>/capability-invocation-ledger.json` 追加 invoked 条目（固定唯一 `invocationId`），加载并**完整执行**能力 `hmos-d2a-arkts-logic-completer`。缺失时阻塞，不得以主 Agent 手写替代。
3. 区分"阶段 2 已实现的基础组件状态"与"尚未实现的业务行为"，避免重复绑定事件或创建两套状态源。
4. 补全列表数据、选中态、输入、点击、页面跳转、加载/空/错误态和必要动效；真实接口未提供时遵循需求澄清中的数据策略。
5. 交互不得凭空虚构：设计稿里没有的交互一律标注 `not-applicable` 并给出**"为什么不能做"**（例如设计稿没有对应后续页面），不得只写"未实现"或"留待后续"。设计稿里有点击语义（`<a>`、`<button>`、`onclick`、`data-*` 变体）但 `layout-facts.json` 未覆盖的，回查 `source/html/input.html` 的原始属性，**不得看图像猜**。
6. 保持首帧稳定，异步数据不得导致首帧结构跳变；不破坏内容组件与 Index 注册结构的边界。
7. 写 `stage3-interaction-report.md`，必须包含三张表：
   - **交互映射表**：每个可交互区域（引用 facts 的 `nodeId`）→ 实现位置 → 行为 → 结论（`implemented` / `not-applicable` + 依据）
   - **状态源清单**：每个状态变量列一处来源，说明为什么不存在第二套状态源
   - **修改文件与构建/类型检查结果**
8. `arkts_check` 通过后做一次验证构建（真实执行，用于确认交互改动没有破坏编译）；把能力调用更新为 completed。
9. 调用 `stage-complete --stage 3 --result passed`。

## 必需产物

```text
<designToArktsRunDir>/
├── stage3-interaction-report.md
└── capability-invocation-ledger.json   # hmos-d2a-arkts-logic-completer 为 completed
```

## 完成条件

- `stage3-interaction-report.md` 存在，且交互映射表中**每个可交互区域都有结论**：`implemented` 或 `not-applicable`（附"为什么不能做"）；不存在"未实现但留待后续"的含糊表述。
- 状态源清单证明没有重复状态源；tab 选中态等由路由或单一状态表达，不引入第二套来源。
- `capability-invocation-ledger.json` 中 `hmos-d2a-arkts-logic-completer` 记录为 `completed`。
- `arkts_check` 无错误，验证构建通过。
- **未改动**阶段 2 五份快照文件中的属性取值（`component-tree.md`、`design-doc.md`、`stage1/visual-spec.json`、`stage1/layout-facts.json`、`stage2/component-analysis.md`），也未新增假系统 UI。

通过后调用：

```text
workflow.mjs --mode stage-complete --run-dir <designToArktsRunDir> --stage 3 --result passed
```

能力不可用、构建无法修复时使用稳定 reason code 完成 blocked。