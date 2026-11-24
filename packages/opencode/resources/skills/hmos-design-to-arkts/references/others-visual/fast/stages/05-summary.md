# 05 - 总结

## 阶段元数据

- id: 05
- title: 05 - 总结
- variant: fast
- designSource: others-visual
- instruction: references/others-visual/fast/stages/05-summary.md

## 强制阶段入口 Todo 同步

读取 `stage-start.todoPayloadPath`，将 `.todos` 原样调用一次 `todowrite`；成功前不得执行阶段工作。

## 目标

校验阶段 1 至 4 的业务产物、实际工程文件和 `<designToArktsFastRunDir>/capability-invocation-ledger.json`，核对本设计源输入身份与产物链，生成 `completeness-report.md`，并以最终阶段完成命令结束整个 Fast 运行。Fast 不执行独立视觉校准，本阶段不引用其它设计源链条的身份字段。

## 执行

1. 校验阶段 1 至 4 的业务产物和实际工程文件，不得只根据 Todo 或对话摘要判断。
2. 读取 `<designToArktsFastRunDir>/capability-invocation-ledger.json` 核对调用证据：阶段 2 的 `hmos-d2a-repo-understand`、`hmos-d2a-arkui-component-best-practices`、`hmos-d2a-solution-design` 均为 completed 且 invocationId 与阶段 2 运行产物一致；阶段 3 的 `hmos-d2a-arkts-logic-completer` 为 completed；阶段 4 实际使用的 ArkTS 代码质量 skill 为 completed；仅当 `hds-decision.json.hdsRequired=true` 时 `hmos-d2a-arkui2hds` 必须为 completed，为 false 时核对可审计的不调用理由，不要求伪造调用记录。ledger 缺失、无法解析、invocationId 不一致、必需 completed 记录缺失或失败记录被伪装为 completed 时，不得通过阶段 5。
3. 核对阶段 1-4 产物链：截图 SHA-256（与 `inputs-manifest.json` 记录一致）、`stage1/visual-spec.json`、组件识别结果、组件树、设计方案、交互实现、HDS 决策和最终构建。Fast 不声称已完成独立视觉校准。
4. 核对页面身份与历史保护：`run-index.json` 由 Controller 在阶段 2 通过后写入（本来源与其他来源共用），Agent 不得手写或改写。页面身份以阶段 1 的工程接入快照、阶段 2 的 `component-tree.md` 与实际工程文件为准：确认目标页面文件、组件名、路由、注册位置与 `design-doc.md` 和 `stage2/generated-ui-manifest.json` 一致，历史页面与默认入口未被覆盖。发现冲突时报告为阻塞问题，不得在总结阶段自行修改工程文件或索引。
5. 写入 `<designToArktsFastRunDir>/completeness-report.md`，列出生成/修改文件、页面路由、功能实现情况、构建结果和已知限制。
6. 按主 Skill 的「交付任务完成率验收」读取本 run 的 `design-doc.md`，对照本次交付代码与已有证据逐项判定，把报告写入 run 根目录 `task-completion.json`，确认落盘。只有所有必需产物存在、阶段链连续、报告与实际工程一致，且 `task-completion.json` 已落盘时，才允许执行文末的阶段完成命令。

## 必需产物

```text
<designToArktsFastRunDir>/
├── completeness-report.md
└── capability-invocation-ledger.json
```

## 完成条件

- `completeness-report.md` 存在，内容与实际工程和阶段 1-4 产物链一致，覆盖生成/修改文件、页面路由、功能实现情况、构建结果和已知限制。
- `capability-invocation-ledger.json` 中阶段 2 至 4 的必需能力均有匹配的 completed 记录（HDS 视 `hds-decision.json.hdsRequired` 而定），阶段 5 只读取并校验，不新增或补写前序能力的 completed 记录。
- 页面身份、注册位置与历史保护核对通过，未发现被覆盖的历史页面或默认入口。
- 所有必需产物存在且阶段链连续；任一必需条件不满足时不得请求 `passed`，先修复证据，无法继续时使用稳定 reason code 完成 blocked。

阶段完成（此前 `task-completion.json` 须已落盘）：

```text
workflow.mjs --mode stage-complete --run-dir <designToArktsFastRunDir> --stage 5 --result passed
```

Controller 返回 `sync_final_todo_then_finish` 后，读取返回的 `todoPayloadPath`，把全量 completed `.todos` 原样调用一次 `todowrite`，再向用户输出最终总结；最终阶段后不得运行 `stage-start`。
