# 04 质量检查与最终构建

## 阶段入口

读取本次成功 stage-start 返回的 todoPayloadPath，原样把 .todos 调用一次 todowrite。同步成功后才执行以下工作。正常完成后 stage-complete --stage 4 --result passed；失败使用现有稳定 reason code blocked，并保存具体原因。

按用户 hdsUsagePreference 决定是否加载 hmos-d2a-arkui2hds（references/capabilities/hmos-d2a-arkui2hds/INSTRUCTIONS.md）并完整执行；不使用 HDS 时记录依据。

检查 ArkTS、组件范式、图片真实引用、坐标/安全区、长页滚动、Index 空导航栈和历史页面保留。执行交互/HDS 改动后的最终构建，保留真实日志。写 stage4-report.json：status=completed、build={command,exitCode:0,success:true,completedAt}、checks、outputPath 和已知限制；失败用 build_failed。
