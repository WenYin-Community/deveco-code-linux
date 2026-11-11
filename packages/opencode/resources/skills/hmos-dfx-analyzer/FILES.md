# DFX analyzer file whitelist
# 主 Skill 加载时随 SKILL.md 一并提供的文件清单（路径相对本目录）。
# 本文件是 DevEco Code 专属约定：`src/tool/skill.ts` 用它决定 `<skill_files>` 列出的
# 精确路径；CLI 包不发布它（CLI 1.0.0 起把同一份清单并入 SKILL.md 正文），所以它由
# 本仓库以 overlay 形式提供——见 `script/skill-sources.ts` 的 loadSkillOverlays。
references/appfreeze/analyzer.md
references/cppcrash/analyzer.md
references/jscrash/analyzer.md
references/white-screen/analyzer.md
scripts/collect/collect-hilog.mjs
scripts/collect/jscrash-report.mjs
scripts/collect/parse-jscrash-log.mjs
scripts/collect/shared/deveco-cli.mjs
scripts/collect/shared/jscrash-parse.mjs
scripts/collect/shared/utils.mjs
scripts/export_report.py
scripts/identify_fault_log.py
