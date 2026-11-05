# 工程理解产物契约（repo-context）

本文件定义 Pixso 阶段 3 工程理解产物 `stage2/repo-context.json` 的结构、字段说明与 Controller 校验口径。

`stage2/repo-context.json` 是从目标 ArkTS 工程提炼的机器产物：入口、路由、状态管理、数据模型、资源、构建命令与存量组件结论，供方案设计与质量审计按字段消费。人类可读报告沿用 `hmos-d2a-repo-understand` 的十部分输出（`stage3-repo-understand-report.md`），JSON 从十部分提炼（见 [提取规则](#提取规则)）。

## 目录

- [机器形态：stage2/repo-context.json](#机器形态stage2repo-contextjson)
- [路径与证据口径](#路径与证据口径)
- [提取规则](#提取规则)
- [Controller 校验口径](#controller-校验口径)

## 机器形态：stage2/repo-context.json

本产物在阶段 3 产出，写入 `stage2\`——`stage2\` 是产物目录语义，不是「阶段 2 专属」；阶段改号不影响契约路径。

**16 个必填顶层键**。计数口径在本文件写死：`schemaVersion` 与 `designSource` 由断言 1 校验，其余 14 键由断言 2 校验齐全（见 [Controller 校验口径](#controller-校验口径)）。

| 键 | 类型 | 说明 |
|---|---|---|
| `schemaVersion` | int | 固定 `1` |
| `designSource` | enum | 必须与本 run 的设计来源一致，即 `pixso` |
| `projectRootPath` | string | 工程根，须与 inputs-manifest 顶层 `projectRootPath` 一致（核对前统一 resolve，指向同一目录即判等） |
| `projectType` | enum | 取值必须是 `template` 或 `existing` 本身；判定依据写入 `differences` 与 `evidence.filesRead`，不得写进本字段 |
| `entryChain` | object | `{indexFile, entryAbilityFile, mainPagesFile, loadContent}`，四个子键均非空 |
| `routing` | object | `{registrationMode, registrationFile, existingRoutes[]}`；`registrationMode` / `registrationFile` 非空，`existingRoutes` 允许空数组 |
| `stateManagement` | object | `{version: v1\|v2, pattern, evidence}`；**`evidence` 必须形如 `path:line`** 且路径在工程内存在 |
| `dataModel` | object | `{existing[]}`，存量数据模型；`existing` 允许空数组 |
| `resources` | object | `{mediaDir, prefix, colorFile, stringFile, floatFile}`，五个子键均非空 |
| `buildCommands` | object | `{check, build}`，实测命令而非猜测，两个子键均非空 |
| `existingComponents[]` | array | `{name, file, kind, evidence}`，存量组件清单；**`name` 必须是裸标识符**（struct / 组件 / 页面名，如 `Index`、`XiaoyiChatListPage`），不得附加说明、`@`、括号或空格 |
| `reusableComponents[]` | array | `{name, file, useFor, evidence}`，本次可直接复用的组件；**`name` 规则同上**——复用的是模式或片段时，`name` 写承载它的组件名，「复用哪个模式、用在哪」写进 `useFor` |
| `startupPage` | object | 现状快照 `{before, evidenceFiles[]}`，只记 before；`after` / `changeDefault` 属于方案决策，独归 `startup-page-policy.json` |
| `differences[]` | array | `{kind: existing\|missing\|conflict, target, detail, evidence}`；Controller 校验 `target` 与 `evidence` 非空，`kind` 取值由产出方按本表约束 |
| `uncertainties[]` | array | `{item, why, howResolved}`；判不出就写，**禁编**；Controller 校验键存在，条目结构由产出方按本表约束 |
| `evidence` | object | `{filesRead[], generatedAt}`；`filesRead` 每项须真实存在；`generatedAt` 为含秒的 ISO-8601 时间戳（Z 或数字偏移），走系统时钟，**整分零秒被拒** |

## 路径与证据口径

- 所有 `path` 类字段（组件的 `file`、`evidence` 中的路径、`filesRead` 条目）一律**相对工程根**，禁止绝对路径、盘符限定路径与 `..` 越界。
- 每个结论必须带 `evidence`——没有出处的结论等于没写。

## 提取规则

`schemaVersion` 固定为 `1`，`designSource` 取当前来源；其余 14 键按十部分提炼：

| 键 | 提炼来源 |
|---|---|
| `projectRootPath` | inputs-manifest 顶层 `projectRootPath`（阶段 1 实测） |
| `projectType` | 一、项目信息（模板/存量判定） |
| `entryChain` | 一、项目信息，二、架构约束（入口部分） |
| `routing` | 二、架构约束（路由部分） |
| `stateManagement` | 二、架构约束 |
| `dataModel` | 二、架构约束，五、5.3 已实现功能点 |
| `resources` | 一、项目信息，四、代码风格 |
| `buildCommands` | 一、项目信息（实测命令） |
| `existingComponents` | 五、5.2 已实现组件清单 |
| `reusableComponents` | 五、5.2，六、需要补充实现的部分（可复用点） |
| `startupPage` | 一、项目信息，阶段 2 构建报告（启动页现状） |
| `differences` | 六、需要补充实现的部分，七、差异分析摘要 |
| `uncertainties` | 各部分记录的不确定项（如实留空则空数组） |
| `evidence` | 实际读取过的工程文件集合 |

## Controller 校验口径

只在 Pixso 阶段 3 / 阶段 5 的 `stage-complete --result passed` 现场（live）执行；已完成阶段的重放不追溯。断言编号即机器形态一节的键计数口径；逐键的完整判定以本文定义为准。

| # | 断言 | 防什么 |
|---|---|---|
| 1 | 文件存在、可 parse、是 JSON 对象，`schemaVersion=1`，`designSource` 为 `pixso` | 拿别的来源的报告充数；合法 JSON null 文档溜过 |
| 2 | 其余 14 个顶层键齐全；`entryChain`、`routing`、`stateManagement`、`resources`、`buildCommands` 子键非空；`startupPage.before` 非空；数组型子键（`existingRoutes`、`dataModel.existing`、`filesRead`、`evidenceFiles`）为数组 | 空壳产物 |
| 3 | `stateManagement.evidence` 匹配 `path:line`，且路径相对工程根真实存在、不越界 | 「我记得是 V1」式编造 |
| 4 | `existingComponents` / `reusableComponents` / `differences` 每项 `evidence`（及 `name` / `target`）非空；组件 `name` 必须是裸标识符（含空白、`@`、圆括号、方括号、尖括号、逗号、分号、冒号即拒） | 结论无出处；把「组件名@说明」当成组件名 |
| 5 | 工程根与 inputs-manifest 顶层 `projectRootPath` 交叉核对；manifest 缺失或非对象即结构化报错，不静默跳过 | 工程理解与阶段 1 实测自相矛盾 |
| 6 | 十部分主标题齐全（整行精确匹配）、每部分有正文、无未填模板占位 | 贴骨架交差 |
| 7 | `evidence.filesRead` 每项相对工程根存在且不越界；`generatedAt` 为含秒的 ISO-8601 时间戳且整分零秒被拒；十部分 5.2 已实现组件清单与 `existingComponents[].name` 至少 1 个交集（两者均非空时，按标识符边界匹配） | 编造读过的文件；MD 与 JSON 互相矛盾 |
| 消费 | `design-doc.md` 的「存量复用」节：`reusableComponents` 非空时必须**逐字出现**至少 2 个 `reusableComponents[].name`（清单不足 2 个时按实际数量，组件名之外的说明可自由写）；为空时必须写明「工程无存量可复用组件」加一句依据 | 方案设计空转、无视存量 |

「存量复用」的判读是下限而非防伪：它拒绝缺节、缺结论和光秃秃一句话，不替代方案评审。
