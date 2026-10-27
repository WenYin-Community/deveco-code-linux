# 能力 hmos-d2a-lanhu-to-arkui

仅由 hmos-design-to-arkts 的蓝湖 Full/Fast 阶段 2 调用。输入为固定快照的原始图层、干净图片、节点/资源 ID 和现有 ArkUI 工程，不生成中间 JSX，不调用 Figma/Anchor 或 Pixso 引擎。

先读取入口 references/lanhu/input-contract.md。编排调用必须提供 orchestrator=hmos-design-to-arkts、workflowStage=2、confirmationPolicy（Fast=auto-accept，Full=manual）、runStatePath、runDir 和 projectRoot。缺失则报告阻塞，不猜测工程。Controller 管理 Todo/Gate；能力不直接改 workflow-state。

已有 checkpoint 时先与 Controller 状态对齐：awaiting_confirmation 恢复同一方案/确认问题；resume_confirmed_stage 从 implementing（或尚未更新的 awaiting_confirmation）继续实现，不重写已确认文件；completed 不重建页面。只有初次运行创建 analyzing，revision 仅修订用户要求的方案并重新 request。

## 正常生成

1. 校验阶段 1 文件和 hash，读取或创建稳定 invocationId 的 run state，phase=analyzing。inputs 锁定 input-contract 的 8 个文件；developer-provided 模式还锁定用户素材 manifest。恢复从已有 phase 继续，已有 completed 页面不重建。
2. 分析工程范式、资源、公共组件、路由、Index 和历史生成记录，输出 stage2/project-analysis.md。不能修改已有页面以腾出文件名。
3. image-only 调用 recognize_ui_components，使用 input-contract 的固定参数和工具输出路径；复用仅限图片与 requirements hash 均相同。独立本地读取 node-index、region response，结合父级、bounds、文本样式、实际截图确定组件边界；坐标交集不是父子关系，图层名不是组件语义。保留混合文字样式、裁剪、覆盖关系、资源 ID 和显式 gaps，不把未知响应式约束当作来源事实。
4. 按入口能力注册表加载 hmos-d2a-arkui-component-best-practices，选择可复用组件。重复列表/网格、轮播、标签栏优先匹配 List/Grid/WaterFlow/Swiper/Tabs 的实际语义。局部叠层保留为 item 内 Stack，避免固定坐标摆放整页组件或整张图片代替页面。
5. 完成资源选择计划、export、install；Full 确认前只向 runDir 保存资源，不修改工程。真实工程复制与绑定延至确认后；Fast 可直接完成。用户提供图片时按 input-contract 的 developer-provided 分支导入并绑定，不伪造 MCP 资源成功。按契约写选择/交付/绑定文件。缺失关键图片不得换占位块，resolution_limited 与字体未知需记录具体影响及处理。不以 target_dpr 当作设计倍率。
6. 输出 stage2/component-analysis.md、component-tree.md、system-ui-policy.json、viewport-boundary-spec.json。系统状态栏/手势栏按用户偏好与工程能力处理，不把设计中的手机系统装饰重复绘制。
7. 在 capability-invocation-ledger.json 写 hmos-d2a-solution-design invoked（带 stage=2、invocationId），加载并完整执行该能力，传 design_source=lanhu、lanhu_context_path、reference_screenshot_path、component_analysis_path、component_tree_path、project_analysis_path、requirement_clarification_path、save_path=<runDir>/design-doc.md。成功校验后同 ID 更新 completed。不得自己手写 design-doc.md。
8. confirmationPolicy=manual 时，将 phase 设为 awaiting_confirmation，按 references/lanhu/full/stages/02-convert-lanhu-to-arkui.md 执行 Controller request 和主 Agent 的一次方案确认，然后挂起。用户未接受前不得修改工程代码或资源，不得进入 implementing；接到 accepted/resume_confirmed_stage 后读取相同 checkpoint、沿用 invocationId，保留已确认八文件与 inputs hash，不重做分析。写 component-confirmation.json 的 decision=accepted、invocationId；auto-accept 时写 decision=auto-accepted。随后 phase=implementing，依照方案完成资源工程复制与绑定、实现页面并接入已有导航。读取 input-contract 的 startup policy 和 generated manifest 契约，保留 Index @Entry、EntryAbility 和已有默认页；文件名/路由冲突用新名字，不覆盖历史生成页面。
9. phase=validating，检查 ArkTS、边界/遮挡、图片引用和注册；执行实际初次构建，记录 command/exitCode/completedAt/outputPath，写 stage2/initial-build-report.json。
10. 构建和资源检查通过后 phase=completed，返回产物和剩余业务交互给外层 Controller。能力自身不推进阶段或写 run-index。

## 仅恢复设计产物

此模式只用于 Fast；Full 手动确认方案缺失/变化必须遵守确认快照与 revision，不自动重建已确认文件。仅在 Controller payload 指定 operation=restore_design_artifacts、stop_after_design=true、recovery_invocation_id 非空时进入。校验既有 run state、冻结输入、视觉识别和工程/组件分析；保持原 phase、invocationId、ArkTS、资源、路由不变。

已有非空方案产物只读。只补缺失的组件树、系统 UI/视口产物，再以同 recovery_invocation_id 调用 Solution Design 生成 design-doc.md 并完成 ledger。禁止实现、export/install、复制资源、构建或创建完成报告。恢复前后的 phase 必须相同，之后由外层只重试 Controller 返回的 retry。
