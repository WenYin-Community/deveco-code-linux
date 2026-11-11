# 05 - 视觉还原度校准

本阶段读取并完整复用 `references/figma/full/stages/05-visual-calibration.md`，不复制维护第二份实现。首次进入时按原指令同步 Todo，最多一次。`hmos-d2a-arkui-scoring-workflow` 与 `hmos-d2a-ui-reconstruction-score` 的调用、轮次准入、评分判据、报告 schema 与 Gate 全部沿用原文；本来源与主流**完全同参**：`scoreThreshold` 缺省 **80**、`maxRounds` 缺省 **5**。评分子能力 INSTRUCTIONS 开头的来源枚举为遗留描述（零 diff 保护），以本阶段文档的显式调度为准。

## 源参数替换

- designSource=others-visual；`visualCalibration.enabled=false` 表示用户显式放弃画面复核（只写 skipped 报告）。
- 参考截图 = `<designToArktsRunDir>/source/visual/screenshot.png`（阶段 1 锁定的用户原始截图；不改倍率、不裁剪、不重编码）。
- 系统 UI 忽略带：优先取 `stage1/visual-probe.json` / spec 记录的系统区真值；缺失时用缺省 44/36。
- 原文的 Figma 专属输入（Anchor 取数、`page.jsx`、React 源 hash）不适用——评分只需要参考截图与本轮实现截图。

## 截图方法（每轮）

统一按 `references/device-screenshot.md`：优先 `devecocli ui screenshot --device <name|serial> --path <designToArktsRunDir>/visual-calibration/round-NN/candidate.png`；PNG 为准。`devecocli` 不可用时按文档回退 hdc PNG；设备/版本只能出 JPEG 时，直接以 `.jpeg` 作为候选评分，**不得改名成 `.jpg`**。`captureLog` 记录命令、设备、实际格式、尺寸、大小与 sha256。

## 源独特子步骤（插位不改变主流流程）

1. **可选探针诊断**（定位争议时）：对本轮实现截图运行 `node scripts/visual_probe.mjs --screenshot <designToArktsRunDir>/visual-calibration/round-NN/candidate.png --out <designToArktsRunDir>/visual-calibration/round-NN/candidate-probe.json`（每轮至多一次），用于区分"颜色错了还是位置错了"。属诊断工具，不参与判据。轮目录内自愿保留的 `candidate-probe.json` 必须绑定本轮截图（`source.sha256` 一致），过期 probe 需更新或移出轮目录。
2. **结构对账降为诊断**：`scripts/visual_region_diff.mjs`（设计稿 probe vs 候选 probe）可定位分区级偏差（条带边界 / 块 / 文字行），结果只作归因线索；**不得因 region-diff 未通过而拒绝达标收尾或追加轮次**。
3. **visual-spec 归因**：`stage1/visual-spec.json`（`background`/`palette`/`typography`/`textInventory`）提供"正确值"参考；本阶段只读。

## 评分输入完整性（Controller 机器校验，`evidence_invalid`）

1. 每轮评分输入必须是本轮原始整屏截图 `visual-calibration/round-NN/candidate.png|jpg|jpeg`；`score.json` 的 `pairs[].candidate` 与报告 `candidate.path` 归一化后都与该路径逐字一致——派生图一律拒收，不得作为评分输入。失败的中止轮按主流规则放 `attempts/`，不占轮号。
2. 参考截图同为规范路径（`source/visual/screenshot.png`）并做哈希对账（manifest 记录与 probe 记录双锚），不得换图。
3. 报告 `rounds[].candidate.sha256` 必须与磁盘上的规范截图一致；`score.json` 的 `pairs[].candidate` 与报告 `candidate.path` 同指该文件。
4. 各轮 candidate 哈希互不相同；确需同图时须在 `reworkNotes` 说明原因（如修复不产生视觉变化）并引用修复与构建证据。
5. 每轮 `score*` 评分目录唯一。
6. 报告 `rounds[].score` 必须等于对应 `score.json` 的 `aggregate.final_baseline_score`；`rounds[]` 不得出现 `roundsCompleted` 之外的轮号。
7. 第 2 轮起必须能对账修复与构建证据（`changedFiles` 修改前后 SHA + 构建产物；工程根缺失时拒收），末轮修复须与磁盘文件一致。
8. `ignored_top_status_px` / `ignored_bottom_system_px`（评分脚本 `--ignore-top/bottom-px` 实参）只允许缺省（44/36）或 probe 首末分区推导的系统区像素值（受上限约束）；其他取值一律拒收。

## 禁止事项（叠加于主流原文之上）

- 不得对候选截图或参考截图做任何几何变换。
- **不得为对齐或评分引入整页全局非等比缩放**。
- 不得修改 `stage1/visual-probe.json` 与 `stage1/visual-spec.json`。
- 原结构对账 gate（每轮强制 `candidate-probe.json` / `region-diff.json`、`residual-region-deviation` 结束原因）已退役为可选诊断，不得再作为完成条件。
- `max-rounds-reached` 是兜底停机不是失败；总结按结束原因分桶呈现残留差异，不得使用「失败」字样。
