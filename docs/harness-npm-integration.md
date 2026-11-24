# npm、curl/irm 和 Studio 的内置 Harness 集成

npm、curl/irm、Studio 和源码开发均通过 Harness 提供 CLI、专用工具、ArkTS 规则和 SDD 工作流。宿主保留配置、会话、模型调用、权限执行和插件生命周期。

## 版本和安装

`packages/opencode/package.json` 的 `builtinPlugins` 是产品构建清单，指定 `@deveco-test/deveco-harness` 的精确版本。`script/publish.ts` 和 `script/release.ts` 将这项依赖写入发布主包的标准 `dependencies`：

```json
{
  "dependencies": {
    "@deveco-test/deveco-harness": "0.2.0-test.13"
  }
}
```

用户安装 DevEco Code 时，由 npm 自动下载并安装 Harness 及其依赖。常见布局为：

```text
node_modules/
├─ @deveco/deveco-code/
│  └─ bin/
└─ @deveco-test/deveco-harness/
   ├─ dist/
   ├─ prompts/
   └─ vendor/
```

包管理器也可以将依赖安装在 `@deveco/deveco-code/node_modules/` 下。代码通过标准模块解析兼容这两种布局，不复制 Harness 到宿主的 `vendor`，不将其依赖树重新打进平台包。

## curl/irm 安装

`script/build.ts` 同样把产品清单写入平台产物 `package.json` 的 `dependencies`。ZIP 中只携带这份依赖声明，不携带已安装的 Harness。

`install` 和 `install.ps1` 在临时版本目录中保留该清单，执行 `npm install --prefix <目录> --omit=dev --ignore-scripts --no-audit --no-fund`。依赖安装完成后才切换版本目录和启动器；npm 失败时原启动器保持不变。重新安装已有版本时，也会修复缺失的依赖，无需重新下载 ZIP。本地 `--binary` / `-Binary` 安装使用同样的处理。

默认位置为：

| 系统    | Harness 安装位置                                                                             |
| ------- | -------------------------------------------------------------------------------------------- |
| macOS   | `~/.local/share/deveco/versions/<版本>/node_modules/@deveco-test/deveco-harness`             |
| Windows | `%USERPROFILE%\.local\share\deveco\versions\<版本>\node_modules\@deveco-test\deveco-harness` |

设置 `XDG_DATA_HOME` 时沿用安装器原有的数据目录规则。新版本安装需要 Node.js 22+ 和 npm；没有依赖清单的旧版本继续使用原有安装流程。版本目录中的 `package.json` 作为普通运行时项目使用，移除只用于 npm 平台包筛选的 `os` / `cpu` 限制，兼容 Rosetta 下的 Node。

## 启动加载

`src/plugin/builtin-harness.ts` 从当前可执行文件对应的 npm 包目录创建 `createRequire`，解析 `@deveco-test/deveco-harness/server`。使用这个入口是因为编译后二进制的 `import.meta.url` 位于 bunfs，无法代表磁盘中的 npm 安装位置。

如果可执行文件旁没有该依赖，再通过宿主已有的 `resolveInstallRoot()` 定位当前版本目录。这覆盖 curl 的软链接及 irm 复制到 `.local/bin` 的启动器，同时保持 npm 安装依赖优先。

解析得到的本地文件路径交给现有 PluginLoader，复用初始化、config Hook、工具、事件和销毁流程。用户不需要添加 `plugin` 配置；启动时不额外联网安装 Harness。

同一实例中的 Harness 仅成功初始化一次，兼容用户此前手动配置的 Harness。`applyPlugin` 保持原来的签名和实现。默认模式和 Studio 模式均自动加载；`DEVECO_DISABLE_DEFAULT_PLUGINS` 和 `DEVECO_PURE` 继续跳过新增的内置来源。

## Studio 交付

IntelliJ 插件的 `bundleLocalCli` 在复制 CLI 平台产物后，调用 `script/bundle-builtin-plugins.ts` 安装产物清单中的生产依赖，再生成资源提取清单。安装按 `cliTarget` 指定的操作系统和架构选择依赖，禁用安装脚本，并复制依赖文件，避免打包依赖外部缓存的链接。

Studio 启动时从插件资源中解压完整的 `node_modules`，在 `<IDE-system>/@deveco/node_modules/@deveco-test/deveco-harness` 解析服务器入口，复用现有 PluginLoader。运行时不需要联网安装，也不需要用户添加 `plugin` 配置。

Harness 在 `config` Hook 中将完整 Skill 及配套资源安装到 `<DEVECO_STORAGE_ROOT>/config/skills/<name>/`，并等待安装完成后再进入宿主 Skill 发现流程。Studio 继续使用原有目录扫描、启用状态和斜杠菜单过滤逻辑，不增加 Harness 专用路径或额外过滤入口。Harness 通过资源哈希管理自身安装的更新，保留用户已有的同名 Skill 和本地修改。

DevEco Code 的发布产物和源码开发均使用清单中指定的 Harness 版本。更新依赖时，同步修改 `builtinPlugins`、`dependencies` 和 `bun.lock`。四个 Skill 由 Harness 提供，Studio 通过配置目录发现它们。

## 当前边界

源码开发直接安装 `packages/opencode/package.json` 声明的 Harness 依赖，并优先从源码包目录解析。手工复制 exe 或解压不含依赖的 ZIP 不提供 CLI 回退；应使用包含 Harness 依赖安装步骤的交付入口。OpenHarmony 独立交付需遵循相同依赖契约。

宿主只构建自身维护的 Skill，ArkUI、DFX、CLI 和 DeepLink 验证 Skill 由 Harness 交付。升级时旧的原生 Skill 依靠已有 `.version` 标记清理，保留配置目录中的插件资源和用户修改。

测试使用本地归档服务器及真实 npm 安装，覆盖 curl/irm 首次安装、带空格路径、依赖修复、npm 失败后保留旧启动器、Windows PowerShell 5.1/7 以及启动器的版本目录回退定位。curl 流程在 Git Bash 中模拟 macOS，尚未进行 macOS 实机验证。

Windows x64 实际构建产物另通过隔离目录安装和启动验证：Harness 位于版本目录的 `node_modules`，宿主没有 `vendor/harness`，Goal 引用该依赖的 SDD 资源，四个 Skill 文件齐全。调试只使用内存中的测试模型身份，没有调用模型服务或设备。

## 工具、规则与 SDD 的归属

`switch_cwd`、`plan_write`、`plan_enter`、`plan_exit`、`spec_write`、`verify_ui`、`get_ui_verification_log`、`save_ui_screenshot` 均通过 Harness 的 `tool` 导出进入通用工具适配器。宿主不再注册同名原生实现；关闭 Harness 时也不提供这些工具的原生回退。

ArkTS 规则与 codebase / HomeGraph 检索路由均由 Harness 的 `experimental.chat.system.transform` 注入，宿主不再维护 `agent/rules.ts`、`agent/prompt-parts` 或规则副本。DFX Agent 的定义、权限和提示词以及 `/analyze` 均由 Harness 配置提供；宿主不再保留原生 DFX 定义或提示词副本。通用命令注册表以及原生预算 Goal 命令保留。

普通模式的 `build.txt` 只标记提示词由 Harness 提供。Harness 在插件 hook 中按 HomeGraph 工具是否已注册（`homegraph_*` 插件工具 + vendor schemas）选择 codebase 路由文案，宿主不再额外注入检索路由。

SDD 的 `goal`、`spec-implementation`、`spec-verify` Agent 由 Harness 配置提供，命令和模板直接读取其 `dist/sdd` 目录。Agent 缓存生成前等待插件配置完成；宿主不再嵌入、解包或维护旧 `resources/spec` 资源。其他 Agent 的原生提示词和 Studio profile 保留。

UI MCP 的依赖、运行时资源和启停由 Harness 管理，通过已有插件 `dispose` Hook 清理。设计稿工具及其共享视觉模型配置仍在宿主维护。

宿主通过工具上下文的可选 `notifyFileChange` 回调接收插件写入通知，复用原生 `write` 的文件事件和 LSP 诊断流程。Harness 的 `spec_write` 在文件落盘、格式化完成后调用该回调，再执行文档结构校验。

UI 验证专用事件 `DevEcoCodeVerify` 的类型、队列和上传由 Harness 独立维护，宿主不再保留对应事件类型、队列校验或专用上报测试。宿主继续从工具结果读取 `uiVerificationModel`，用于通用会话统计。Harness 的同步脚本不再从宿主读取 UI 验证统计类型。

计划切换通过 SDK 提交不触发模型的消息。宿主的 `prompt_async` 收到 `noReply: true` 时，先保存消息再返回，避免旧版 Harness 的工具完成后仍按旧模式继续一轮；新版 Harness 优先使用同步确认接口。

## CLI 结果与宿主适配

Harness 通过 `shell.env` 提供 CLI 路径和独立调用事件文件，宿主 shell 不覆盖该文件，也不解析创建或构建输出。

所有插件完成 `tool.execute.after` 后，宿主再执行目录同步和统计消费。其他 Hook 保持注册顺序，包括开始计时、配置、权限、事件和销毁。构建和命令统计继续使用 `metadata.devecoCliEvents`，无需重复采集。

Harness 在创建成功且目录校验通过后返回 `metadata.sessionCwd`。宿主将它同步到会话，供后续 `bash` 和原生设计稿工具读取。失败或不存在的目录不更新会话。

`ask` 的文档预览长度由宿主 `src/agent/shell-policy.ts` 设置。Harness 的工具执行前 Hook 设置镜像下载的长任务超时，宿主为禁用 Harness 的调用保留相同的超时回退。

CLI Shim 写入用户缓存下的 `harness/cli/<安装路径哈希>/`，支持只读插件安装目录。Harness 按宿主的状态目录读取保存的 Studio 路径，Skill 安装通过跨进程锁协调首次安装与升级。

## 当前分支兼容

从 `0.2.0-test.11` 起，Harness 随包交付 UI 验证流程和 DFX 技能的 `FILES.md`。DevEco Code 通过通用插件接口和技能清单加载这些资源。
