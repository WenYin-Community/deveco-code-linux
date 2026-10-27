# 01 获取并校验蓝湖上下文

本阶段复用 `references/lanhu/fast/stages/01-acquire-lanhu-context.md` 的取数与输入校验步骤，完整读取并执行其中流程；阶段入口 Todo 仅同步一次。保持 designSource=lanhu、variant=full，不调用 Figma/Anchor。

运行目录为 `.deveco/design-to-arkts/runs/<runId>`；integrationSnapshot.runIndexFile 使用 `.deveco/design-to-arkts/run-index.json`。记录真实历史页面，保留已有 Fast 运行，不将其产物复制冒充本次取证。

visualCalibration 采用原 Full 契约：enabled 默认 true、scoreThreshold 默认 80、maxRounds 默认 5（1—5）。用户明确禁用时记录 enabled=false；缺少设备/评分工具不等于用户禁用，不擅自改为 false。
