# 05 视觉还原度校准

本阶段完整复用 `references/figma/full/stages/05-visual-calibration.md`，先完整读取，再按相同启用/禁用分支、Todo、ledger、轮次准入和 Controller 操作执行。阶段入口 Todo 仅同步一次；当前 designSource=lanhu、variant=full。

唯一输入适配：参考图使用本次锁定的 source/lanhu/reference.png；坐标及倍率依据 source/lanhu/screenshots-manifest.json 的 sourceRegion、scale、真实尺寸，不能套用 Figma 1x/2x 规则。带编号图不能参与评分。目标页面/路由来自 stage2/generated-ui-manifest.json，使用同一份 system-ui-policy.json 和 viewport-boundary-spec.json。

调用现有 hmos-d2a-arkui-scoring-workflow 与 hmos-d2a-ui-reconstruction-score。设备截图、实际修复、重新构建部署、多轮评分、上限和退出理由、stage5-visual-calibration-report.json 的 schema 和 Gate 全部复用原 Full 规范，不另写蓝湖评分器。

未提供 visualCalibration.enabled 时按启用处理。缺少设备、参考图、工具或评分失败应 blocked；只有用户明确 enabled=false 才能 skipped。达到阈值或 maxRounds 后结束，不为凑轮次重复评分。
