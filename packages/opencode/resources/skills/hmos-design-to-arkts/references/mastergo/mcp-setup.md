# MasterGo MCP 接入

先确认使用网页版、桌面客户端还是企业私有化版本。网页登录本身不等于已授权 Magic MCP。

已有用户明确选择且可用的 MCP 时直接复用。初次接入默认 Magic+Vibe 混合取数：Magic 负责结构化 DSL 与原始素材（getDesignSections/getDsl、extractSvg、CDN 资源 URL），Vibe 补 1×/2× 渲染截图（混合模式下 Vibe 连接仅用于截图与连通性探针，HTML/JSX 导出属纯 Vibe 模式），两通道对同一节点互验。通道选择按下方「来源预检」的判定顺序执行：客户端本地服务可达时用混合取数，Magic 令牌或席位不可用时退为纯 Vibe，由 get_frontend_code 出 HTML 与资源；客户端本地服务不可达时，Magic 可用则纯 Magic + 用户手工导出截图，Magic 也不可用则看社区通道是否可行，都不行按 blocked 处理。Magic 上游提供 exportRender 等位图导出工具后，截图直接由 Magic 获取，混合收敛为纯 Magic。两条官方通道均不适用或无法完成目标取数时，再说明原因并引导用户选择社区插件。配置错误、服务未启动等问题先修复，不把工具列表可访问当作目标设计可读。Magic 的团队版要求不作为 Vibe 或全部官方 MCP 的统一门槛。社区插件继续沿用账号的文件权限和团队策略，不绕过权限限制。

## 来源预检：客户端与 Magic 通道可用性

MasterGo 来源在 `init` 与阶段 1 取数之前先做来源预检，不要求先确定工程、安装 runtime 或启动 Controller。默认 Magic+Vibe 混合取数，截图来自 MasterGo 桌面客户端的本地服务；客户端本地服务是否可达决定截图来源与整条取数路径，因此在选源阶段一次问清，不把这件事留到阶段 1。预检用端口探测确认客户端本地服务（Vibe 截图通道）；Magic 通道按下方「Magic 通道可用性」判定；社区插件连接由 `community/README.md` 的连接验证确认。

探测本机客户端本地服务（默认 `http://127.0.0.1:30678`；客户端被占用端口时会自动改用其余地址，以客户端界面显示的地址为准）。命令用本机 Node.js，版本要求见下方「工作流调用方式」：

```sh
node "<skillRoot>/scripts/mastergo-preflight.mjs"
node "<skillRoot>/scripts/mastergo-preflight.mjs" --connection "<connection.json>"
node "<skillRoot>/scripts/mastergo-preflight.mjs" --endpoint "http://127.0.0.1:30678"
```

`--endpoint` 与 `--connection` 互斥（同传 exit 1）。`--endpoint` 须为完整 URL（`http://` 或 `https://`）并带显式端口：`localhost:30678`、`127.0.0.1:30678`、`http://localhost` 都按参数错误退出 1；端口也不能写成 scheme 默认的 80/443——WHATWG URL 会把它们归一化掉，脚本按"缺端口"报错，从而避免去探本机 80/443 再误报 `available`。`--connection` 传的是连接文件：只有其中 `type: local`、loopback `--url` 且带显式端口时才改探测地址，其余（Magic 云端 `--url`、社区本机服务、企业私有化地址、无端口或无法解析的地址）一律探测默认地址（配置缺省，不报错）；精确定址用 `--endpoint`。

stdout 输出一行 JSON：`{"status":"available","endpoint":"http://127.0.0.1:30678"}`，或 `{"status":"unavailable","endpoint":"…","reason":"ECONNREFUSED|ENOTFOUND|EHOSTDOWN|timeout|error|disabled"}`。`reason` 是底层系统错误码（如 `ECONNREFUSED`、`ENOTFOUND`、`EHOSTDOWN`）、`timeout`、无错误码时的 `error`，或连接文件里 `enabled: false` 时的 `disabled`；状态查询恒以退出码 0 输出这一行，只有参数或文件错误才非零。

探测只确认客户端本地服务端口存活，不建立 MCP 会话：Vibe 适配器在客户端停止时仍本地应答 `tools/list` 和 `get_version`，这两项不能作为探针；真实读取在阶段 1 完成。端口可达不等于取数成功：其余程序占用同一端口同样返回 `available`，这是端口口径的已知边界，不用 MCP 协议探测替代。loopback 地址探测失败可判定客户端本地服务不可用；非 loopback `--endpoint` 的结果受本机网络（TUN、透明代理等）影响，只能作为参考，不能据此判定客户端可用性。

### Magic 通道可用性

Magic 通道是否可用以真实只读结果为准，不按某个环境变量是否存在判定。按下面顺序判定，结论分为 `未配置`、`已配置`、`已配置但鉴权/席位失败` 三种：

1. 先查本机已配置的 MasterGo Magic 连接：全局 `~/.config/deveco/deveco.jsonc` 的 `mcp.mastergo-magic`（或项目级配置文件中的同名条目），或技能 runtime 里已有的 `connection.json`。存在时复用该连接及其启动脚本的令牌装载方式，不以 `MG_MCP_TOKEN` 缺失判定不可用；令牌与席位以该连接的真实只读调用（`getMeta` 或目标画板的 `getDesignSections`）结果为准。
2. 没有已配置连接时，才检查 `MG_MCP_TOKEN` 是否存在并按下方令牌引导配置一次；存在时同样以真实只读调用为准。
3. 两处都没有判定为 `未配置`。已配置但真实读取返回鉴权错误或席位不足（如 10003）判定为 `已配置但鉴权/席位失败`，按下方令牌/席位引导一次性给全，不把“新建个人访问令牌”当作默认动作。
4. 预检在 `init` 前确定配置状态；真实只读调用需要 run 目录时，在用户选定通道并 `init` 后、阶段 1 的初次真实读取时立即执行，读取成功即可用，失败按第 3 条处理并回到社区通道或 blocked。任何情况下都不读取、打印、复制或回显令牌内容（也不通过遍历 shell profile、Keychain 或系统凭据库来判断可用性），只判断可用或不可用，也不把令牌写进聊天、工程、capture 配置或设计产物。

`available` / `unavailable` 按下面顺序决定通道，用户确认后继续：

1. `available`（客户端本地服务可达，默认端口 30678）→ 默认混合取数：Vibe 补 1×/2× 截图，Magic 出结构化 DSL 与素材；Magic 通道不可用（按上文「Magic 通道可用性」判定）时退为纯 Vibe，由 get_frontend_code 出 HTML 与资源。
2. `unavailable`：
   a. Magic 通道可用（按上文「Magic 通道可用性」判定：本机已配置连接优先，`MG_MCP_TOKEN` 只作无连接时的依据，令牌与席位以真实读取为准；`未配置` 时先按下方令牌/席位引导一次，`已配置但鉴权/席位失败` 按引导给全后仍失败才算不可用）→ 纯 Magic + 用户手工导出截图，用户确认后继续。
   b. Magic 不可用 → 社区通道可行时（用户能在 MasterGo 里运行插件，本机 3000 服务可启动）按社区插件通道引导；社区截图来自 `node.exportAsync`，不以客户端本地服务端口为前提。
   c. 以上都不行，或用户不接受任何通道 → blocked（`dependency_unavailable`）。

面对用户时仍是两条路：**路径 A** 恢复客户端本地服务（回到 1）；**路径 B** 不用客户端继续——Magic 可用走 B1 手工导出（2a），Magic 不可用走 B2 社区插件（2b），都不行即 2c blocked。用户选定后才继续，不得直接 `init` 让阶段 1 才暴露取数失败。

用户已声明社区插件模式时，本预检不作为门禁：社区截图来自 `node.exportAsync`，不依赖客户端本地服务端口，按 `community/README.md` 校验插件运行与本机服务。

**路径 A · 启动或安装客户端后继续自动化取数**：未安装时从 [MasterGo 官网](https://mastergo.com) 下载安装桌面客户端；未启动时打开客户端，窗口关闭但 Dock/任务栏图标仍在的后台运行态同样可用，从 Dock 完全退出则不可用。网页版登录不等于客户端可用；本 skill 的本地开发插件导入流程（`community/README.md`）需要桌面客户端，网页版走团队已发布插件列表运行。随后登录、打开目标文件，确认文件内 MasterGo MCP 处于连接状态，用客户端显示的地址重跑一次探测，`available` 后继续。

**路径 B1 · 手工导出图片（2a）**：用户只导出图片，DSL 与素材仍走 Magic。向用户提出这条路径时，同一条消息一次给全下面四项，不分轮补充：

- 导出清单：目标画板整页 PNG 1×（用于组件识别，必须提供）；同一画板 2× PNG（用于参考比对，可选；只有 1× 图时可同时作 reference 与 recognition）；DSL 中图片资源 URL 无法下载时，按画板导出这些图片的原图，SVG 图标由 `extractSvg` 提供，不需要导出。
- 放置目录：本次 run 的导出根目录 `<runDir>/source/mastergo/export/`（相对工程根；`init` 后 run 目录已存在，`export` 子目录按需创建），文件名能区分倍数（如 `board-1x.png`、`board-2x.png`）；预检阶段用户可直接给出图片所在路径，`init` 后复制进该目录再导入，不放进工程其余目录，也不改写设计源。
- 导入配置：以 `recognition.scale=1`、`reference.scale` 为 1 或 2 引用。
- 体积与像素上限：单文件 ≤10 MiB、总量 ≤100 MiB、像素 ≤4000 万。

索要图片与这四项同批给出：明确要求用户提供图片，用户可直接给出图片所在路径，`init` 后复制进上述导出目录。索图时同时说明：用户无法提供截图时按缺失输入（`missing_asset`）把阶段 1 置为 blocked。capture 脚本会校验导出目录里的截图，缺图或图片过小时拒绝取数。未拿到 1× PNG（及可选的 2×）前，阶段 1 不算完成取数——缺图按缺失输入阻塞，不先把 DSL 与素材取完再回头要图，也不以占位图、渲染图或生成图代替；阻塞命令为 `node <skillRoot>/scripts/workflow.mjs --mode stage-complete --run-dir <runDir> --stage 1 --result blocked --reason-code missing_asset`。

**路径 B2 · 社区插件通道（2b）**：Magic 不可用时按下方「用户选择的社区插件 MCP」引导安装、启动本机 3000 服务并连接插件；社区截图来自 `node.exportAsync`，不依赖客户端本地服务端口。

按 2c 报告 blocked（`dependency_unavailable`）时如实说明，不伪造截图或 DSL，也不切换设计来源。

预检结论与用户选择由阶段 1 写入 `requirement-clarification.json` 的 `mastergo` 块（`channel`=mixed/vibe/magic-manual/community，见 `references/requirement-clarification.md`）；入口、阶段 1 与恢复流程按该记录沿用通道，不重复询问；记录缺失或按记录读取失败时，按上面的判定顺序重新取得用户选择。

## 工作流调用方式：独立 skill 脚本

本适配不向 Code 注册内置工具，也不要求在 Code 的 MCP 列表中注册服务。Code 通过现有命令执行能力运行 skill 脚本，脚本使用安装在外部目录的 MCP SDK，直接连接官方或社区服务。不要修改 Code 核心、工具注册表或模型工具权限实现。

助手先检查 Node.js 22.16+ 和 npm，在用户配置目录旁的独立 runtime 目录安装固定依赖，已有版本匹配时复用。`<runtime>`、`<skillRoot>` 均替换为绝对路径；Windows 使用实际盘符路径并给含空格路径加引号。安装过程沿用 Code 现有命令执行审批，不在技能提取目录或目标工程中写 node_modules。

```sh
npm install --prefix "<runtime>" --save-exact @modelcontextprotocol/sdk@1.29.0
```

连接信息保存到用户配置目录中的独立 `connection.json`，字段见下面各方案。它是单个连接描述，不是完整的 Code 配置文件。复用已授权的现有配置时，只提取对应连接的 type、command、environment 或 url、headers，并补上 server 名；不覆盖 Code 配置、不读取并输出令牌。environment 和 headers 的值只支持 `{env:NAME}` 引用，不支持内联密钥、配置继承或远程 OAuth 登录。禁用的配置必须保留 `enabled: false`，不能换通道绕过用户的禁用决定。

本机已存在从本地令牌文件读取令牌的 MasterGo Magic 连接时（例如连接命令指向本机启动脚本，脚本从 `~/.config/deveco/mastergo/token.txt` 读取权限 600 的令牌），优先复用该连接的启动方式，`connection.json` 的 `command` 与环境变量按该连接原样写，不需要 `MG_MCP_TOKEN`。需要使用技能独立 `connection.json` 的 `{env:MG_MCP_TOKEN}` 时，在运行 capture 的命令行上从本地令牌文件注入该环境变量：`MG_MCP_TOKEN="$(cat <令牌文件>)" node "<skillRoot>/scripts/mastergo-capture.mjs" --config <capture-config.json> --connection <connection.json> --runtime <runtime>`；不回显令牌内容、不写入任何文件、不改用户的全局配置。两种令牌装载机制二选一即可。

连接配置就绪并初始化 MasterGo 阶段 1 后，以以下内容创建 `<capture-config.json>`：

```json
{
  "operation": "tools",
  "server": "mastergo-magic",
  "runDir": ".deveco/design-to-arkts-fast/runs/<runId>"
}
```

在目标工程目录执行：

```sh
node "<skillRoot>/scripts/mastergo-capture.mjs" --config "<capture-config.json>" --connection "<connection.json>" --runtime "<runtime>"
```

脚本校验阶段、路径和只读规则后才建立连接；`tools` 返回实际服务中符合白名单的工具和 schema。允许 Magic 的 `getDesignSections`、`getDsl`、`getD2c`、`extractSvg`、`getPageLayers`、`getMeta`；Vibe 的 `get_frontend_code`、`get_selection_node`、`get_selection_code`、`get_screenshot`、`get_selection_image`、`get_variables`；社区的四个 `mastergo_api_*` 工具。白名单是脚本层各模式工具的并集；混合模式下 Vibe 连接的实际调用范围以 acquire.md §5 为准（仅 get_screenshot 与连通性探针）。使用实际工具名，兼容 `mcp_` / `mcp__` 前缀。`extractSvg` 按 `page` / `pageSize` 分页返回图标 SVG：先不带 `page` 调用取 `totalCount`，再以 `page=0…n` 逐页提取。`getPageLayers` 用于目标发现：用户只给 page_id 时枚举该页画板候选（详见 acquire.md 的实测限制）。

每次读取将配置改为 `{operation:"read",server,runDir,tool,arguments}`，再运行同一命令。脚本一次完成参数归一化、连接、调用和原始响应落盘；stdout 返回 `requestPath`、`responsePath`、`sha256`、`outputDir`、`isError`，不输出完整设计数据。归一化请求和响应均以私有文件保存，不覆盖不同内容；错误响应保留但退出非零，不能作为成功设计输入。随后使用 `mastergo-source.mjs` 导入和 Controller 校验。

脚本遵循命令执行权限，不复用 Code 内部 MCP 会话、MCP 单工具授权或插件钩子；不得把命令审批描述成 MCP 逐工具审批。用户明确禁止的服务、工具或数据访问同样不能通过脚本调用。只读限制由脚本及社区服务执行，脚本将证据输出限制在本次 run 内；命令执行本身不是操作系统级文件沙箱。每次命令创建独立客户端，在成功、失败或可处理的中断后关闭连接及其启动的 stdio 子进程；社区常驻服务和 MasterGo 插件仍由独立启动器管理，不随单次取数退出。

## Magic MCP：结构化 DSL 与原始素材

官方 Magic 文档要求团队版及以上的编辑席位或研发席位，设计文件位于有访问权限的团队。令牌正确但账号席位不足时，Magic 服务端返回错误码 10003；席位生效后同一令牌即可继续取数。还需要 Node.js 18+、npm 8+，以及个人设置 → 安全设置生成的个人访问令牌。令牌由本机既有连接或启动脚本从本地令牌文件读取（如 `~/.config/deveco/mastergo/token.txt`，权限 600），或由用户在运行 Code 的本机环境中设为 `MG_MCP_TOKEN`；任何情况下都不读取、打印、复制或回显令牌内容，也不写入聊天、工程、capture 配置或设计产物。

席位门槛速查：Magic 数据读取（getDesignSections、getDsl、extractSvg、getPageLayers、getMeta）= 团队版及以上的编辑席位或研发席位，席位不足返回 10003；D2C PRO 页面与「发送数据」插件（contentId 唯一来源）、getD2c = 企业版研发席位或编辑席位，且文档所在团队必须为企业版，门槛不符返回 10013（权限校验先于 contentId 校验）。遇到 10003/10013、找不到 D2C PRO 入口或「发送数据」按钮时，结论是席位/团队版本门槛而非配置错误：引导用户核对席位与团队版本，不反复重试配置、不猜测 contentId。

令牌获取与配置引导：个人访问令牌在 MasterGo 网页的个人设置 → 安全设置 → 个人访问令牌区块新增并复制。判定令牌缺失、失效或席位不足（连接失败、鉴权错误或 10003）时，一次性给出完整引导：在上述页面新增个人访问令牌；按席位门槛速查核对席位与文档团队权限；把令牌保存到本机令牌文件并由既有连接读取，或设为运行 Code 的本机环境变量 `MG_MCP_TOKEN`（独立 connection.json 以 `{env:MG_MCP_TOKEN}` 引用；两种装载机制二选一，不粘贴到聊天、工程或设计产物，也不读取或回显令牌内容）；再用同一连接重跑一次真实读取（如 `getMeta` 或目标画板的 `getDesignSections`）验证令牌生效——工具列表可访问不等于目标可读。引导一次到位，不反复重试或改猜其余配置；具体生成与生效步骤以官方帮助页为准。

`getDesignSections` / `getPageLayers` 读取服务端缓存，画布编辑后不即时反映：重定位节点后 DSL 仍返回旧坐标，新增画板不会出现在页面枚举中。编辑后的取数以 `get_screenshot` 截图校验为准；由此产生的 DSL↔截图不一致即缓存滞后，按 acquire.md §5 记录差异并与用户澄清，不以陈旧 DSL 否定当前画布。定位新增画板用其 nodeId（网页链接 layer_id）直连读取，不依赖页面枚举。

在同一 runtime 安装固定官方包：

```sh
npm install --prefix "<runtime>" --save-exact @mastergo/magic-mcp@0.2.10
```

独立 `connection.json` 示例：

```json
{
  "server": "mastergo-magic",
  "type": "local",
  "command": ["node", "<runtime>/node_modules/@mastergo/magic-mcp/dist/index.js", "--url=https://mastergo.com"],
  "environment": { "MG_MCP_TOKEN": "{env:MG_MCP_TOKEN}" },
  "enabled": true
}
```

使用安装包 package.json 的真实 bin 入口；本示例适用于固定 Magic 版本。用 Node 执行入口文件，避免 Windows 的 npx.cmd/shell 差异。走该示例时 `MG_MCP_TOKEN` 按上文从本机令牌文件注入命令或由本机既有连接装载，不写入 capture 配置或设计产物；本机已存在从令牌文件读取令牌的 MasterGo 连接时优先复用其启动方式与安装目录，脚本仍独立建立客户端连接。

## Vibe MCP：渲染截图与前端代码

Vibe 可用性取决于 MasterGo 桌面客户端的本地服务：打开客户端，或保持后台运行（窗口关闭、Dock 图标仍在），且目标文件已打开、文件内 MasterGo MCP 处于连接状态，Vibe 即可用；从 Dock 完全退出后不可用，工具调用返回「获取失败: Network Error」。判定可用性用实现层探针：入口按上方「来源预检」运行 `scripts/mastergo-preflight.mjs` 确认本地服务端口存活（默认 30678，被占用时自动切换，以客户端显示地址为准），阶段 1 再用一次 `get_selection_node` 真实读取确认目标可读；`get_version` 由 vibe-mcp 适配器本地应答，本地服务停止时同样返回成功，不能作为探针。客户端主进程可能已退出而服务进程存活（后台运行态），不以进程状态判定可用性。用户当前在网页版还是客户端编辑与 Vibe 可用性无关，只按上述探针判定。不需要个人令牌。官方 Vibe 文档的准备项未列出会员或团队版门槛；按实际客户端连接和工具读取结果判断可用性，不据此承诺所有账号均免费或可用。

在 runtime 安装 `@mastergo/vibe-mcp@1.0.31`，从安装包 package.json 的 bin 字段取得实际 JavaScript 入口；以 Node 执行该入口，并传入 `--url=http://localhost:30678`。connection.json 使用 `server: "mastergo-vibe"`、`type: "local"`、上述 command 数组、`enabled: true`，不需要令牌。不要猜入口文件名或改为执行 Windows `.cmd` 文件。

本机端口可能变化，使用客户端显示的实际地址。官方帮助页中的旧工具名 `get_selection_code` / `get_selection_image` 在 1.0.31 已变为 `get_selection_node` / `get_frontend_code` / `get_screenshot`，必须先读取实际 tools schema，不能盲猜调用。

`get_screenshot` 对同一节点的不同倍数写入同一 Server 路径（`~/.mgmcp/resources/screenshots/{fileId}/{nodeId}/`，文件名不含倍数后缀），后取的倍数覆盖先取的；按 2×→1× 顺序获取，或每取一个倍数立即复制进 run 的 export 目录。`get_frontend_code` 的 `frontendFramework` 为必选七选一（html/vue/react/wxml/angular/android/json）；capture 脚本固定传 `html` 是有意行为——html 是本 skill 的中间格式，由适配器锁定后转换为 ArkUI，不是遗漏的参数化。

## 用户选择的社区插件 MCP

已实测的社区实现为 https://github.com/burnice-cn/mastergo-mcp-server ，固定提交 `0b710a4b9d8f580ccd91945b0328b22b7e398f51`，MIT。它通过普通插件 API 连接当前画布，本机 Streamable HTTP 地址为 `http://127.0.0.1:3000/mcp`，WebSocket 为 `ws://127.0.0.1:3000/bridge`。能否加载和导出仍取决于实际账号、文件权限与团队插件策略，不保证适用于所有套餐或私有版本。

助手按 `community/README.md` 下载固定提交、应用随包补丁并构建服务和插件，再用 `scripts/mastergo-community-start.mjs` 启动本机服务；启动器自动生成或复用私有配对凭据。已有安装时先复用，不要求客户手工处理依赖。

- 桌面客户端：可以导入构建后的 `mastergo-api-bridge/plugin/manifest.json` 并运行，本地调试无需发布到团队。
- 网页版：不能导入本地开发插件，需要先由发布者把插件发布到团队，再由成员在团队插件列表中找到并运行。团队发布后的网页版入口已由用户实际确认；每位成员仍需在自己的电脑上运行 DevEco 本机服务，并检查当前浏览器能否完成本机连接、节点读取和资源导出。

更新既有插件保留 manifest `id`，从原开发插件发布更新；修改本地文件不会自动更新团队已发布版本。团队发布与更新由有相应权限的发布者完成。

首次点击“连接 DevEco Code”，在本机系统确认框核对配对码后由用户点击“允许连接”；不要求用户获取个人 Token 或复制本机口令。本机服务直接弹出系统确认框，无需网页跳转；无法弹出时明确报错，保留手动连接兼容入口。配对后按当前文件保存本机连接，重新运行自动连接；主动断开会清除本机记录。助手不能代替用户提交真实配对确认。手动口令入口仅用于兼容。服务绑定 loopback，发布包不内嵌凭据。团队发布只是分发插件，每位成员仍需启动本机服务。

“后台运行”隐藏面板，可通过 `mastergo_connection_panel(action=show)` 唤回原实例。从插件菜单重新运行可能重启实例，此时自动恢复会建立新连接；点击 × 仍会结束插件。不要把重启后恢复等同于全程不断连。

社区 connection.json 使用：

```json
{
  "server": "mastergo-community",
  "type": "remote",
  "url": "http://127.0.0.1:3000/mcp",
  "enabled": true
}
```

同一脚本通过 Streamable HTTP 连接常驻服务。`tools` 发现四个 mastergo_api_* 工具，`read` 执行 mastergo_api_scheme、mastergo_api_call 请求。只允许白名单中的文档/节点读取与公开导出方法，拒绝 node.remove 和任意执行代码；node.export / node.exportAsync 的 maxBytes 固定为 3 MiB。先读取 mg.document、mg.getNodeById、node.findAll 核对文档及目标，再导出同一节点的 PNG 和资源。原始响应与实际调用参数一起落盘，导入契约使用 community/nodes，见 input-contract.md。

面板唤回 `mastergo_connection_panel` 属于连接管理操作，不在设计取数白名单内；使用已有外部 MCP 配置的管理工具，或在 MasterGo 菜单重新运行插件恢复连接，不扩大取数脚本白名单。

上游二进制序列化使用了沙箱没有的 btoa；随包补丁已改用纯 JavaScript Base64 编码，此修复此前通过真实 PNG 导出复核。不能把浏览器可用的 btoa 或 Node Buffer 假定为插件沙箱全局。上游精简节点摘要未提供完整字体、填充与组件属性，须结合真实截图和资源分析，缺失信息明确记录。一键配对与重启恢复已覆盖自动化测试，真实客户端验收仍需另行记录。

## 企业私有化

Magic 的 `--url` 支持指定服务地址，但不证明任意私有版本兼容。由用户/企业提供批准的域名、网络条件及认证配置；验证工具能否读取目标项目。企业 SSO、证书、API 版本不匹配时停止并说明原因，不退回抓 Cookie 或探测其他内网地址。Vibe 仅在企业客户端实际提供对应本地服务时可用。

该适配只调用设计读取/导出工具，不写回画布。官方服务可能提供编辑工具，脚本不允许调用；其他客户端自行连接时仍需独立限制工具暴露。MCP 本地运行不意味着模型调用、资源下载或 npm 安装均不访问外网。

官方依据（接入要求于 2026-10-22 核对，工具名以固定包的实际 schema 为准）：
- https://mastergo.com/help/ai-features/magic-mcp.html
- https://mastergo.com/help/ai-features/vibe-mcp.html
- https://github.com/mastergo-design/mastergo-magic-mcp

本次实际核验的包版本为 Magic 0.2.10、Vibe 1.0.31，均通过 MCP tools/list 检查；Magic 0.2.10 的 12 个工具中除 `version_0_2_10` 外均以 `mcp__` 前缀注册。Magic 真实账号设计取数已于 2026-10-29 实测通过（getDsl、getDesignSections、getMeta，真实画板 documentId 207413499401404 / 画板 1:02）；`extractSvg` 两步分页于 2026-10-30 实测：0 图标画板确认分页语义（带 `page` 时含 `page` / `pageSize` / `hasMore`），4 图标画板（nodeId 40:02）确认条目形态 `{totalCount, count, svgs:[{name, id, svg}]}` 与映射规律——`svgs[].id` 为图标 FRAME（PATH 父容器）的 nodeId，与携带 `S{i}#0` 的 PATH 按遍历顺序 4/4 对齐；`getPageLayers` 以合成 page_id `M` 实测（缓存命中返回 layers 与 `source:"cache"`）。`getDesignSections` / `getPageLayers` 的服务端缓存行为（画布编辑后不即时反映）已于 2026-10-30 实测记录；token 设置页路径（个人设置 → 安全设置 → 个人访问令牌）于 2026-10-16 实拍核对。Vibe 的 `get_screenshot`、`get_frontend_code` 已在同一画板实测（1×/2× 截图落盘、HTML+图片资产+自动 1:1 截图导出、frontendReviewSession 协议）；Magic DSL 与 Vibe 截图的同节点组合取数及跨通道 sha256 一致性已组件级验证，混合通道的完整阶段 1 端到端验收已于 2026-10-30 通过独立 e2e（混合/降级/纯 Vibe 三用例，5/5 阶段、Gate 零 issue）。私有化联调及真实 Full 视觉评分验收尚未完成，不得将协议检查或自动化测试描述为这些验收已通过。

## 执行权限与错误处理

本方案采用命令执行权限作为调用入口，不提供 MCP 逐工具弹窗或单独的文件编辑审批。命令授权已有明确范围时直接沿用；用户拒绝连接、关闭连接配置或禁止某项取数时，不得改用脚本或另一通道规避。脚本的工具白名单、`enabled=false` 和 run 路径校验是额外限制，不能替代宿主命令权限或操作系统隔离。

本地输入、资源大小、证据冲突与文件写入错误保留可操作说明；远端 SDK 错误只报告连接、工具列表、工具调用、超时或取消等类别，不回显服务端错误正文。连接与工具列表限时 30 秒，工具调用限时 120 秒，整个采集命令限时 180 秒；HTTP/SSE 读取沿用请求的取消信号，不能提前套用连接超时。

技能 SDK 固定版本由 `scripts/mastergo-connection.mjs` 的 `MASTERGO_SDK_VERSION` 定义。技能验证在独立 runtime 中执行，不借用 Code 核心 SDK，也不放入 Code 单元测试目录；离线环境预装相同版本并通过采集命令的 `--runtime` 参数指定目录。升级技能 SDK 时同步安装说明并完成独立协议验证，核心 SDK 升级不要求技能跟随升级。
