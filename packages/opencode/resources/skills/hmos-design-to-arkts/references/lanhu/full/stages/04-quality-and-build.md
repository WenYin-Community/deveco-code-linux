# 04 完成 HDS 适配、质量审计与最终构建

本阶段完整复用 `references/figma/full/stages/04-quality-and-build.md`；读取该规范并按相同 Todo、HDS 决策、质量审计及实际最终构建流程执行，入口 Todo 仅同步一次。当前 designSource=lanhu、variant=full，输入为本次蓝湖阶段 2/3 产物。

所有资源继续遵守蓝湖绑定与 hash，用户素材保持 developer-provided 来源；不改写已确认方案或旧取证。输出同一套 stage4-quality-audit.json/.md、stage4-build-report.md、hds-decision.json 及审计报告。构建日志、命令、exitCode 和时间必须对应本次真实构建。

为保留蓝湖已有构建 Gate 的机器校验，stage4-quality-audit.json 同时记录 build={command,exitCode:0,success:true,completedAt}；对应交互/HDS 改动后的真实最终构建，而非阶段 2 的旧构建。
