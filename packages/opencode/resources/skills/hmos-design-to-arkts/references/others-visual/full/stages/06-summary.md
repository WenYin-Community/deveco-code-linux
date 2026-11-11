# 06 - 总结

## 阶段元数据

- id: 06
- title: 06 - 总结
- variant: full
- designSource: others-visual
- instruction: references/others-visual/full/stages/06-summary.md

## 强制阶段入口 Todo 同步

读取 `stage-start.todoPayloadPath`，将 `.todos` 原样调用一次 `todowrite`；成功前不得执行阶段工作。

## 目标

校验阶段 1 至 5 的业务产物、实际工程文件和 `<designToArktsRunDir>/capability-invocation-ledger.json`，核对本设计源输入身份与产物链，生成 `completeness-report.md`，并以 `--stage 6 --result passed` 结束整个运行。本阶段只读取和核对，不新增、补写或修改前序阶段的产物；总结阶段不得引用其它设计源链条的身份字段，本来源身份核对以截图 SHA-256 与阶段 1–5 产物链为准。

## 执行

1. 校验阶段 1 至 5 的业务产物、实际工程文件和 `<designToArktsRunDir>/capability-invocation-ledger.json`，不得只根据 Todo 或对话总结判断。
2. 核对阶段 1-5 产物链：截图 SHA-256（与 `inputs-manifest.json` 记录一致）、`stage1/visual-spec.json`、组件识别结果、组件树、设计方案、交互实现、HDS 决策、最终构建和视觉校准报告。
3. 核对页面身份与历史保护：`run-index.json` 由 Controller 在阶段 2 通过后写入（本来源与 Figma/MasterGo/others-html 共用同一份），Agent 不得手写或改写。页面身份以阶段 1 的工程接入快照（`inputs-manifest.json.integrationSnapshot`）、阶段 2 的 `component-tree.md` 与实际工程文件为准：确认目标页面文件、组件名、路由、注册位置与 `design-doc.md` 和 `stage2/generated-ui-manifest.json` 一致，历史页面与默认入口未被覆盖。发现冲突时报告为阻塞问题，不得在总结阶段自行修改工程文件或索引。
4. 写入 `<designToArktsRunDir>/completeness-report.md`，列出生成/修改文件、页面路由、功能实现情况、视觉评分（`roundsCompleted`、末轮分数与阈值、`completionReason`，并按结束原因分桶列出残留差异清单）、已知限制和复现方式；`max-rounds-reached` 是兜底停机**不是失败**，不得使用「失败」字样。
5. 只有所有必需产物存在、阶段链连续且 `completeness-report.md` 与实际工程一致时，才允许执行文末的阶段完成命令。

## 必需产物

```text
<designToArktsRunDir>/
├── completeness-report.md
└── capability-invocation-ledger.json
```

## 完成条件

- `completeness-report.md` 存在，内容与实际工程和阶段 1-5 产物链一致，覆盖生成/修改文件、页面路由、功能实现、视觉评分、已知限制和复现方式。
- `capability-invocation-ledger.json` 中阶段 2 至 5 的必需能力均有匹配的 completed 记录（HDS 视 `hds-decision.json.hdsRequired` 而定）。
- 页面身份、注册位置与历史保护核对通过，未发现被覆盖的历史页面或默认入口。
- 所有必需产物存在且阶段链连续；任一必需条件不满足时不得请求 `passed`，先修复证据，无法继续时使用稳定 reason code 完成 blocked。

阶段完成：

```text
workflow.mjs --mode stage-complete --run-dir <designToArktsRunDir> --stage 6 --result passed
```

Controller 返回 `sync_final_todo_then_finish` 后，读取返回的 `todoPayloadPath`，把全量 completed `.todos` 原样调用一次 `todowrite`，再向用户输出最终总结；最终阶段后不得运行 `stage-start`。
