# DevEco Studio 243 运行适配、依赖与出包关注点

> 适配起始基线：`intellij-plugin` 的 `54f19e4c0d0c700656d48c691b427b2b2e803430`。
> 当前源码已变基到 `origin/intellij-plugin` 的 `e8a599e04`，并同步两目标包的插件扩展与动作注册；兼容性构建结果见 [BUILD-TARGETS.md](BUILD-TARGETS.md)，安装运行仍由用户验收。
> 历史已交付安装包：`1.0.0-243.20260917.1`，仅目标 macOS Apple Silicon / DevEco Studio 6.1.1.300 / 243.24978.46.36.611300；已完成编译及最终包静态分析，运行验收由用户完成。
> 当前源码另已增加 SDK 自动下载、Windows/Intel Mac 资源选择及按目标隔离输出等构建配置。历史 20260917.1 包不覆盖新平台；20260917.2 已使用本地 SDK 构建 243/261 × Mac ARM64/Windows x64 四包。完整远程 SDK 下载、Intel Mac 出包及 Windows 实机运行尚未验收。
> 配套文档：[BUILD-243.md](BUILD-243.md)、[BUILD-TARGETS.md](BUILD-TARGETS.md)、[COMPATIBILITY-243.md](COMPATIBILITY-243.md)。

## 名称约定

本文及相关讨论中的 **DevEco Studio2**，指 **DevEco Studio 6.1.1 Release**。本机安装包的完整版本号为 **6.1.1.300**，IDE 构建号为 **243.24978.46.36.611300**。

“DevEco Studio2”是为了与另一套安装并存而使用的本地应用名称（安装路径为 `/Applications/DevEco-Studio 2.app`），其中的“2”不是产品版本号，也不代表另一种发行版本。下文简称“Studio2”时均指上述 6.1.1 Release 环境。

## 一、243 运行适配

### 编译期

下表中的 IDE 运行库版本与缺失能力指本机目标 DevEco Studio2，不能直接推广到所有基于 243 的 IDE 产品。

| 层次 | 243 约束 | 适配方式 |
| --- | --- | --- |
| JVM | Studio2 自带 JBR 21 | 编译目标 Java 21；扫描最终类无高于 21 的字节码 |
| Kotlin | IDE 自带 2.0.21 | 插件 `apiVersion` 强制 2.0；否则 2.3 的 DebugMetadata v2 旧版协程调试探针读不了 |
| 核心协程 | IDE 自带 1.8.0-intellij-11 | classpath 排除 `kotlin-stdlib`/`kotlinx-coroutines-core`，用 IDE 的，不打包第二份 |
| Compose/Jewel/Skiko | 目标 Studio2 缺少所需内置 UI 模块 | 打包 Compose 1.7.1、Jewel 0.27.0、Skiko 0.8.18（按 cliTarget 选原生库） |
| Markdown | styling JAR 引了未传递引入的 alerts 类 | 补 `jewel-markdown-extension-gfm-alerts-243:0.27.0`；243 用基础 Markdown，**无 GFM 表格布局** |
| IDE 内置 MCP | 目标 Studio2 无新版 IDE 内置 MCP 服务 API | 编译排除 `IdeMcpSession.kt`，用 `LegacyIdeMcp.kt` 中同名的 `IdeMcpSession` 返回无内置 MCP（不禁用外部 MCP/后端工具，实际功能仍需运行验收） |

### 字节码适配（ACP 0.25.0 是预编译的，改编译目标无法重编译第三方 JAR）

| 缺失符号 | 适配 |
| --- | --- |
| `CoroutineDispatcher.limitedParallelism$default`（1 处） | ASM 重写 → `LegacyCoroutineBridge.limitedParallelismDefault` → 调旧版 `limitedParallelism(int)` |
| `SpillingKt.nullOutSpilledVariable`（177 处） | `POP; ACONST_NULL`（语义等价：丢弃参数返回 null） |
| `Uuid.toHexDashString`（1 处） | → `Uuid.toString`（同为 36 字符带连字符） |

- 输入 JAR **SHA-256 固定** `d181b9b98df469422242436889ba60a774a7bb426237e5d49fab6545d1198622`，SDK 版本固定为 0.25.0；版本或文件变化会使构建失败，升级时必须重新评估适配。
- 上表的 1 / 177 / 1 是已交付包构建时的实际处理数量。代码断言为 `dispatcherCalls == 1 && uuidCalls == 1 && spillCalls > 0`，并未单独断言 spill 恰好等于 177；输入文件仍由固定哈希约束。
- 接入 `PrepareSandboxTask.runtimeClasspath`（之前 artifact transform 没作用到实际打包输入，原版 JAR 仍混入 ZIP）。

### 运行时

| 问题 | 修复 |
| --- | --- |
| `acp --help` 写 stderr 被误判不支持 | stdout-or-stderr 读取 |
| 多套 Studio 共存时后端可能选错 IDE/SDK，GUI 的 PATH 也可能不完整 | `DEVECO_HOME` 指向当前 IDE；PATH 先放后端可执行文件所在目录，再放当前 IDE 的 Node 目录（非 Windows 为 `tools/node/bin`，Windows 为 `tools/node`），最后补充其他路径 |
| Studio2 内置 Node 18.20.1 无法解析 RegExp `/v` | 包内 Node 22.22.0 在 PATH 优先 |
| `LinkageError`（运行时不兼容）无清晰报错 | 包装成 `IllegalStateException` 明确提示 |
| 创建连接后 `candidate` 未赋值，失败时连接泄漏 | 创建后立即赋值，失败走 `closeQuietly` |
| 侧栏错误被空列表"尚无会话"挡住 | `SessionsUiState` 加独立 `error` 字段，错误不再被空列表遮挡；下一次加载/创建开始或成功后清除 |
| 新建会话在 EDT 同步查询后端 | `listSessions()` 移到后台线程；仅服务器仍存在才复用 |
| 无 handler 或异常后按钮卡 busy | 无 handler 不置 busy；同步异常释放 busy |

## 二、依赖清单

### 构建工具链（外部准备）

- **JDK 21**（完整编译工具链，不是 Studio2 运行时）——本次用 Android Studio 自带 JBR 21 经 `JAVA_HOME` 指定。
- **Bun 1.4.2**（`packageManager` 声明）；后端/Web UI 构建还需可用 Node，建议 Node 22。构建机的 Node 与插件额外携带的 Node 运行时是两份不同用途的依赖。
- **Gradle 9.6.1**（wrapper 首次下载）。
- **Kotlin 2.3.20** 编译插件。
- **ASM 9.7.1**（仅构建期，不进安装包）。
- **IntelliJ Platform Gradle Plugin 2.18.1**。
- **SDK 来源**：按下节优先级选择本地 SDK，否则自动下载固定版本。
- **系统解压工具**：Mac Node 压缩包需要 `tar`；Windows Node ZIP 在 Windows 上使用 PowerShell `Expand-Archive`，在非 Windows 宿主上使用 `unzip`。

### SDK 选择与边界

优先级：`-PideSdkPath` → `-PdevecoStudioPath` → `IDE_SDK_PATH` → `DEVECO_STUDIO_HOME` → 自动下载。仅省略命令行路径不一定触发下载，还需确认未配置这些环境变量或 Gradle 属性。

- 243 自动下载 **IntelliJ IDEA Community 2024.3.3**（243.24978.46）；261 自动下载 **IntelliJ IDEA 2026.1.1**（261.23567.138）。
- 本地路径支持 macOS `.app` / `Contents` 或 Windows/Linux SDK 解压根目录；路径错误、缺少必要目录或 243/261 分支不匹配时直接报错，不静默改用下载。
- 自动下载使用 JetBrains Gradle 插件的 **multi-OS SDK ZIP**，负责解压及缓存，**不包含 JBR**；构建机仍需完整 JDK 21。如要运行 IDE，需另备该 IDE 所需的运行时。
- 通用 IntelliJ SDK 提供对应平台 API，不等于完整 DevEco 环境，也不包含所有 DevEco 专属扩展；实际 DevEco 兼容性仍需验收。
- `prepareIdeSdk` 可单独准备 SDK，不构建后端或启动 IDE。当前已确认本地 SDK 准备成功、243/261 自动 SDK 配置可解析，未完成完整远程下载验收。

### 打包进 ZIP 的运行时依赖

| 依赖 | 来源 | 说明 |
| --- | --- | --- |
| Compose 1.7.1 / Jewel 0.27.0 / Skiko 0.8.18 | Maven | 目标 Studio2 缺少所需模块，243 包随附；261 构建使用对应 IDE 的内置模块 |
| DevEco Code 后端 | 仓库 `packages/opencode` 源码构建 | `bundleLocalCli` 任务，需先 `bun install` + `postinstall` |
| Node 22.22.0 | nodejs.org，SHA-256 固定 | 当前 243 构建额外携带 Node 22；261 不额外打包，依赖实际运行环境中可找到且版本满足要求的 Node，不能假定所有 261 IDE 都内置 Node |
| @deveco/deveco-cli 1.2.2 + npm 依赖 | npm 发布物 | 外部供应链依赖，不等同仓库内源码 |
| ACP 0.25.0 | Maven → ASM 改写为 `acp-jvm-0.25.0-deveco243.jar` | SHA-256 固定 |
| SQLite JDBC 3.51.1.0 | Maven | 自带多平台原生资源 |
| ripgrep / ui-verification-mcp | 后端打包流程携带 | ripgrep 默认经 ghproxy.net 下载 |

### 不随插件打包的依赖

- **IDE 提供**：Kotlin 标准库 / 核心协程（目标 Studio2 为 2.0.21 / 1.8.0-intellij-11），以及 IDE 自身和随附的 JBR 21 运行时。
- **用户准备**：模型服务、账号/API Key、网络，以及配置/缓存目录写权限和本机回环端口。
- **按功能准备**：HarmonyOS SDK、Hvigor、hdc、设备/模拟器、浏览器，以及自定义 MCP 的程序、服务和凭据；普通聊天不要求全部具备。

插件只运行包内捆绑的 CLI；提取失败时直接报错，不会回退到 PATH 或环境变量指定的外部程序，包内资源即完整保证范围。

### 仓库要求

- Maven：华为云镜像、Maven Central、Google、JetBrains Jewel (KPM)、IntelliJ Platform 仓库。
- npm 源、nodejs.org、ripgrep 下载地址。
- **单独复制插件目录不够**，需完整仓库（`packages/opencode`、`packages/app`、模型目录、`bun.lock`）。

## 三、出包关注点

### 输出隔离

```
build/<243|261>/<cliTarget>/distributions/
build/<243|261>/<cliTarget>/generated-resources/cli/
```

- 不再把 CLI 写回 `src/main/resources/cli`；源树遗留的 `cli/**` 被 `resources.exclude` 排除，不混入新包。
- 干净构建**不能** `-x bundleLocalCli`，否则缺后端和 Node。

### 平台/架构选择

- `cliTarget`：`darwin-arm64`/`darwin-x64`/`win32-x64`/`win32-x64-baseline`，决定 Skiko 原生库、Node 二进制、`deveco`/`deveco.exe`、ripgrep。
- Windows 配置已补齐 `bun.exe` 查找、`node.exe`、Skiko 目标选择及 ZIP 解压：Windows 宿主用 PowerShell `Expand-Archive`，其他宿主用 `unzip`。
- **资源下载/解压支持跨宿主，不等于完整跨平台出包已经可用**；后端构建脚本、原生依赖和系统工具仍可能有宿主限制，完整流程尚待验收，优先采用对应平台构建节点。
- 自动获取的 SDK 是 multi-OS ZIP，而不是宿主专用安装器；这只描述 SDK 获取方式，不代表整个仓库构建与宿主无关。

### 不能并发

- `packages/opencode` 后端构建清理共享 `dist`，**同一 checkout 不能并发多目标**。
- 推荐 CI 矩阵每目标独立 checkout 跑 `buildPlugin`。`buildPlatformPackages` 仍可用于同一工作区顺序构建多个目标，不是并发构建入口。

### 两份 plugin.xml 必须同步

- `src/main/resources/META-INF/plugin.xml`（261：有 compose/mcpServer/jewel-markdown 模块依赖）。
- `src/compat243/resources/META-INF/plugin.xml`（243：保留 platform 依赖，所需 UI 库随包携带，IDE 内置 MCP 禁用）。
- 改扩展注册时**两份都要改**。

### 版本号

- 每次试用建议用新版本号；插件按版本号判断是否重新解压后端，同版本覆盖可能复用旧缓存。
- `idea-version`：243→`243.24978.46–243.*`，261→`261.23567.138–261.*`。

### 静态检查与运行验收

- `audit243Package` 从**本次最终 ZIP** 提取全部 JAR，分析直接类/方法/字段引用、继承、DebugMetadata、Java 版本和打包结构，**不启动 IDE、插件或后端**。扫描数量随包内容变化，不固定为 11,044。
- 检查要求：无必需符号缺失、无重复插件类、无混入 Kotlin/核心协程运行库、ACP 适配 JAR 真正入包且原版已排除、无过高字节码/协程调试元数据。
- **已交付 Mac ARM64 包 `1.0.0-243.20260917.1` 的历史结果**：40 个 JAR、11,044 个类，必需问题为 0。不能把这个结果自动套用到后续代码或 Windows/Intel Mac 包。
- 报告另列 **6 个 SQLite/GraalVM native-image 构建期可选引用**。检查器仅对固定 SQLite JAR 中 `SqliteJdbcFeature` 的这些引用分类；JBR 运行插件不需要安装 GraalVM，并非无条件忽略所有缺失引用。
- 检查器不是完整 JVM 链接器或 JetBrains Plugin Verifier，不覆盖所有反射/ServiceLoader 路径、IDE 模块类加载可见性、成员访问标志、原生加载执行、UI 绘制或后端协议时序。
- **不替代运行验收**——编译成功/静态通过不等于功能可用。真实模型对话、工具授权、停止生成和会话恢复仍由用户整体验收。

### 功能差异（243 已知缺失）

- 无新版 IDE 内置 MCP Server。
- 采用基础 Markdown 实现，无新版 GFM 表格布局；实际渲染效果仍需用户验收。
- 243 已交付的只有 Mac ARM64；Windows/Intel Mac 配置就绪但**未实际产出包**，需 CI 首次验证 SDK 下载、后端打包、最终包内容。
