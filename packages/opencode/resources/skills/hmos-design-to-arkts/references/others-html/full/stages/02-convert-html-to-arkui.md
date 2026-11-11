# 02 - HTML 设计转换 arkts 代码（需人工确认）

## 阶段元数据

- id: 02
- title: 02 - HTML 设计转换 arkts 代码（需人工确认）
- variant: full
- designSource: others-html
- instruction: references/others-html/full/stages/02-convert-html-to-arkui.md
- requiresConfirmation: true
- confirmationContinuesStage: true
- 必用能力：`hmos-d2a-solution-design`（仅用于生成 `design-doc.md`）
- 子 Agent: 无

## 强制阶段入口 Todo 同步

首次进入本阶段时，读取 `stage-start.todoPayloadPath`，把 `.todos` 原样调用一次 `todowrite`，成功后才能执行。用户确认后 Controller 返回 `resume_confirmed_stage`；这是**同一阶段的中段续跑**，禁止再次 `stage-start`，也禁止重放 Todo。

## 目标

把 `stage1/layout-facts.json` 的**节点与取值**直译为 ArkUI 页面：容器由 CSS 的布局语义映射（`display:flex` + `flex-direction` → `Row`/`Column`，绝对定位重叠 → `Stack`，可滚动容器 → `List`/`Scroll`），尺寸/字号/颜色/圆角**一律取自 facts**。产出组件树与设计文档，经一次人工确认后完成静态布局、资源接入与页面注册。

本阶段的输入只有 `stage1/layout-facts.json` 与冻结后的 HTML 源（路径见 `inputs-manifest.htmlSource.path`）；不把 HTML 代码复制进工程源码。

## 必需输入

- 冻结后的 HTML 源（`inputs-manifest.htmlSource.path`）与其同级资源（`image/`、`css/`、`js/` 等，名称随设计源）
- `stage1/layout-facts.json`（唯一数值真值）
- `stage1/visual-spec.json`（只有语义：角色命名、系统 UI 决策、未实现项、unknowns）
- `source/html/reference/`（参考集，只用于人类查看与后续校准）
- `inputs-manifest.json`（尤其 `integrationSnapshot`）
- `requirement-clarification.json`（用户偏好：HDS、数据来源、避让区要求）

## 执行顺序

### A. 确认前（只出分析与设计，不写页面）

开始时读取或创建 `stage2/hmos-d2a-solution-design-run.json`，固定 `invocationId`，并维护 `phase`（`analyzing` → `awaiting_confirmation` → `implementing` → `validating` → `completed`）。恢复时以该文件和 Controller 状态共同决定动作：不得因为 Compaction 重做已完成分析、重复请求确认或覆盖已生成页面。

1. 向 `<designToArktsRunDir>/capability-invocation-ledger.json` 追加 `hmos-d2a-solution-design` 的 invoked 条目并固定唯一 `invocationId`。
2. 写 `stage2/project-analysis.md`：工程范式（状态管理版本、既有页面、资源前缀规范）、目标模块、页面目录、注册现状（`integrationSnapshot` 的复核）、`arkts_check` / 构建命令。
3. 写 `stage2/component-analysis.md`：按 `layout-facts` 的**节点分组**（自上而下的主要区域）记录——区域对应哪些 `nodeId`、采用什么 ArkUI 容器、关键取值来自哪个 `nodeId`、`systemUi` 节点如何处理、降级与备选。**每个区域必须引用 `nodeId`，不得只写"约 118vp"这类无出处的数**；被 `systemUi` 豁免的文本（状态栏时间一类）在此列明。
4. 归纳 `component-tree.md`：树形结构 + 每层容器的**映射依据**（`display` / `flex-direction` / `position` / `overflow` 的原始值）+ 每个叶子节点的 `nodeId` 与关键取值。`bbox` 一律写 facts 的 `rect`，字段顺序固定为 `[x, y, w, h]`（逻辑 vp）。
5. 加载并**完整执行** `hmos-d2a-solution-design`（注册表 → references/capabilities/hmos-d2a-solution-design/INSTRUCTIONS.md），传入 orchestration context：`orchestrator=hmos-design-to-arkts`、`workflowStage=2`、`confirmationPolicy=manual`、`runStatePath=<runDir>/stage2/hmos-d2a-solution-design-run.json`、`design_source=others-html`、`component_analysis_path=stage2/component-analysis.md`、`visual_spec_path=stage1/visual-spec.json`、`reference_screenshot_path=source/html/reference/reference-00.png`、`component_tree_path=component-tree.md`、`project_analysis_path=stage2/project-analysis.md`、`requirement_clarification_path=requirement-clarification.json`、`save_path=design-doc.md`。参数值必须使用相对本次运行目录或工程根目录的路径，不得在能力中拼接或写死本机绝对路径。文中所有视觉取值必须标注来源 `nodeId`；与 `visual-spec.unknowns` 冲突时，在设计文档里显式记录"facts 测得 X / 判断应为 Z / 依据 Y"。
6. ArkUI 组件选型与常见问题核对时，只读参考 `references/capabilities/hmos-d2a-react-to-arkui/references/arkui-knowledge-base/` 下的卡片（`matching.md`、`api-cards/*`）与 `references/capabilities/hmos-d2a-react-to-arkui/references/arkui-common-issues.md`。**不得加载 `hmos-d2a-react-to-arkui` 能力、不得按其 JSX 流程执行**，也不得写 `page.jsx`。
7. 写 `stage2/visual-spec-review.json`：逐条给 `visual-spec` 的 `roles` / `systemUi` / `notImplemented` 一个落地结论（`implemented` / `not-implemented` / `needs-verification` + 依据）。发现 `visual-spec` 试图表达数值时，**拒绝并记录**，不得按它改取值。
8. 把 run phase 设为 `awaiting_confirmation`，然后调用：

```text
workflow.mjs --mode confirm --run-dir <designToArktsRunDir> --stage 2 --decision request
```

### B. 确认后（实现）

9. 用户确认时调用 `confirm --decision accepted`。Controller 只有在**五个待确认文件**与 snapshot 完全一致时才接受；返回 `resume_confirmed_stage` 后直接继续本文件余下步骤。用户要求修订时调用 `revision-requested`，按返回的 `stage_start` 重进本阶段，只改文档、不重跑阶段 1 取证。
10. 生成本阶段的确认记录 `stage2/component-confirmation.json`：`decision`、`confirmedArtifacts`（五个文件路径）、`acceptedAt`（**先跑时钟读取命令**取值，禁止估读、不得手写整点值；不得早于 Controller 确认快照时刻，Controller 会与文件写入时刻对账）。该文件的实际内容以 Controller snapshot 为准，本文件只作索引。
11. 实现静态页面：新建可导出 `@Component`（`export struct ...`），页面文件**不得声明 `@Entry`**。逐个容器按第 4 步的映射依据落地；数值取自 facts；`systemUi` 中 `decision=not-implemented` 的节点（状态栏时间、信号图标、手势条等）**不得实现**；页面原点、窗口沉浸与背景延伸按上方「原点与窗口决策」表执行。
12. 接入真实资源：先跑 `scripts/html-assets-materialize.mjs --facts <runDir>/stage1/layout-facts.json --out <runDir>/stage2/assets-materialized`——data-URI 渐变与圆形蒙版的解码、归一化（`rgba()`/浮点通道，否则 ArkUI 渲染成黑）、裁剪配方与去重都由它完成，`materialize.json` 直接并入 manifest，unknowns 条目按事实登记后自行翻译（**不要回读 HTML 手写 CSS 解析器**）。**渐变层默认按 manifest 的 `gradientRecipe`（angle / 停点 / radiusVp 已含 gradientTransform 的逆映射窗口化与 pad 重采样）以原生 `.linearGradient` 实现**——recipe 经 Chromium 参考渲染对拍校准（中心点差 ≤1，剪切变换角点残差 ≤15%，最终以 probe 验证为准）；`.bg.svg` 直接接入 Image 仅在 probe 验证渲染正确后允许（例外登记 manifest，如 n0009 一类简单渐变实测可用）。然后把产物与 facts 中带 `imageSrc` 的节点对应资源复制进 `entry/src/main/resources/base/media/`（保持稳定命名，带业务前缀），写 `stage2/image-assets-manifest.json`（资源名 ↔ facts `nodeId` ↔ 设计源相对路径）。**超过 4 MB 或 16 MP 的图片必须等比缩小后接入，并在 manifest 里记录 `originalSize` / `deliveredSize` / `resizeReason`**；未缩放的巨图会导致 ArkUI 解码失败并在页面上显示空白。
13. 写 `stage2/implementation-report.md`：实现清单、逐区域"设计取值来源 `nodeId` → 代码位置"对照、与设计文档的差异（三类：`code-missing` / `code-extra` / `doc-likely-wrong`）、已知限制。
14. 页面注册（**沿用工程现状，不改默认页**）：
    - 工程 `registrationMode=route-table`：在既有 `router_map.json` 追加 `name` + `buildFunction` + `pageSourceFile`，并在目标页导出 `@Builder export function <Name>Builder()`。字段名以工程实际可编译为准（**当前工程实测为 `buildFunction`，不是 `buildMethod`**）。
    - 工程 `registrationMode=index-navigation`：在既有 `Navigation` 的**单个** `.navDestination(builder)` 内追加 `if/else` 分支（禁止链式多次 `.navDestination`）。
    - **两者互斥**：已有 `routerMap` 时不得再挂 `.navDestination(builder)`。
    - **允许**在 `EntryAbility.onWindowStageCreate` 增加窗口级沉浸配置（`setWindowLayoutFullScreen` / `setWindowSystemBarProperties`）；`loadContent` 的页面路由值、`main_pages.json` 与既有默认展示页不得改动。
15. 记录可达性到 `stage2/generated-ui-manifest.json`：`reachability` 取 `entry-point-exists`（工程已有指向本页的入口或用户会接入）或 `requires-temporary-preview`（暂无入口，阶段 5 允许临时预览截图后恢复）。**不得为了让页面可见而擅自更改默认页**。
16. `arkts_check` 通过后执行初次构建，写 `stage2/initial-build-report.json`（`success`、`command`、`exitCode`、`completedAt` 四字段取自真实执行）。
17. 写 `stage2/integration-report.md`：新增页面文件、注册修改位置与方式、本次路由、`loadContent`/`main_pages`/文件名的三处一致性结论、历史页面保留情况、资源接入汇总。
18. 把能力调用更新为 completed，phase 设为 `completed`，然后调用 `stage-complete 2`。

## 原点与窗口决策（实现前必做）

先读 `stage1/visual-spec.json.canvasIncludesSystemBar`（缺失时按 `layout-facts.json.render.statusBarVp > 0` 推导）、`layout-facts.json` 中首个前景内容的 `rect.y`（记为 Y）、`requirement-clarification.systemUiPreference.immersiveRequired`。令 D = 设计画板是否含系统栏带，A = 窗口是否沉浸，R = 运行时状态栏高（`window.getWindowAvoidArea(TYPE_SYSTEM)`）。按表实现：

| D | A | 页面/前景原点 | top padding | 约束 |
|---|---|---|---|---|
| 1 | 1 | 屏幕 0 | `Y` | 窗口全屏 + 状态栏透明/亮色；背景层从 0 绘制；内容不得再叠 R |
| 1 | 0 | 安全区顶 | `Y − R` | 顶带不可复现：如实写 deviation 或 blocked，不得用背景层/纯色伪造 |
| 0 | 0 | 安全区顶 | `Y` | 默认；不加假状态栏/dock |
| 0 | 1 | 屏幕 0 | `R + Y` | 仅在用户明确要求全屏时；背景/系统栏按 requirement |

- A 不是模型自选：D=1 且要求背景延伸/沉浸 → A=1；D=0 默认 A=0；D=1+A=0 只能 deviation/blocked。
- 窗口级配置写在 `EntryAbility.onWindowStageCreate`：先 `setWindowLayoutFullScreen(true)`，再 `setWindowSystemBarProperties`（透明状态栏 + 与设计同侧的内容色）；保持 `loadContent('pages/Index')` 的路由值不变。
- 允许改宿主 `Index.ets` 的容器（保唯一 `@Entry`）让页面从屏幕原点布局；不得改默认展示页。
- `expandSafeArea` 不移动子组件、只扩绘制；不得用它替代窗口全屏；只能用在背景层；若背景容器直接承载前景子组件，必须另加安全区消费层。
- 若全屏后页面根仍从安全区起算，优先用 `ignoreLayoutSafeArea`（SDK 支持时）做布局；否则按 D=1+A=0 记 deviation，不得硬改。
- R 必须运行时读取；禁止硬编码状态栏高度。

## 容器映射规则（必须按依据，不得凭直觉）

| CSS 事实 | ArkUI 产出 | 约束 |
|---|---|---|
| `display:flex` + `flex-direction:row` | `Row` | 间距用 `space`，须等于 facts 中相邻子项的 rect 差 |
| `display:flex` + `flex-direction:column` | `Column` | 同上 |
| 子项 `position:absolute` 且互相重叠 | `Stack` | 定位用相对父容器的 `rect` 差值，禁止整页绝对坐标堆叠 |
| 容器 `overflow:auto/scroll` | `List`（同构重复项）或 `Scroll` | 首屏可见区域与参考集首帧一致 |
| 重复结构（≥3 个同尺寸同间距兄弟） | `ForEach` + 显式 key | key 用 `nodeId` 或业务 id，禁止用索引 |
| 纯装饰（无交互、无文本） | 背景属性或 `Image` | 不得为它新建组件文件 |

**禁止**：把 `page.jsx` 或 HTML 片段复制进工程；用"常见 App 习惯"补 facts 里没有的数值；为了让容器好写而合并或拆散 facts 的层级而不在设计文档里记录。

## 必需产物

```text
<designToArktsRunDir>/
├── component-tree.md
├── design-doc.md
└── stage2/
    ├── hmos-d2a-solution-design-run.json
    ├── project-analysis.md
    ├── component-analysis.md
    ├── visual-spec-review.json
    ├── component-confirmation.json
    ├── implementation-report.md
    ├── image-assets-manifest.json
    ├── generated-ui-manifest.json
    ├── integration-report.md
    └── initial-build-report.json
```

`stage2/generated-ui-manifest.json` 至少包含：

```json
{
  "page": { "file": "entry/src/main/ets/pages/XxxPage.ets", "component": "XxxPage", "hasEntry": false },
  "registration": { "file": "<注册位置>", "mode": "route-table | index-navigation | existing-router", "route": "<路由名>", "default": false },
  "startup": { "indexFile": "entry/src/main/ets/pages/Index.ets", "entryAbilityPage": "pages/Index", "mainPagesContainsIndex": true },
  "reachability": "entry-point-exists | requires-temporary-preview",
  "factsPath": "stage1/layout-facts.json",
  "assetsManifest": "stage2/image-assets-manifest.json"
}
```

## 完成条件

- 确认流程完整：`confirm --decision request` → `accepted` → `resume_confirmed_stage` 后**在同一阶段**继续实现，未再次 `stage-start`。
- Controller snapshot 恰好包含 `component-tree.md`、`design-doc.md`、`stage1/visual-spec.json`、`stage1/layout-facts.json`、`stage2/component-analysis.md` 五个文件；确认后任一文件被改动都必须重新确认。
- 目标页面为可导出 `@Component`、**无 `@Entry`**；`Index.ets` 仍保留唯一 `@Entry`；`EntryAbility.loadContent` 的页面路由值、`main_pages.json` 注册名与磁盘文件名**三处一致**且未被改动；`EntryAbility.onWindowStageCreate` 允许新增窗口配置。
- 页面注册与 `integrationSnapshot.registrationMode` 一致；`routerMap` 与 `.navDestination(builder)` 不同时存在；默认展示页未变。
- `generated-ui-manifest.registration.file` 记录实际注册位置（`route-table` → 路由表文件；`index-navigation` → 含 `.navDestination` 的文件），不得留空。
- 每个参与布局的 facts 节点在页面代码中有对应取值（尺寸 ±1vp、字号 ±1vp、圆角按 `min(radius, h/2)` 归一化后 ±1vp、颜色每通道 ±3 且 alpha ±0.02）。例外：`systemUi` 节点中 Controller 推导为 `not-implemented` 且几何带内复算通过者，其文本与字号**不要求落地**（设计稿状态栏时间不再需要注册永不引用的死资源）；被豁免的文本须在 `stage2/component-analysis.md` 列明，让确认时可见。**文本必须整值落地**：string 资源值与 facts 文本逐字相等、或页面内独立引号字面量——长资源值的**子串不算**（"OK" 落在 "BOOKING" 里不算实现）；动态拼接文本（如 `` `${n} 分钟前` `` 一类没有单一精确资源的）须在 `stage2/generated-ui-manifest.json` 顶层登记 `textLandingDeclarations: [{ "pattern": "* 分钟前", "basis": "<为何是动态>" }]`（glob 模板，每条去掉 `*` 后 ≥2 个字面字符、总数 ≤5 条），命中模板即视为落地。
- `visual-spec` 中 `decision=not-implemented` 的节点在实现中不存在（无假状态栏、无假手势条）。
- 资源接入完整：facts 中所有带 `imageSrc` 的节点都有对应媒体资源；超过 4 MB / 16 MP 的图已缩小并记录。
- `arkts_check` 无错误，`initial-build-report.json` 四字段真实且 `exitCode=0`。
- 未生成 `page.jsx`、未调用 `recognize_ui_components`、未把 HTML/JSX 代码复制进工程。

通过后调用：

```text
workflow.mjs --mode stage-complete --run-dir <designToArktsRunDir> --stage 2 --result passed
```

页面注册方式与工程现状冲突、资源缺失、构建无法修复时使用稳定 reason code 完成 blocked。
