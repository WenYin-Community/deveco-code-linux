# 05 - 视觉还原度校准

本阶段读取并完整复用 `references/figma/full/stages/05-visual-calibration.md`，不复制维护第二份实现。首次进入时按原指令同步 Todo，最多一次。`hmos-d2a-arkui-scoring-workflow` 与 `hmos-d2a-ui-reconstruction-score` 的调用、轮次准入、评分判据、报告 schema 与 Gate 全部沿用原文；本来源与主流**完全同参**：`scoreThreshold` 缺省 **80**、`maxRounds` 缺省 **5**（HTML 每轮构建成本高，需收紧轮次时由用户在需求澄清 `requirement-clarification.json` 里按轮指定；本适配段不做任何显式覆盖）。评分子能力 INSTRUCTIONS 开头的来源枚举为遗留描述（零 diff 保护），以本阶段文档的显式调度为准。

## 源参数替换

- designSource=others-html；`visualCalibration.enabled=false` 表示用户显式放弃画面复核（只写 skipped 报告）。
- 参考帧 = `<designToArktsRunDir>/source/html/reference/reference-00.png`（阶段 1 锁定的唯一参考帧；`content-full.png` / `content-unclipped.png` 等派生帧一律不得作为评分参考）。
- 系统 UI 忽略带：优先取 `stage1/layout-facts.json` 的 `render.statusBarVp` / `render.gestureBarVp` 真值；缺失时用缺省 44/36。数值按评分脚本的**参考帧物理像素口径**传参（2x 画布用 vp×deviceScaleFactor，1x 画布即 vp 值）。
- 原文的 Figma 专属输入（Anchor 取数、`page.jsx`、React 源 hash）不适用——评分只需要参考帧与本轮实现截图。

## 截图方法（每轮）

统一按 `references/device-screenshot.md`：优先 `devecocli ui screenshot --device <name|serial> --path <designToArktsRunDir>/visual-calibration/round-NN/candidate.png`；PNG 为准。`devecocli` 不可用时按文档回退 hdc PNG；设备/版本只能出 JPEG 时，直接以 `.jpeg` 作为候选评分，**不得改名成 `.jpg`**。`captureLog` 记录命令、设备、实际格式、尺寸、大小与 sha256。

## 源独特子步骤（插位不改变主流流程）

1. **临时预览与字节恢复**（每轮整屏截图之前）：`stage2/generated-ui-manifest.json` 的 `reachability=requires-temporary-preview` 时，允许把 `Index.ets` 首页内容临时换为目标页（或加临时 debug 入口）后截图；截完**必须逐字节恢复原文件**，并把 `{ applied, restored, sha256Before, sha256After }` 写入 `stage5-visual-calibration-report.json` 的 `temporaryPreview` 字段（原文 schema 之外的源独特新增字段；`sha256After` 必须等于 `sha256Before`）。临时预览不是交付物。
2. **facts 归因**（本轮 `compare_images` 复核完成之后、选择问题实际修复之前）：分数与热力图告诉你**哪里**不对；`stage1/layout-facts.json`（rect / `fontSizePx` / 颜色 / 圆角）与 `stage1/visual-spec.json` 告诉你**正确值应该是多少**——按 facts 真值到 `stage2/component-analysis.md` / `stage2/implementation-report.md` 定位代码位置直接修值。两者本阶段只读。
3. **可选诊断**（定位争议时，不是判据）：能力 `hmos-d2a-html-to-arkui` 的 `scripts/html-frame-regions.mjs` 可做区域差异定位，其 `--points <points.json>` 参数做点采样（区分「颜色错了还是位置错了」）；诊断产物由脚本 `--out` 决定落盘位置、不进入评分路径，只作归因线索，**不得因诊断结论拒绝达标收尾或追加轮次**。对旧候选留下的过期 probe 产物需更新或移出轮目录。测量交给脚本，禁止自写 PNG 解码、像素扫描或截图分析脚本。

## 评分输入完整性（Controller 机器校验，`evidence_invalid`）

1. 每轮评分输入必须是本轮原始整屏截图 `visual-calibration/round-NN/candidate.png|jpg|jpeg`；`score.json` 的 `pairs[].candidate` 与报告 `candidate.path` 归一化后都与该路径逐字一致——派生图（`*-aligned` / `*-opt9` / `*-cropped` 等）一律拒收，不得作为评分输入。失败的中止轮按主流规则放 `attempts/`，不占轮号。
2. 参考帧同为规范路径（`source/html/reference/reference-00.png`），Controller 按首帧名锁与画布尺寸对账，不得换图。
3. 报告 `rounds[].candidate.sha256` 必须与磁盘上的规范截图一致；`score.json` 的 `pairs[].candidate` 与报告 `candidate.path` 同指该文件。
4. 各轮 candidate 哈希互不相同；确需同图时须在 `reworkNotes` 说明原因（如修复不产生视觉变化）并引用修复与构建证据。
5. 每轮 `round-NN/` 下 `score*` 评分目录唯一。
6. 报告 `rounds[].score` 必须等于对应 `score.json` 的 `aggregate.final_baseline_score`；`rounds[]` 不得出现 `roundsCompleted` 之外的轮号。
7. 第 2 轮起必须能对账修复与构建证据（`changedFiles` 修改前后 SHA + 构建产物；工程根缺失时拒收），末轮修复须与磁盘文件一致。
8. `ignored_top_status_px` / `ignored_bottom_system_px`（评分脚本 `--ignore-top/bottom-px` 实参）只允许缺省（44/36）或 `layout-facts.json` 系统区真值（受上限约束）；其他取值一律拒收。

## 禁止事项（叠加于主流原文之上）

- 不得对候选截图或参考帧做任何几何变换；**不得为对齐或评分引入整页全局非等比缩放**（如按 `screenW/375` 分别独立缩放 x、y 的 `canvasScaleX/Y` 模式——像素可贴合，但页面失去自适应能力）。
- 不得修改 `stage1/layout-facts.json` 与 `stage1/visual-spec.json`。
- 原区域判据体系（`regions.json` / `region-triage.json` / `repairRounds` / kept ≤ 8 / 手势带亮度断言 / 对齐护栏）已退役为可选诊断，不得再作为完成条件或报告必需字段。
- 评分父能力 INSTRUCTIONS「轮次证据与恢复」中的 candidate 哈希与 changedFiles 前后 SHA 条款，在 others 两源已由上述 8 条机器化执行（captureLog 仍为文档条款）；四个主流来源全部仍为文档条款（同条款两速执行）。
