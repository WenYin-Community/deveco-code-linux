# Whitelist of files to include in skill_files for hmos-d2a-html-to-arkui
# Lines starting with # are comments; empty lines are ignored
# @note lines add informational annotations to skill_files

# @note others-html 专用能力：阶段1 HTML 取证 + 阶段5 可选差异诊断。INSTRUCTIONS.md 是能力入口指令，由入口的能力注册表调度；产出 layout-facts.json 与参考集（含解裁预览），供实现与阶段5 facts 归因使用——阶段5 判据归主流评分流程，本能力只提供区域差异/点采样等诊断脚本，不产出语义命名
INSTRUCTIONS.md

# --- Scripts ---
# @note scripts/html-source-freeze.mjs 是阶段1 的冻结步骤：定位入口 HTML（目录递归 + 多入口按最浅 index.html 判定 + --entry 覆盖，仍不唯一则 exit 2 列候选）、**取入口与所有可解析引用的最低公共祖先为根**（有界 4 层，可用 --root 覆盖）整棵复制到 source/html（先清空）、入口改名 input.html（嵌套时落在 source/html/<dir>/input.html）、按内容校验、审计本地引用并写 stage1/source-freeze.json；--inspect 只打印形状不落盘；替代手工复制/改名，杜绝 css/css 嵌套与错误根
scripts/html-source-freeze.mjs

# @note scripts/local-resources.mjs 是冻结与取证共用的本地引用审计：根绝对路径、file:/// 或 ../ 逃出冻结树、文件缺失三类计入缺失，url(#mask) 片段与 data: 跳过，远程引用只计数；也可独立运行（`--entry <input.html> --tree <source/html>`）作为手动冻结后的验收，缺失率超阈值即 exit 2
scripts/local-resources.mjs
# @note scripts/html-source-capture.mjs 在单个浏览器会话内完成三件事：滚动位置 0 dump 布局事实、按视口步进截取参考帧、浏览器内拼接全高图；Playwright 缺失时给安装指引并以非零码退出，绝不代装
scripts/html-source-capture.mjs

# @note scripts/html-frame-regions.mjs 是阶段5 的可选差异诊断脚本（判据归主流评分，不拦截收尾）：解码（PNG 用 node:zlib，JPEG 一律经 Chromium 转 PNG）→ 全局对齐搜索与护栏 → 排除顶底系统 UI 带 → 8x8 分块聚簇 → 与 facts 求交 → 手势带亮度告警 → 生成两张编号裁片拼图；另有 --probe 点采样子命令；产物落在 --out 目录的 stage5/ 下（带 producer 与输入 SHA-256），不得手写
scripts/html-frame-regions.mjs

# @note scripts/html-assets-materialize.mjs 是阶段2 的资产物化脚本：从 facts 的 imageSrc/maskImage data-URI 解码归一化（rgba→rgb+opacity、浮点通道取整）、圆形蒙版裁剪配方、线性渐变原生 recipe（逆映射 gradientTransform→角度+窗口化停点）、content-sha256 去重；产出 materialize.json 并入 manifest，不得手写 CSS 解析器
scripts/html-assets-materialize.mjs

# @note scripts/html-image-sample.mjs 是官方资产采样器：资产 PNG 原生像素坐标 rgb+alpha（全型扫描行反滤波、调色板 tRNS）、--alpha-extent 不透明范围、--out 落盘 sample-<名字>.json（producer+图 SHA）；源图像素事实一律取自此脚本，禁止手写 PNG 解码
scripts/html-image-sample.mjs
