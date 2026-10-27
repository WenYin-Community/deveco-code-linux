# 蓝湖输入与工程接入契约

所有下面的文件路径相对 runDir；工程文件路径相对已锁定的 projectRootPath。MCP 数据由 `scripts/lanhu-capture.mjs` 写入，Agent 只读。以下工具操作按实际返回的 snapshotId、bundleId 和 nextOffset 继续，不猜测 ID。

## 阶段 1

需求澄清保留入口既有字段，新增 designSource=lanhu、acquisitionMethod=lanhu-link、assetProvisionMode=lanhu-mcp-bundle。targetPage.pageId=design_id；lanhuSource 记录 mcpServerName、designUrl、requestedVersion、resolvedVersion、snapshotId。未确定节点时 nodeId 留空，不用名称冒充 ID。只问探索工程和设计仍无法确定的信息，一次性澄清。

1. 创建 `{operation:"overview",server,runDir,url,designId?,versionId?}` 配置，按 mcp-setup 的命令运行采集脚本，固化 source/lanhu/target-page-identity.json、overview-response.json、reference.png、component-recognition.png、screenshots-manifest.json、design-context.json。项目列表先用 `{operation:"designs",server,runDir,url}` 配置读取 `lanhu_get_designs` 的原始响应文件并确定画板；PRD/邀请链接不能直接当 UI 详情输入。
2. 将配置改为 `{operation:"inspect",server,runDir,snapshotId,offset:0,limit:30}` 并运行同一采集脚本，不传 region/nodeIds 以收集整画板可见节点及样式。按 nextOffset 连续读取到 truncated=false。node-index.json.complete=true 才代表完整；额外 region/nodeIds 查询仅用于细节，不算整画板分页覆盖。
3. 坐标必须 coordinateMapping.verified=true。图片使用真实 sourceRegion、scale.x/y、宽高和 hash，不要求或伪造原生 1x/2x。带编号图片不作为识别或评分输入；局部文字不可辨认时补充 inspect。设计坐标、截图像素、px/vp/fp 分开处理。
4. 写 inputs-manifest.json：missingInputs=[]，lanhuInputs 为下列 8 个文件各一条 {path,sha256}：target-page-identity.json、design-context.json、node-index.json、region-index.json、screenshots-manifest.json、overview-response.json、reference.png、component-recognition.png，路径均加 source/lanhu/ 前缀。hash 从当前字节计算，64 位小写十六进制。阶段 1 后这些证据保持只读；新增取证需在完成阶段前做完并刷新 manifest。
5. 写 input-security-report.json，status=passed、checks={paths:true,files:true,untrustedContent:true}，记录具体检查结果。验证 runDir 内真实路径、文件大小、来源文本不可信和资源获取状态；阶段 1 资源尚未选择，不标为已安装。

inputs-manifest.json.integrationSnapshot 与现有工程接入契约一致，必须记录真实现状：

```json
{
  "projectRootPath":"<absolute path or path relative to runDir>",
  "runIndexFile":".deveco/design-to-arkts-fast/run-index.json",
  "existingGeneratedPages":[],"existingGeneratedRoutes":[],
  "startupPageBefore":"pages/Index","defaultPageBefore":"",
  "indexPageFile":"entry/src/main/ets/pages/Index.ets",
  "entryAbilityFile":"entry/src/main/ets/entryability/EntryAbility.ets",
  "mainPagesFile":"entry/src/main/resources/base/profile/main_pages.json",
  "registrationMode":"index-navigation"
}
```

Full 时上面及后面的 runIndexFile 必须改用 `.deveco/design-to-arkts/run-index.json`；Fast 使用示例中的 `.deveco/design-to-arkts-fast/run-index.json`。两个 variant 的运行目录和索引隔离，不复制 Gate 或自动切换 variant。

数组必须反映现有 run-index，不能照抄空值。registrationMode 还允许 route-table、existing-router。EntryAbility、Index、main_pages 必须真实存在。保留多来源历史页面及路由，索引只由 Controller 完成阶段 2 时更新。

## 阶段 2

run state 为 stage2/hmos-d2a-lanhu-to-arkui-run.json：invocationId 稳定，phase=analyzing/awaiting_confirmation/implementing/validating/completed；Fast confirmationPolicy=auto-accept，Full=manual；inputs 以阶段 1 的 8 个完整相对路径为键、当前 SHA-256 为值。正常完成时 phase=completed。恢复不得覆盖既有 checkpoint。

识别工具 image=source/lanhu/component-recognition.png、outputPath=stage2/component-vision-analysis.json、requirements=Identify UI components；不传 sourceFile，不把图层或源码塞进 requirements。工具写入的 producer、image/requirements hash、schema 和分析结构由 Controller 校验。ok 时结合原始节点分析；仅已有 schema 2 empty_components degraded 可明确忽略视觉清单，依赖图层、参考和需求继续，记录局限；其他失败 blocked。

产物包含 stage2/project-analysis.md、stage2/component-analysis.md、component-tree.md、system-ui-policy.json、viewport-boundary-spec.json、stage2/component-confirmation.json（Fast decision=auto-accepted；Full decision=accepted、invocationId 与能力 checkpoint 一致）、design-doc.md。Solution Design 是设计文档唯一写入者。

Full 在方案完成后进入 awaiting_confirmation，按当前阶段指令 request 并冻结八份方案文件。accepted 前不修改工程；后续 checkpoint、构建和绑定仍在同一阶段完成。确认快照的 request/accepted/revision、恢复及 Gate 重放与 Figma Full 共用 Controller 实现。

### 资源选择与安装

- stage2/asset-selection.json：{snapshotId,assetIds:[原始选择 ID],emptyReason?}。
- 非空时调用 export，formatPreference 默认 original；按需 prefer_svg/raster 并记录来源回退。使用 `{operation:"export",server,runDir,snapshotId,assetIds,formatPreference}` 采集配置导出；再用 `{operation:"install",server,runDir,snapshotId,bundleId,python}` 安装，其中 python 来自 setup 输出的完整本机路径，使用工具返回 bundleId。不得把服务端路径当本机路径。
- stage2/asset-delivery.json：{snapshotId,bundles:[{bundleId,sha256}]}，sha256 为该 source/lanhu/delivery/<bundleId>/verified.json 当前字节 hash。
- stage2/asset-bindings.json：{snapshotId,assets:[{assetId,nodeId,sourcePath,sha256,projectPath}]}。sourcePath 取 verified.json 的 path；projectPath 是复制到工程的真实相对路径，复制后 hash 一致。格式替代时按 base_asset_id 追踪原始选择。
- 所有选择都必须有完整回执和绑定。不需要外部图片时三个文件显式使用空列表，selection.emptyReason 非空，不调用会报 NoAssets 的 export。原生组件渲染的图层不计为切图遗漏。

### 用户提供本地素材

当用户明确提供原图或导出图片时，可使用 assetProvisionMode=developer-provided；蓝湖图层/截图仍按阶段 1 的 MCP 原始链路取证。已因缺少资源阻塞的运行保留，换用新 runDir，不把本地文件记成蓝湖 export/install 成功。

阶段 1 完成前执行 `node <skillRoot>/scripts/lanhu-import-assets.mjs --run-dir <absoluteRunDir> --assets-file <absoluteJSONFile>`。JSON 是数组，每项 `{path:"<用户实际提供的 PNG 完整本机路径>",nodeId:"<真实节点 ID>"}`。脚本原样复制 PNG，生成 source/user-assets/manifest.json，包含 provenance=developer-provided、快照/版本、图层绑定、尺寸、大小、SHA-256。尺寸对应父分组时绑定父节点，说明裁剪关系；合并截图不会恢复原始矢量、文字或透明通道。脚本不修改图片。

inputs-manifest.json.userAssets={path:"source/user-assets/manifest.json",sha256:"<脚本返回 hash>"}；stage2 run state.inputs 再加该 manifest 路径及 hash。导入文件和 manifest 保持只读。

stage2/asset-selection.json={snapshotId,provenance:"developer-provided",assetIds:[脚本返回的全部 assetId]}。stage2/asset-delivery.json={snapshotId,provenance:"developer-provided",bundles:[],userAssets:{path:"source/user-assets/manifest.json",sha256}}。绑定文件沿用上述 asset-bindings 格式，sourcePath 取导入 manifest 的 path，projectPath 是工程内实际复制路径；每张图片都必须有绑定，复制前后 hash 一致。此模式不构造 MCP bundle/receipt。

合并的控件截图可作为样式/图标参考，用原生控件实现选择和点击，记录哪些内容来自图片、哪些交互按设计推断；不把整页截图作为页面。最终报告分别说明 MCP 数据成功、本地素材成功，以及 MCP 切图导出是否实际完成。

### 页面与初次构建

新页面必须为独立可导出的 @Component export struct，无 @Entry。保留 Index 唯一启动 @Entry 和 EntryAbility.loadContent('pages/Index')，将新页面追加到已有导航或路由；空路由栈也能显示有效首页，不在 build 中重复 push 导航。

stage2/startup-page-policy.json 至少包含：

```json
{
  "projectRootPath":"<same project root>",
  "runIndexFile":".deveco/design-to-arkts-fast/run-index.json",
  "indexPageFile":"entry/src/main/ets/pages/Index.ets",
  "entryAbilityFile":"entry/src/main/ets/entryability/EntryAbility.ets",
  "mainPagesFile":"entry/src/main/resources/base/profile/main_pages.json",
  "preserveIndexEntry":true,"indexRole":"stable-navigation-shell",
  "startupPageAfter":"pages/Index","entryAbilityLoadContentAfter":"pages/Index",
  "projectType":"business","userRequestedDefaultChange":false,
  "changeDefaultPage":false,"defaultPageBefore":"<existing>","defaultPageAfter":"<existing>",
  "targetPageFile":"entry/src/main/ets/pages/LanhuPage.ets",
  "targetComponentName":"LanhuPage","targetRoute":"lanhu-page",
  "targetRegistrationMode":"index-navigation",
  "targetRegistrationFile":"entry/src/main/ets/pages/Index.ets"
}
```

字段必须来自真实项目，不覆盖历史产物。变更默认页仅限用户明确要求，或 template 工程初次生成且 defaultDecisionEvidence={templateHelloWorldOnly:true,hasBusinessHome:false,hasHistoricalGeneratedPages:false}；此时记录 changeDefaultPageReason。

stage2/generated-ui-manifest.json 与根目录 generated-ui-manifest.json 保持一致：

```json
{
  "page":{"file":"<targetPageFile>","component":"<targetComponentName>","hasEntry":false},
  "registration":{"file":"<targetRegistrationFile>","component":"<targetComponentName>","mode":"<targetRegistrationMode>","route":"<targetRoute>","default":false},
  "startup":{"indexFile":"<indexPageFile>","entryAbilityPage":"pages/Index","mainPagesContainsIndex":true}
}
```

初次构建报告 stage2/initial-build-report.json 使用实际 command、exitCode=0、success=true、completedAt（ISO 时间），保留构建输出路径。失败不伪造成功。

## 后续阶段

Fast：阶段 3 写 stage3-report.json，阶段 4 写 stage4-report.json，阶段 5 写 stage5-report.json，均记录 status=completed 和实际产物、未解决项。阶段 4 的 build={command,exitCode:0,success:true,completedAt} 对应交互/HDS 改动之后的真实最终构建。

Fast 不执行 Full 的确认或视觉评分；总结须明确没有执行评分，不能声称还原度达标。构建、资源和路由不完整时不得 completed。

Full：阶段 3/4 复用原 Figma Full 执行规范与相同产物（stage3-interaction-report.md、stage4-quality-audit.json/.md、stage4-build-report.md、hds-decision.json；quality-audit.json.build 记录实际最终构建 command/exitCode/success/completedAt）；阶段 5 调用同一评分父/子能力并写 stage5-visual-calibration-report.json；阶段 6 写 completeness-report.md。参考图固定为 source/lanhu/reference.png，沿用真实 sourceRegion/scale，不使用 Figma JSX 或 1x/2x 约定。默认执行视觉校准，仅用户明确 enabled=false 时允许 skipped；设备/工具缺失应 blocked。
