# 02 - HTML 设计转换 arkts 代码

## 阶段元数据

- id: 02
- title: 02 - HTML 设计转换 arkts 代码
- variant: fast
- designSource: others-html
- instruction: references/others-html/fast/stages/02-convert-html-to-arkui.md
- 必用能力：`hmos-d2a-solution-design`（仅用于生成 `design-doc.md`）
- 子 Agent: 无

## 强制阶段入口 Todo 同步

读取 `stage-start.todoPayloadPath`，将 `.todos` 原样调用一次 `todowrite`；成功前不得执行阶段工作。

## 目标

一次完成分析与实现：按 `stage1/layout-facts.json` 的节点与取值直译出 ArkUI 页面，产出组件树与设计文档，接入真实资源与页面注册，并完成初次构建。

## 必需输入

- 冻结后的 HTML 源（`inputs-manifest.htmlSource.path`）与其同级资源（`image/`、`css/`、`js/` 等，名称随设计源）
- `stage1/layout-facts.json`（唯一数值真值）与 `stage1/visual-spec.json`（语义）
- `inputs-manifest.json`（尤其 `integrationSnapshot`）与 `requirement-clarification.json`

## 原点与窗口决策（实现前必做）

先读 `stage1/visual-spec.json.canvasIncludesSystemBar`（缺失时按 `layout-facts.json.render.statusBarVp > 0` 推导）、`layout-facts.json` 中首个前景内容的 `rect.y`（Y）、`requirement-clarification.systemUiPreference.immersiveRequired`。令 D = 设计画板是否含系统栏带，A = 窗口是否沉浸，R = 运行时状态栏高（`window.getWindowAvoidArea(TYPE_SYSTEM)`）：

| D | A | 页面/前景原点 | top padding | 约束 |
|---|---|---|---|---|
| 1 | 1 | 屏幕 0 | `Y` | 窗口全屏 + 状态栏透明/亮色；背景层从 0 绘制；内容不得再叠 R |
| 1 | 0 | 安全区顶 | `Y − R` | 顶带不可复现：如实写 deviation 或 blocked，不得伪造 |
| 0 | 0 | 安全区顶 | `Y` | 默认；不加假状态栏/dock |
| 0 | 1 | 屏幕 0 | `R + Y` | 仅在用户明确要求全屏时；背景/系统栏按 requirement |

- D=1 且要求背景延伸/沉浸 → A=1；D=0 默认 A=0；D=1+A=0 只能 deviation/blocked。
- 窗口配置写在 `EntryAbility.onWindowStageCreate`：先 `setWindowLayoutFullScreen(true)`，再 `setWindowSystemBarProperties`；保持 `loadContent('pages/Index')` 路由值不变；允许改宿主 `Index.ets` 容器（保唯一 `@Entry`）。
- `expandSafeArea` 不移动子组件、只扩绘制；不得替代窗口全屏；只能用在背景层。
- 全屏后页面根仍从安全区起算时，优先 `ignoreLayoutSafeArea`；否则按 D=1+A=0 记 deviation。R 必须运行时读取，禁止硬编码。

## 执行

1. 向 `<designToArktsFastRunDir>/capability-invocation-ledger.json` 追加 `hmos-d2a-solution-design` 的 invoked 条目并固定唯一 `invocationId`。
2. 写 `stage2/project-analysis.md`：工程范式、目标模块、页面目录、注册现状、`arkts_check` 与构建命令。
3. 写 `stage2/component-analysis.md`：按 facts 的节点分组记录每个区域——对应 `nodeId`、采用容器、关键取值出处、`systemUi` 处理、降级与备选。**每个区域必须引用 `nodeId`**。
4. 归纳 `component-tree.md`：每层容器写映射依据（`display` / `flex-direction` / `position` / `overflow` 原值），叶子节点标 `nodeId`；`bbox` 一律取 facts 的 `rect`，顺序固定 `[x, y, w, h]`（逻辑 vp）。
5. 加载并**完整执行** `hmos-d2a-solution-design`，按模板生成 `design-doc.md`；视觉取值必须标注 `nodeId`，与 `visual-spec.unknowns` 冲突时显式记录"facts 测得 X / 判断应为 Z / 依据 Y"。
6. 容器映射与组件选型参考 `references/capabilities/hmos-d2a-react-to-arkui/references/arkui-knowledge-base/` 与 `arkui-common-issues.md`（只读参考，不加载该能力）。
7. 实现静态页面：新建 `export struct`，**不得声明 `@Entry`**；数值取自 facts；`visual-spec.systemUi` 中 `decision=not-implemented` 的节点不得实现；页面原点、窗口沉浸与背景延伸按上方「原点与窗口决策」表执行。
8. 接入资源：先跑 `scripts/html-assets-materialize.mjs`（data-URI 渐变/蒙版的解码、归一化、配方与去重由它完成，unknowns 按事实登记后自行翻译），产物与 facts 中带 `imageSrc` 的节点对应资源复制进 `media/`，写 `stage2/image-assets-manifest.json`；超过 4 MB 或 16 MP 的图片必须等比缩小并记录 `originalSize` / `deliveredSize` / `resizeReason`。
9. 页面注册沿用工程现状、**不改默认页**：`route-table` 追加 `name` + `buildFunction` + `pageSourceFile`；`index-navigation` 在**单个** `.navDestination(builder)` 内追加分支；两者互斥。**允许**在 `EntryAbility.onWindowStageCreate` 增加窗口级沉浸配置；`loadContent` 的页面路由值、`main_pages.json` 与既有默认展示页不得改动。
10. 写 `stage2/generated-ui-manifest.json`（含 `page`/`registration`/`startup`/`reachability`；`registration` 记 `file`（注册位置）/`mode`/`route`/`default`）与 `stage2/integration-report.md`、`stage2/implementation-report.md`。
11. `arkts_check` 通过后执行初次构建，写 `stage2/initial-build-report.json`（四字段取自真实执行）。
12. 把能力调用更新为 completed，调用 `stage-complete --stage 2 --result passed`。

## 必需产物

```text
<designToArktsFastRunDir>/
├── component-tree.md
├── design-doc.md
└── stage2/
    ├── project-analysis.md
    ├── component-analysis.md
    ├── implementation-report.md
    ├── image-assets-manifest.json
    ├── generated-ui-manifest.json
    ├── integration-report.md
    └── initial-build-report.json
```

## 完成条件

- 目标页面为可导出 `@Component`、**无 `@Entry`**；`Index.ets` 保留唯一 `@Entry`；`loadContent` 的路由值 / `main_pages` / 磁盘文件名三处一致且未被改动；`onWindowStageCreate` 允许新增窗口配置。
- 注册方式与 `integrationSnapshot.registrationMode` 一致；`routerMap` 与 `.navDestination(builder)` 不同时存在；默认展示页未变。
- `generated-ui-manifest.registration.file` 记录实际注册位置（`route-table` → 路由表文件；`index-navigation` → 含 `.navDestination` 的文件），不得留空。
- 每个参与布局的 facts 节点在代码中有对应取值（尺寸/字号 ±1vp、圆角归一化后 ±1vp、颜色每通道 ±3）。例外：`systemUi` 节点中 Controller 推导为 `not-implemented` 且几何带内复算通过者，其文本与字号不要求落地。文本必须**整值落地**（string 资源值与 facts 文本逐字相等，或页面独立引号字面量；子串不算）；动态拼接文本须在 `stage2/generated-ui-manifest.json` 登记 `textLandingDeclarations` glob 模板（每条去掉 `*` 后 ≥2 个字面字符、≤5 条、带 basis）。
- `visual-spec` 中 `decision=not-implemented` 的节点在实现中不存在。
- 资源完整，超过阈值的图已缩小并记录。
- `arkts_check` 无错误，`initial-build-report.json` 四字段真实且 `exitCode=0`。

通过后调用：

```text
workflow.mjs --mode stage-complete --run-dir <designToArktsFastRunDir> --stage 2 --result passed
```

注册冲突、资源缺失、构建无法修复时使用稳定 reason code 完成 blocked。