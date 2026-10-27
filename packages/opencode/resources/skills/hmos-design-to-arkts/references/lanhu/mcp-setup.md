# 蓝湖 MCP 接入

蓝湖路径通过 skill 脚本连接外部 `dsphper/lanhu-mcp`。安装、登录、参数适配、证据落盘和资源验证都由脚本完成，沿用 Code 的命令执行审批。无需注册内置工具或修改 Code 的 MCP 配置。用户明确禁用的服务不能通过脚本重新连接；已有授权覆盖当前操作时沿用授权。

收到蓝湖链接后先检查 Node.js 22.16+ 与 npm，运行 `lanhu-setup.mjs --action status`。状态查询验证本地安装和已保存的会话，不启动 MCP。用户要求暂不连接时停留在状态查询。以下 `<skillRoot>`、`<runtime>` 与文件路径替换为本机完整路径，并为含空格路径加引号；Windows 用实际盘符和 `python.exe` 路径。

## 准备运行环境与登录

在用户配置目录旁准备独立 Node runtime。安装在工程和 skill 提取目录之外，版本匹配时复用：

```sh
npm install --prefix "<runtime>" --save-exact @modelcontextprotocol/sdk@1.29.0 @zip.js/zip.js@2.7.62 pngjs@7.0.0
node "<skillRoot>/scripts/lanhu-setup.mjs" --action status
node "<skillRoot>/scripts/lanhu-setup.mjs" --action install --runtime "<runtime>"
```

安装器校验源码归档和 uv 下载的 SHA-256，在专用目录准备 Python 3.12.12、完整 MCP 依赖及 Chromium，并校验来源识别补丁。上游采用 [MIT 许可](upstream-LICENSE)。固定 MCP 版本 1.8.7、提交 `6ded5bd906992b0acdd504ce9358e0608a750de1`，固定 uv 0.9.3、FastMCP 3.4.8 和 Playwright 1.64.0；不会自动升级上游。Linux 缺少 Chromium 系统库时报告依赖问题，不自动执行 sudo。

默认私有根目录为 macOS/Linux 的 `${XDG_CONFIG_HOME:-~/.config}/deveco/lanhu`，Windows 为 `%APPDATA%\deveco\lanhu`。macOS/Linux 目录 0700、凭据与连接文件 0600；Windows 设置当前用户 SID 的显式 ACL，在创建凭据前限制目录继承权限。可用 `--root <private-root>` 建立独立测试环境；同一安装、状态与登录操作须使用相同 root。不覆盖已有自定义 MCP 安装或日常浏览器 profile。

`installed` 后再次查询 status。`login_required` 时运行：

```sh
node "<skillRoot>/scripts/lanhu-setup.mjs" --action login
```

先告诉用户会打开专用蓝湖窗口，由用户完成扫码/验证码登录；可用现有命令执行器的后台任务能力保留长命令，并持续报告状态。不重复启动登录窗口，不询问账号密码、Cookie 或令牌。脚本先复用有效凭据或专用会话，只有 API 验证通过才原子保存 Cookie。登录完成后输出 `authenticated`，再查询 status 并继续原链接。关闭窗口、取消或验证失败时保留已有凭据；网络错误先修复网络，不把它当作需要重新扫码。

安装输出包含受信任 Python 和 `connection.json` 路径。安装/登录命令运行中不得重复启动；若被强制终止留下 `.setup-lock`，先确认原命令已结束，再移除该安装器创建的空锁目录并重试。失败报告具体阶段，修复后重试对应操作，不自动循环。

## 验证连接与读取

创建独立的 `<capture.json>`：

```json
{"operation":"tools","server":"lanhu"}
```

在目标工程目录运行：

```sh
node "<skillRoot>/scripts/lanhu-capture.mjs" --config "<capture.json>" --connection "<private-root>/connection.json" --runtime "<runtime>"
```

脚本从独立 runtime 加载 MCP SDK，创建单次 stdio 客户端，确认四个设计读取工具及其 schema：`lanhu_get_designs`、`lanhu_get_design_overview`、`lanhu_inspect_design_region`、`lanhu_export_design_assets`。连接和工具列表可用后，还需实际读取目标设计来确认文件权限、会话和所需数据；不能把 tools 成功当作目标设计或切图成功。

按 `input-contract.md` 初始化阶段 1 并创建读取配置：

```json
{"operation":"overview","server":"lanhu","runDir":".deveco/design-to-arkts-fast/runs/<runId>","url":"<蓝湖设计详情链接>","designId":"<真实设计 ID>"}
```

同一命令支持 `designs`、`overview`、`inspect`、`export`、`install`；operation 及所需字段见输入契约。`designs` 用项目链接返回原始项目列表文件，先检查文件再确定画板，不能默认选列表第一项。`inspect` 仅在阶段 1 完整分页；`export/install` 仅在运行中的阶段 2 处理已选择资源。阶段 1 完成后不替换冻结输入，需补采时建立新 run 并重新分析/确认。每次调用结束或可处理中断时关闭连接与其启动的 stdio 子进程；重新打开 Code 不会由本 skill 自动建立 MCP 连接。

原始 MCP 请求与工具响应保存为 `source/lanhu/raw/` 下的私有文件；PNG 和 ZIP 保存原始字节并校验身份、格式、尺寸及 SHA-256。错误响应也保留供诊断。SDK 负责 stdio、Streamable HTTP 和 SSE 分帧，不在脚本中实现协议解析。连接/工具列表限时 30 秒，工具/资源调用限时 120 秒，单次采集总时限 180 秒（overview/export/install 操作为 300 秒，覆盖 120 秒调用加 120 秒资源读取的串联预算）；资源安装单次限时 90 秒。报错不转发可能含凭据的服务端消息。资源落盘和只读工具白名单是额外校验，命令执行权限并非操作系统文件沙箱。

## 复用已有配置

已有用户选择且可用的 MCP 优先复用，保留 `enabled: false`。提取对应连接到单个私有 `connection.json`，格式如下：

```json
{
  "server":"lanhu",
  "type":"local",
  "command":["<受信任 Python>","-m","lanhu_mcp_server","--transport","stdio"],
  "environment":{"LANHU_ENV_FILE":"<私有 credentials.env>","LANHU_USER_ROLE":"Developer","DATA_DIR":"<私有 data 目录>"},
  "enabled":true
}
```

HTTP 使用 `{server,type:"remote",url:"https://<批准的服务>/mcp",headers:{Authorization:"{env:LANHU_MCP_AUTH}"},enabled:true}`；HTTP 明文仅允许 loopback。远程服务必须提供相同完整工具与资源协议。除 `LANHU_ENV_FILE`、`DATA_DIR`、`LANHU_USER_ROLE` 这三个非密钥字段，environment 和 headers 均用 `{env:NAME}` 引用已有环境变量，禁止内联密钥或在 URL 携带凭据。不得打印、复制到 run 或上传凭据文件。不支持远程 OAuth、企业私有版本或额外域名探测；遇到不兼容时报告具体原因。

安装资源使用 setup 输出的 Python，不能执行 MCP 返回的服务端路径。脚本验证 ZIP、回执、资源身份和工程复制 hash。FastMCP 的 `application/octet-stream` 二进制响应可接受，但仍验证 PNG 实际解码或 ZIP 签名与回执，不接受 HTML 替代资源。

本实现依赖蓝湖网页使用的接口和登录会话，并包含浏览器自动化。Cookie 过期后按相同登录流程恢复；接口或私有化版本变化可能导致不兼容。来源识别读取原始 `meta.host.name=master/mastergo`，将 `source_type=mastergo` 与 `source_format=artboard` 分开，不因数据结构相似误标为 Figma。修复识别产生的新快照使用新 run，保留旧证据。
