# Whitelist of files to include in skill_files for hmos-design-to-arkts
# Lines starting with # are comments; empty lines are ignored
# @note lines add informational annotations to skill_files

# --- Entry core ---
# @note SKILL.md 的「能力注册表」表是所有能力的调度入口：阶段指令要求“加载能力 X”时，按注册表「指令路径」列读取对应 INSTRUCTIONS.md 全文并完整执行；能力内部相对路径相对其能力目录（references/capabilities/<能力名>/）解析，不相对入口 skill 根目录
# @note scripts/workflow.mjs 是 Controller 脚本（init/status/stage-start/confirm/stage-complete），阶段文件不预读，只按 stage-start 返回的 instructionPath 渐进加载
SKILL.md
scripts/workflow.mjs
# @note scripts/pixso-arkts/ 为 Pixso 内置 DSL→ArkTS 转换引擎；call-pixso-arkts.mjs 是命令行入口，pixso-arkts.js 是默认引擎实现
scripts/pixso-arkts/pixso-arkts.js
scripts/pixso-arkts/call-pixso-arkts.mjs
# @note scripts/visual_probe.mjs 是截图路径（others-visual）的确定性像素取样器：阶段 1 单次调用（budget.passes=1），Node 原生解码 PNG 与 baseline JPEG（零外部依赖），progressive JPEG 才降级到已依赖的 Playwright/Chromium
scripts/visual_probe.mjs
# @note scripts/visual_region_diff.mjs 是截图路径的可选结构诊断器：输入设计稿与候选截图的两份 visual_probe 报告，按归一化坐标逐区比对（分区边界缺失/位移超容差为失败，块尺寸/圆角/背景/色板/文字行为告警），产出 region-diff.json；阶段 5 判据归主流评分，本脚本只在定位争议时作"哪一区差多少"的归因线索
scripts/visual_region_diff.mjs

# --- Entry-level references ---
# @note runtime-contract.md 定义 Controller 状态机与恢复协议；requirement-clarification.md 定义需求预检字段映射与澄清文档规范；design-doc-auto-recovery.md 是 design-doc.md 缺失时的自动恢复指令；mcp-dependency.md 是 Pixso/Figma 路径的 MCP 依赖检查指引（检查方法、判定与安装引导）；repo-context.md 是 Pixso 阶段 3 的工程理解产物契约（stage2/repo-context.json 的 16 键 schema 与 Controller 校验口径）
references/runtime-contract.md
references/requirement-clarification.md
references/design-doc-auto-recovery.md
references/mcp-dependency.md
references/repo-context.md
# @note html-facts.md 是 others-html（HTML 设计源）的取证契约：layout-facts 结构、两个覆盖率（coverage / visibleCoverage）、参考集规则（禁 fullPage）、瘦身 visual-spec（禁写数值）、取值与修值口径（阶段 5 判据归主流评分，facts 用于定位与查修值）
references/html-facts.md
# @note device-screenshot.md 是 others 两源通用的设备截图契约：devecocli ui screenshot 出 PNG 的主路径、hdc PNG / 直评 JPEG 的回退矩阵、格式与 captureLog 规则、禁改名/禁几何变换
references/device-screenshot.md
# @note visual-spec.md 是 others-visual（截图）的视觉规格契约：spec 结构、三档取证模式（M0 工具识别 / M1 主模型读图 / M2 双通道）、textInventory 文本清单与接地规则、probe→spec 逐项对账与实现保真
references/visual-spec.md

# --- Stage catalogs ---
# @note catalog JSON 是阶段→stage 文件的映射（instructionPath、requiresConfirmation 等）；选定来源与 variant 后由 Controller 读取对应 catalog
references/pixso/stage-catalog-full.json
references/pixso/stage-catalog-fast.json
references/figma/stage-catalog-full.json
references/figma/stage-catalog-fast.json
references/others-html/stage-catalog-full.json
references/others-html/stage-catalog-fast.json
references/others-visual/stage-catalog-full.json
references/others-visual/stage-catalog-fast.json

# --- Pixso Full stage files (10) ---
references/pixso/full/stages/01-acquire-pixso-dsl.md
references/pixso/full/stages/02-generate-skeleton-and-assets.md
references/pixso/full/stages/03-understand-repository.md
references/pixso/full/stages/04-select-component-practices.md
references/pixso/full/stages/05-design-and-confirm-component-tree.md
references/pixso/full/stages/06-implement-static-layout.md
references/pixso/full/stages/07-complete-interaction-logic.md
references/pixso/full/stages/08-quality-build-and-audits.md
references/pixso/full/stages/09-visual-calibration.md
references/pixso/full/stages/10-summary.md

# --- Pixso Fast stage files (9) ---
references/pixso/fast/stages/01-acquire-pixso-dsl.md
references/pixso/fast/stages/02-generate-skeleton-and-assets.md
references/pixso/fast/stages/03-understand-repository.md
references/pixso/fast/stages/04-select-component-practices.md
references/pixso/fast/stages/05-design-component-tree.md
references/pixso/fast/stages/06-implement-static-layout.md
references/pixso/fast/stages/07-complete-interaction-logic.md
references/pixso/fast/stages/08-quality-build-and-audits.md
references/pixso/fast/stages/09-summary.md

# --- Figma Full stage files (6) ---
references/figma/full/stages/01-acquire-figma-react-source.md
references/figma/full/stages/02-convert-react-to-arkui.md
references/figma/full/stages/03-complete-interaction-logic.md
references/figma/full/stages/04-quality-and-build.md
references/figma/full/stages/05-visual-calibration.md
references/figma/full/stages/06-summary.md

# --- Figma Fast stage files (5) ---
references/figma/fast/stages/01-acquire-figma-react-source.md
references/figma/fast/stages/02-convert-react-to-arkui.md
references/figma/fast/stages/03-complete-interaction-logic.md
references/figma/fast/stages/04-quality-and-build.md
references/figma/fast/stages/05-summary.md

# --- others-html Full stage files (6) ---
# @note HTML 设计源路径与 figma 同构为 6 阶段，但阶段 2 是 facts 直译（不走 JSX、不调 recognition）：取证 / HTML 设计转换（中段确认）/ 补全交互 / HDS 与质量审计 / 视觉校准 / 总结
references/others-html/full/stages/01-acquire-html-source.md
references/others-html/full/stages/02-convert-html-to-arkui.md
references/others-html/full/stages/03-complete-interaction-logic.md
references/others-html/full/stages/04-quality-and-build.md
references/others-html/full/stages/05-visual-calibration.md
references/others-html/full/stages/06-summary.md

# --- others-html Fast stage files (5) ---
# @note Fast 阶段目录：取证 / HTML 设计转换 / 补全交互 / HDS 与质量审计 / 总结（5 阶段）
references/others-html/fast/stages/01-acquire-html-source.md
references/others-html/fast/stages/02-convert-html-to-arkui.md
references/others-html/fast/stages/03-complete-interaction-logic.md
references/others-html/fast/stages/04-quality-and-build.md
references/others-html/fast/stages/05-summary.md

# --- others-visual Full stage files (6) ---
# @note 截图来源与 figma 同构为 6 阶段：阶段 2 为截图上下文方案设计（solution-design 的 others-visual 分支）+ 中段确认（六文件快照：识别/probe/spec/组件分析/组件树/设计文档）；截图取证 / 截图设计转换（中段确认）/ 补全交互 / HDS 与质量审计 / 视觉校准 / 总结
references/others-visual/full/stages/01-acquire-screenshot-input.md
references/others-visual/full/stages/02-convert-screenshot-to-arkui.md
references/others-visual/full/stages/03-complete-interaction-logic.md
references/others-visual/full/stages/04-quality-and-build.md
references/others-visual/full/stages/05-visual-calibration.md
references/others-visual/full/stages/06-summary.md

# --- others-visual Fast stage files (5) ---
# @note Fast 阶段目录：截图取证 / 截图设计转换（自动接受）/ 补全交互 / HDS 与质量审计 / 总结（5 阶段）
references/others-visual/fast/stages/01-acquire-screenshot-input.md
references/others-visual/fast/stages/02-convert-screenshot-to-arkui.md
references/others-visual/fast/stages/03-complete-interaction-logic.md
references/others-visual/fast/stages/04-quality-and-build.md
references/others-visual/fast/stages/05-summary.md

# --- Capability INSTRUCTIONS.md (dispatch targets of the 能力注册表 in SKILL.md; the MasterGo and Lanhu capabilities register in their own sections below) ---
# @note 每个能力的完整文件清单见其能力目录下的 FILES.md（references/capabilities/<能力名>/FILES.md）；本清单只列 INSTRUCTIONS.md 与 HTML 能力脚本，其余能力文件由各自 FILES.md 索引
references/capabilities/hmos-d2a-arkts-logic-completer/INSTRUCTIONS.md
references/capabilities/hmos-d2a-arkui-component-best-practices/INSTRUCTIONS.md
references/capabilities/hmos-d2a-arkui-scoring-workflow/INSTRUCTIONS.md
references/capabilities/hmos-d2a-arkui2hds/INSTRUCTIONS.md
references/capabilities/hmos-d2a-react-to-arkui/INSTRUCTIONS.md
references/capabilities/hmos-d2a-html-to-arkui/INSTRUCTIONS.md
references/capabilities/hmos-d2a-html-to-arkui/FILES.md
references/capabilities/hmos-d2a-html-to-arkui/scripts/html-source-capture.mjs
references/capabilities/hmos-d2a-html-to-arkui/scripts/html-source-freeze.mjs
references/capabilities/hmos-d2a-html-to-arkui/scripts/local-resources.mjs
references/capabilities/hmos-d2a-html-to-arkui/scripts/html-frame-regions.mjs
references/capabilities/hmos-d2a-html-to-arkui/scripts/html-assets-materialize.mjs
references/capabilities/hmos-d2a-html-to-arkui/scripts/html-image-sample.mjs
references/capabilities/hmos-d2a-repo-understand/INSTRUCTIONS.md
references/capabilities/hmos-d2a-responsive-layout-generator/INSTRUCTIONS.md
references/capabilities/hmos-d2a-solution-design/INSTRUCTIONS.md
references/capabilities/hmos-d2a-ui-reconstruction-score/INSTRUCTIONS.md

# --- Evals (dev-time) ---
# @note evals/evals.json 定义入口决策点校验用例（来源识别/双来源冲突/参数冲突/缺 node-id 澄清/sections+extractSvg 图标流程/10003 席位门槛 blocked/MasterGo 客户端不可用时来源预检提前提示两路径），开发态产物，运行时不加载
evals/evals.json

# --- MasterGo Full/Fast ---
references/capabilities/hmos-d2a-mastergo-to-arkui/INSTRUCTIONS.md
references/mastergo/acquire.md
references/mastergo/convert.md
references/mastergo/fast/stages/01-acquire-mastergo-context.md
references/mastergo/fast/stages/02-convert-mastergo-to-arkui.md
references/mastergo/fast/stages/03-complete-interaction-logic.md
references/mastergo/fast/stages/04-quality-and-build.md
references/mastergo/fast/stages/05-summary.md
references/mastergo/full/stages/01-acquire-mastergo-context.md
references/mastergo/full/stages/02-convert-mastergo-to-arkui.md
references/mastergo/full/stages/03-complete-interaction-logic.md
references/mastergo/full/stages/04-quality-and-build.md
references/mastergo/full/stages/05-visual-calibration.md
references/mastergo/full/stages/06-summary.md
references/mastergo/input-contract.md
references/mastergo/mcp-setup.md
references/mastergo/runtime-contract.md
references/mastergo/stage-catalog-fast.json
references/mastergo/stage-catalog-full.json
scripts/mastergo-source.mjs
scripts/mastergo-capture.mjs
# @note scripts/mastergo-preflight.mjs 是 MasterGo 来源预检：`init` 前探测桌面客户端本地服务端口（默认 127.0.0.1:30678），输出 {status,endpoint[,reason]}；--connection 传连接文件，只有其中 local 连接的 loopback --url 带显式端口才改探测地址（无端口或无法解析按缺省回落默认地址），精确定址用 --endpoint（须为完整 http:// 或 https:// URL 且带显式端口；80/443 会被 URL 归一化掉，按缺端口处理）；--connection 与 --endpoint 互斥；不可达时入口按 mcp-setup 的判定顺序给出两条路（恢复客户端 / 纯 Magic + 手工导出或社区通道，否则 blocked）等用户选定
scripts/mastergo-preflight.mjs
scripts/mastergo-connection.mjs
scripts/mastergo-evidence.mjs
scripts/mastergo-community-start.mjs
scripts/mastergo-community-verify.mjs
references/mastergo/community/README.md
references/mastergo/community/LICENSE
references/mastergo/community/manifest.json
references/mastergo/community/deveco-community.patch
references/capabilities/hmos-d2a-mastergo-to-arkui/FILES.md

# --- Lanhu Fast ---
scripts/lanhu-workflow.mjs
scripts/lanhu-source.mjs
scripts/lanhu-capture.mjs
scripts/lanhu-connection.mjs
scripts/lanhu-setup.mjs
scripts/lanhu-private.mjs
scripts/lanhu-runtime.mjs
scripts/lanhu_login.py
scripts/lanhu-mastergo.patch.json
scripts/lanhu-runtime-lock.json
scripts/lanhu-import-assets.mjs
references/lanhu/mcp-setup.md
references/lanhu/upstream-LICENSE
references/lanhu/runtime-contract.md
references/lanhu/input-contract.md
references/capabilities/hmos-d2a-lanhu-to-arkui/INSTRUCTIONS.md
references/capabilities/hmos-d2a-lanhu-to-arkui/FILES.md
references/lanhu/fast/stages/01-acquire-lanhu-context.md
references/lanhu/fast/stages/02-convert-lanhu-to-arkui.md
references/lanhu/fast/stages/03-complete-interaction-logic.md
references/lanhu/fast/stages/04-quality-and-build.md
references/lanhu/fast/stages/05-summary.md
references/lanhu/stage-catalog-fast.json

# --- Lanhu Full ---
references/lanhu/stage-catalog-full.json
references/lanhu/full/stages/01-acquire-lanhu-context.md
references/lanhu/full/stages/02-convert-lanhu-to-arkui.md
references/lanhu/full/stages/03-complete-interaction-logic.md
references/lanhu/full/stages/04-quality-and-build.md
references/lanhu/full/stages/05-visual-calibration.md
references/lanhu/full/stages/06-summary.md
