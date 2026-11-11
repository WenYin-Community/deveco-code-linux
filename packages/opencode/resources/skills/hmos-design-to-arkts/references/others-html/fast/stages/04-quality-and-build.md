# 04 - 完成 HDS 适配、质量审计与最终构建

## 阶段元数据

- id: 04
- title: 04 - 完成 HDS 适配、质量审计与最终构建
- variant: fast
- designSource: others-html
- instruction: references/others-html/fast/stages/04-quality-and-build.md
- 必用能力：ArkTS 代码质量能力；需要 HDS 时使用 `hmos-d2a-arkui2hds`
- 子 Agent: 可用于审计，但主 Agent 负责最终产物和 `<designToArktsFastRunDir>/capability-invocation-ledger.json`

## 强制阶段入口 Todo 同步

读取 `stage-start.todoPayloadPath`，将 `.todos` 原样调用一次 `todowrite`；成功前不得执行阶段工作。

## 目标

在阶段 2 的静态布局与阶段 3 的业务交互之上落实 HDS 决策，完成八项质量审计与最终构建。**不重新设计页面结构，不通过降级实现通过审计。**

## 执行

1. 读取阶段 2/3 的最终代码、`component-tree.md`、`design-doc.md`、`stage2/image-assets-manifest.json`、`stage2/initial-build-report.json`、`stage3-interaction-report.md`、`stage1/layout-facts.json`、`stage1/visual-spec.json` 与 `requirement-clarification.json`。
2. 写 `hds-decision.json`：`hdsRequired` 必须与 `requirement-clarification.hdsUsagePreference` 一致（`do-not-use-hds` → `false` 且给出用户原话依据）。`hdsRequired=true` 时加载 `hmos-d2a-arkui2hds` 能力并完整执行，在 ledger 记录同一 `invocationId` 的 invoked 与 completed；`false` 时记录可审计的不调用理由，**不得伪造该能力调用**。
3. 调用会话可用的 ArkTS 代码质量能力，修复类型、状态、生命周期、资源、路由与 API 使用问题；不得通过删除真实 UI、替换占位块或降级组件来通过构建。
4. 独立执行八项审计并写 `stage4/quality-audit.json` 与 `stage4/quality-audit.md`：
   1. **结构与取值**：逐区域核对实现取值来源 `nodeId`；任何与 `layout-facts.json` 不一致的取值必须列为 issue
   2. **HDS 决策落实**
   3. **系统 UI 与原点**：`visual-spec.systemUi` 中 `decision=not-implemented` 的节点在代码中不存在；无假状态栏、无假 Home Indicator；按阶段 2「原点与窗口决策」表核对：D=1+A=1 必须有窗口全屏 + 透明状态栏，背景层从屏幕 0 绘制；D=1+A=0 必须如实记 deviation/blocked，不得用背景层或纯色伪造；D=0 不得新增假状态栏/dock
   4. **安全区与视口**：避让区高度取自运行时（`window.getWindowAvoidArea` 等）而非硬编码，且失败有回退值；前景 top padding 必须等于决策表公式（D=1+A=1 → facts Y；D=1+A=0 → Y−R；D=0+A=0 → Y；D=0+A=1 → R+Y），不得出现把绝对 y 当 padding 的混合语义
   5. **顶部碰撞**：内容与系统栏无重叠、可交互元素全部在系统栏之外；首内容屏幕 y 与决策表期望值差 ≤2vp（静态核对代码常量；如需截图证据，在本阶段用 `devecocli ui screenshot` 实测，Fast 无独立校准阶段）
   6. **资源**：全部媒体资源**实测可解码**（用解码脚本，不得只看文件存在）、尺寸在阈值内、无占位块、无文本或纯色块替代图标
   7. **路由**：`loadContent` / `main_pages.json` / 磁盘文件名三处一致；`routerMap` 与 `.navDestination(builder)` 不同时存在；注册名与 `generated-ui-manifest.registration` 一致；默认展示页未变
   8. **代码质量**：质量能力的修复结果与遗留问题
5. 执行 `arkts_check` 与最终构建，失败时正向定位并局部修复后重跑；写 `stage4/build-report.md`（命令、轮次、每次结果、最终 `exitCode`）。
6. 所有 critical/major 清零、HDS 决策落实、八项审计通过、最终构建成功后调用 `stage-complete --stage 4 --result passed`；否则 blocked。

## 必需产物

```text
<designToArktsFastRunDir>/
├── hds-decision.json
└── stage4/
    ├── quality-audit.json
    ├── quality-audit.md
    └── build-report.md
```

`stage4/quality-audit.json` 至少包含：

```json
{
  "schemaVersion": 1,
  "auditedAt": "<ISO，取自系统时间>",
  "criticalIssues": [],
  "majorIssues": [],
  "minorIssues": [],
  "audits": {
    "structureAndValues": { "pass": true, "checks": [] },
    "hds": { "pass": true, "checks": [] },
    "systemUi": { "pass": true, "checks": [] },
    "safeArea": { "pass": true, "checks": [] },
    "topCollision": { "pass": true, "checks": [] },
    "resources": { "pass": true, "checks": [] },
    "routing": { "pass": true, "checks": [] },
    "codeQuality": { "pass": true, "checks": [] }
  },
  "buildResult": { "command": "<实际命令>", "exitCode": 0, "report": "stage4/build-report.md" }
}
```

## 完成条件

- `hds-decision.json.hdsRequired` 与用户偏好一致；`true` 时 ledger 有 `hmos-d2a-arkui2hds` completed，`false` 时有可审计理由且**没有**该能力的伪造记录。
- `stage4/quality-audit.json` 八项审计齐全且 `pass=true`，`criticalIssues` 与 `majorIssues` 为空数组。
- 资源审计是**实测可解码**，不是"文件存在"。
- 路由审计确认三处一致、注册方式互斥、默认页未变。
- `arkts_check` 无错误，最终构建 `exitCode=0`，`stage4/build-report.md` 与实际执行的命令和轮次一致。
- 未新增假系统 UI、未降级实现、未修改阶段 2 的四份快照文件。

通过后调用：

```text
workflow.mjs --mode stage-complete --run-dir <designToArktsFastRunDir> --stage 4 --result passed
```

构建无法修复、资源不可用、质量能力不可用时使用稳定 reason code 完成 blocked。