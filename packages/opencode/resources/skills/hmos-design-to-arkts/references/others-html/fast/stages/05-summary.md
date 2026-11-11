# 05 - 总结

## 阶段元数据

- id: 05
- title: 05 - 总结
- variant: fast
- designSource: others-html
- instruction: references/others-html/fast/stages/05-summary.md
- 子 Agent: 无

## 强制阶段入口 Todo 同步

读取 `stage-start.todoPayloadPath`，将 `.todos` 原样调用一次 `todowrite`；成功前不得执行阶段工作。

## 目标

核对整条 run 的产物链，写出交付报告 `completeness-report.md`。本阶段只做核对与汇总，不改代码；发现缺陷应回到对应阶段修复。

## 执行

1. 核对产物链：`requirement-clarification.json`、`inputs-manifest.json`、`input-security-report.json`、`stage1/layout-facts.json`、`stage1/visual-spec.json`、`inputs-manifest.htmlSource.path` 指向的 HTML 源文件、`source/html/reference/`、`component-tree.md`、`design-doc.md`、`stage2/`（分析、构建报告）、`stage3-interaction-report.md`、`hds-decision.json`、`stage4/quality-audit.json`、`stage4/build-report.md`、`capability-invocation-ledger.json`。
2. 核对工程侧：目标页面存在且无 `@Entry`；`Index.ets` 只有一个 `@Entry`；`loadContent` / `main_pages` / 文件名三处一致；`routerMap` 与 `.navDestination(builder)` 未并存。
3. 核对 `run-index.json`：本 run 记录已由 Controller 在阶段 2 写入，字段与 `stage2/generated-ui-manifest.json` 一致。
4. 核对 ledger：`hmos-d2a-html-to-arkui`、`hmos-d2a-solution-design`、`hmos-d2a-arkts-logic-completer` 均为 completed；`hmos-d2a-arkui2hds` 仅在 `hdsRequired=true` 时出现。
5. 写 `completeness-report.md`，包含：生成/修改文件清单、路由与可达性、功能实现表（引用 `stage3-interaction-report.md` 的结论）、`visibleCoverage` 与"参考图未覆盖的区域"、**权威产物与实现的一致性核对**（写出实现与 `layout-facts.json` 的差异项数并逐条列出未闭合项）、已知限制。
6. 完成后先读取 `workflow-state.json` 的 `todoPayloadPath`，调用 `todowrite` 同步最终 TODO 状态，再调用 `stage-complete --stage 5 --result passed`；本阶段通过即整条 run 完成。

## 必需产物

```text
<designToArktsFastRunDir>/
└── completeness-report.md
```

## 完成条件

- 第 1–4 步核对全部通过；缺失项必须回到对应阶段补齐，不得只在报告里说明。
- `completeness-report.md` 含上述全部小节；"一致性核对"写出差异项数与未闭合项。
- **不得**把"设计文档未被改动"写成合规优点，也不得用"忽略差异""近似等价"掩盖未闭合项。
- 报告里不出现与本设计来源无关的其它来源字段。

通过后调用：

```text
node <skillRoot>/scripts/workflow.mjs --mode stage-complete --run-dir <designToArktsFastRunDir> --stage 5 --result passed
```

产物缺失、核对不一致时使用稳定 reason code 完成 blocked，并说明需要回到哪个阶段修复。