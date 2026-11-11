# 02 - 截图设计转换 arkts 代码

## 阶段元数据

- id: 02
- title: 02 - 截图设计转换 arkts 代码
- variant: fast
- designSource: others-visual
- instruction: references/others-visual/fast/stages/02-convert-screenshot-to-arkui.md
- 加载能力 `hmos-d2a-repo-understand`、`hmos-d2a-arkui-component-best-practices`、`hmos-d2a-solution-design`（others-visual 分支）（注册表 → references/capabilities/<能力名>/INSTRUCTIONS.md），并完整执行
- 必用输入: `stage1/component-vision-analysis.json`（阶段 1 由 `recognize_ui_components` 原子写入，本阶段只读）
- 子 Agent: 无
- confirmationPolicy: auto-accept

## 强制阶段入口 Todo 同步

读取 `stage-start.todoPayloadPath` 并把 `.todos` 原样调用一次 `todowrite`；同步成功前不得执行阶段工作。Fast 模式无人工确认，`stage-start` 后直接执行本阶段全部步骤，不存在 `resume_confirmed_stage` 中段续跑。

## 目标

在同一个阶段内完成工程理解、组件实践选择、组件树与设计文档生成、组件方案自动接受和响应式静态页面实现：先加载 `hmos-d2a-repo-understand` 与 `hmos-d2a-arkui-component-best-practices` 建立工程与组件上下文，再调用 `hmos-d2a-solution-design` 的 others-visual 分支产出 `design-doc.md` 与 `component-tree.md`，记录 `decision=auto-accepted` 后直接生成 ArkUI 页面并接入工程、完成初次构建。本阶段只实现从静态设计可确定的响应式布局与基础组件状态，业务交互逻辑留给阶段 3。

## 执行

1. 校验 `inputs-manifest.json`、`input-security-report.json`、`source/visual/screenshot.png`、`stage1/visual-probe.json`、`stage1/component-vision-analysis.json`、`stage1/visual-spec.json`、`requirement-clarification.json` 和目标 ArkUI 工程。`stage1/visual-spec.json` 是本阶段视觉权威，缺失或结构非法时阻塞，不得按项目习惯发明配色、字阶或圆角。**读数只能来自产物，不能来自目测**，所有视觉事实只能来自阶段 1 的识别结果与视觉规格。
2. 在 `<designToArktsFastRunDir>/capability-invocation-ledger.json` 追加 invoked 条目：`{ "capability": "hmos-d2a-repo-understand", "status": "invoked" }`，加载能力 `hmos-d2a-repo-understand`（注册表 → references/capabilities/hmos-d2a-repo-understand/INSTRUCTIONS.md），并完整执行；缺失时阻塞，不得以主 Agent 手写或普通代码搜索替代。覆盖工程结构、入口、路由、状态管理、数据模型、资源目录、构建命令和阶段接入位置，写入 `stage2/project-analysis.md`，把该调用记录更新为 completed。
3. 在 `<designToArktsFastRunDir>/capability-invocation-ledger.json` 追加 invoked 条目：`{ "capability": "hmos-d2a-arkui-component-best-practices", "status": "invoked" }`，读取 `stage1/component-vision-analysis.json`、`stage1/visual-spec.json` 与 `stage2/project-analysis.md`，加载能力 `hmos-d2a-arkui-component-best-practices`（注册表 → references/capabilities/hmos-d2a-arkui-component-best-practices/INSTRUCTIONS.md），并完整执行；缺失时阻塞。覆盖页面根布局、图片/图标约束、底部栏与安全区、视口边界策略和交互组件，写入 `stage2/selected-practices.json`，把该调用记录更新为 completed。
4. 读取并校验阶段 1 的组件识别结果：`schemaVersion=2`、`status=ok`、`producer.tool` 与 `visualEvidenceMode` 一致（`recognize-ui-components` → `recognize_ui_components`，`main-model-vision` → `main-model-vision`），`inputs` 与 `source/visual/screenshot.png` 及阶段 1 requirements 的内容和 SHA-256 一致。本阶段只读该文件，不得重跑识别、手写、改写或拼接结果，不得用 `compare_images` 替代，也不得让无视觉能力的主模型假装读取图片。产物缺失、状态非 `ok`、producer 不符或输入 SHA-256 不一致时本阶段 blocked，不得降级为自造清单。
5. 为 `hmos-d2a-solution-design` 固定 `invocationId` 并在 `<designToArktsFastRunDir>/capability-invocation-ledger.json` 记录 invoked，创建 `stage2/hmos-d2a-solution-design-run.json`（`confirmationPolicy=auto-accept`、`phase=analyzing`，恢复时从现有 phase 继续），加载能力 `hmos-d2a-solution-design`（注册表 → references/capabilities/hmos-d2a-solution-design/INSTRUCTIONS.md），并完整执行其 others-visual 分支，传入 orchestration context：`orchestrator=hmos-design-to-arkts`、`workflowStage=2`、`confirmationPolicy=auto-accept`、`runStatePath=<runDir>/stage2/hmos-d2a-solution-design-run.json`、`design_source=others-visual`、`component_analysis_path=stage1/component-vision-analysis.json`、`visual_spec_path=stage1/visual-spec.json`、`reference_screenshot_path=source/visual/screenshot.png`、`component_tree_path=component-tree.md`、`project_analysis_path=stage2/project-analysis.md`、`requirement_clarification_path=requirement-clarification.json`、`save_path=design-doc.md`。参数值必须使用相对本次运行目录或工程根目录的路径，不得写死本机绝对路径。
6. 完成结构分析：结构信息只能来自 `stage1/visual-spec.json` 的分区 `bands`、色板、字阶、圆角（其数值来自阶段 1 的 `stage1/visual-probe.json`，本阶段不得重新运行 `visual_probe.mjs`，也不得对裁剪区域二次取样），以及识别结果的 `visible_components`、`component_candidates` 与 `visual_evidence`。职责边界固定为：识别结果回答"截图中可见什么及 ArkUI 组件候选"，`stage1/visual-spec.json` 回答"可量化视觉取值"，组件层级、容器类型、父子关系、重复结构和布局语义由 Agent 按组件名称、文本证据与分区语义归纳。不得使用虚构坐标做结构归并；识别结果与视觉规格冲突时记录到 `stage2/component-analysis.md` 的 `uncertainties`，不得静默选择，也不得改写任一上游产物来消除冲突。
7. 写入 `stage2/component-analysis.md`（每个区域记录识别证据、视觉规格证据、采用组件、关键参数、状态、备选和降级原因），归纳组件树并写 `<designToArktsFastRunDir>/component-tree.md`：纵向 `y`/`h` 由 `stage1/visual-spec.json` 的 `bands`（heightRatio 累积）推导，横向 `x`/`w` 只能来自组件容器语义（占满父容器、等分、固定内边距），无法确定时写 `"unknown"` 并记入 uncertainties，不得虚构精确坐标；每个节点标注 `bboxPrecision: "approximate"`，不确定的区域记录到组件树 uncertainties；`system-ui-policy.json` 与 `viewport-boundary-spec.json` 只能由 `stage1/visual-spec.json` 的 `bands` 分区、`component-vision-analysis.json` 中带 `visual_evidence` 的系统 UI 组件、工程实际安全区三类证据推导，判不出时写 `unknown` 并记入 `uncertainties`，不得凭常见 App 习惯硬填，不得虚构精确位置。由步骤 5 的能力按 `save_path=design-doc.md` 生成 `<designToArktsFastRunDir>/design-doc.md`，内容必须与 `component-tree.md` 和同一份分析一致；同时根据截图中的假系统 UI、根画布和工程实际安全区生成 `<designToArktsFastRunDir>/system-ui-policy.json` 与 `<designToArktsFastRunDir>/viewport-boundary-spec.json`。
8. 校验 `design-doc.md`：读取 `hmos-d2a-solution-design` 能力目录下 `assets/template-ui-page.md` 模板核对章节结构与关键字段，确认无模板占位符、组件树与 `component-tree.md` 完全一致、`bboxPrecision: "approximate"` 标注到位；**并逐项核对设计文档中的背景/配色/字阶/圆角与 `stage1/visual-spec.json` 一致**（含 `unknown` 项的处理说明），出现自造色值或与 spec 冲突时按产物不合法重做。校验通过后把首选方案记录为 `stage2/component-confirmation.json`，其 decision 为 `auto-accepted`；不得调用 Controller `confirm`，也不得向用户展示确认等待。
9. 把 run phase 设为 `implementing`，按方案生成不会覆盖历史产物的独立、可导出 `@Component` 页面（`export struct XxxPage`），写入 `entry/src/main/ets/pages/`，页面不得声明 `@Entry`。保留 `Index.ets` 唯一启动 `@Entry`，按项目现有模式（Navigation/NavDestination、集中路由表或等价页面注册结构）将新页面追加注册到工程；禁止把完整页面代码复制进 Index、删除 Index、把 `loadContent` 指向目标页面、新增竞争性 `@Entry` 或修改 `EntryAbility` 绕过 Index。使用 `Navigation + NavPathStack` 时，空路由栈下 `Index` 内容区域仍须同步显示有效首页，禁止依赖 `constructor`/`aboutToAppear`/`onAppear` 中的首次路由推入来显示默认页。布局用 Column、Row、Flex、Grid、List、Scroll、Tabs、Navigation/NavDestination 等容器表达层次、间距与安全区约束，不得把整页 absolute 坐标机械翻译为 `.position()`；图片、SVG、图标统一转为项目资源引用（如 `$r('app.media.xxx')`），不得保留假状态栏、假 Home Indicator 或占位资源；实现过程中不得重设已确认的组件树或核心契约（视觉取值以 `stage1/visual-spec.json` 为准）。
10. 把 phase 设为 `validating`，执行初次构建并局部修复，写入 `stage2/initial-build-report.json`。缺少 `devecocli` 等构建工具时按权限边界报告/请求授权，不得静默全局安装；不得通过删除真实 UI、替换占位块或降级组件来通过构建。
11. 写入 `stage2/implementation-report.md`、`stage2/image-assets-manifest.json`、`stage2/integration-report.md`、`stage2/generated-ui-manifest.json`，把 `<designToArktsFastRunDir>/capability-invocation-ledger.json` 中同一 invocation 的 `hmos-d2a-solution-design` 更新为 completed，最后把 phase 设为 `completed`。

## 历史页面与冲突管理

本来源的 run-index 记录由 Controller 在阶段 2 通过后自动写入（从 `stage2/generated-ui-manifest.json` 推导，与其他来源共用 `.deveco/design-to-arkts-fast/run-index.json`）；Agent 不得手写或改写该索引。页面身份以阶段 1 的工程接入快照（`inputs-manifest.json.integrationSnapshot`，其中 `existingGeneratedPages` 即读自 run-index）、`component-tree.md` 与实际工程文件共同确定：文件名、组件名和路由必须与工程现状同时比对，同名但来源或内容不同时生成稳定新名称或 blocked，不得静默覆盖历史页面、默认入口和既有路由。

## 必需产物

```text
<designToArktsFastRunDir>/
├── stage2/
│   ├── hmos-d2a-solution-design-run.json
│   ├── project-analysis.md
│   ├── selected-practices.json
│   ├── component-analysis.md
│   ├── component-confirmation.json
│   ├── implementation-report.md
│   ├── image-assets-manifest.json
│   ├── integration-report.md
│   ├── initial-build-report.json
│   └── generated-ui-manifest.json
├── design-doc.md
├── component-tree.md
├── system-ui-policy.json
├── viewport-boundary-spec.json
└── capability-invocation-ledger.json
entry/src/main/ets/pages/<XxxPage>.ets      # 每页一个，独立、可导出 @Component，不含 @Entry
```

`generated-ui-manifest.json` 记录页面与注册关系（`page.file`/`page.component`/`page.hasEntry=false`、`registration.file`/`component`/`mode`/`route`/`default`、`startup.indexFile`/`entryAbilityPage=pages/Index`/`mainPagesContainsIndex=true`），并记录 `userVisibleStrings`（页面渲染的每一条用户可见字符串，每条都能在 `stage1/visual-spec.json.textInventory` 找到出处）与 `inferredStrings`（只被 `inferred` 条目覆盖的字符串）。`integration-report.md` 同时记录新增页面文件、Index 或路由表修改位置、本次路由、历史页面保留情况、EntryAbility 和 main_pages 前后值以及截图与 `stage1/visual-spec.json` 的 SHA-256。

`initial-build-report.json` 是初次构建的唯一规范产物，必须使用以下最小 schema（全部字段必填）：

```json
{
  "success": true,
  "command": "实际执行的构建命令",
  "exitCode": 0,
  "completedAt": "ISO-8601 时间"
}
```

Controller 会校验文件存在且可解析、`success === true`、`command` 为非空字符串、`exitCode === 0`、`completedAt` 为合法时间字符串；任一不满足即拒绝完成阶段 2。

## 完成条件

- `design-doc.md` 存在、内容来自 `hmos-d2a-solution-design` others-visual 分支（非 Agent 手写），组件树与 `component-tree.md` 完全一致，无模板占位符；背景/配色/字阶/圆角与 `stage1/visual-spec.json` 逐项一致（`unknown` 项标注为待定并给出实现取值依据，不得静默改值）。
- 组件树与 `stage1/component-vision-analysis.json` 的识别结果一致；近似 bbox 均有 `bboxPrecision: "approximate"` 标注，且 **`bbox` 统一为 `[x, y, w, h]`**（逻辑 vp），全文件不得混用其他四元组语义。
- `stage2/component-confirmation.json.decision=auto-accepted`，未请求人工确认。
- `stage2/project-analysis.md` 与 `stage2/selected-practices.json` 存在且记录完整，对应能力调用在 ledger 中为 completed。
- `stage2/hmos-d2a-solution-design-run.json.phase=completed`，ledger 有同一 invocationId 的 completed 证据。
- 页面文件存在且可导出 `@Component`，不含 `@Entry`；`Index.ets` 仍保留唯一启动 `@Entry`，新页面已按项目现有模式注册，既有页面与默认入口未被覆盖；`EntryAbility` 仍加载 `pages/Index`，`main_pages.json` 仍包含 `pages/Index`。
- 使用 Navigation 时其首页内容区域非空；默认页面无需生命周期中的首次路由推入，即可在空 `NavPathStack` 下同步显示。
- 资源真实存在（无占位图、无假状态栏、无假 Home Indicator），初次构建通过（`stage2/initial-build-report.json` 可解析、`success === true`、`command` 非空、`exitCode === 0`、`completedAt` 为合法时间）。
- `generated-ui-manifest.json` 与实际页面文件和注册位置一致（含 `registration.route` 与 `registration.file`）；`run-index.json` 由 Controller 在阶段 2 通过后写入，Agent 不得手写或改写。
- `generated-ui-manifest.json.userVisibleStrings` 已列出页面全部可见字符串，且每条都能在 `stage1/visual-spec.json.textInventory` 找到出处；来自 `inferred` 条目的字符串已列进 `inferredStrings`。

满足全部完成条件后调用：

```text
workflow.mjs --mode stage-complete --run-dir <designToArktsFastRunDir> --stage 2 --result passed
```

能力缺失、输入不合法、视觉产物不可用、产物校验失败或构建无法修复时完成 blocked，并使用稳定 reason code；不得使用旧 Pixso 脚本或普通手写流程替代。
