> 最新 SDK 自动下载、本地路径参数及 Mac/Windows 出包方式见 [BUILD-TARGETS.md](BUILD-TARGETS.md)。下文旧交付记录的目录及平台限制以该文档为准。

# DevEco Studio 243 兼容包

## 交付状态

- 源码基线：intellij-plugin 的 54f19e4c0d0c700656d48c691b427b2b2e803430。
- 安装包：deveco-code-jetbrains-plugin-1.0.0-243.20260917.1.zip。
- 目标：macOS Apple Silicon，DevEco Studio 6.1.1.300，内核 243.24978.46.36.611300。
- 已完成：编译打包；直接针对最终 ZIP 的静态 ABI 分析，40 个 JAR、11,044 个类，必需的未解析符号/包结构问题为 0。
- 单独记录：SQLite 的 6 个 GraalVM native-image 构建期可选符号，不属于 JBR 运行依赖。
- 未执行：启动 IDE、运行插件/后端、真实模型对话、权限交互或自动化功能测试。实际验收由用户进行。
- 完整分析与检查边界见 [COMPATIBILITY-243.md](COMPATIBILITY-243.md)。

## 本次适配

1. 增加 -PplatformTarget=243，构建目录分别为 build/243 与 build/261；默认仍为 261。
2. 243 包使用独立插件描述文件，范围 243.24978.46 至 243.*。这表示声明范围，不代表已覆盖所有 243 定制 IDE。
3. 自带 Jewel 0.27.0 的 243 桥接、Markdown、Compose Desktop 1.7.1、Skiko 0.8.18 的 macOS ARM64 原生库。261 包继续使用目标 IDE 的内置模块。
4. 用旧 Compose 可用的状态 Map 实现权限拒绝集合，适配旧版面板/工具窗口构造方式及实验性布局 API。
5. 243 构建排除新版 IdeMcpSession，以无内置 IDE MCP 的实现替换；后端工具和外部 MCP 配置仍保留，但需实测。
6. Markdown 主题分平台编译。243 使用基础 Markdown 样式；不包含 261 的 GFM 表格扩展，因此表格暂不保证以表格布局显示。
7. 后端运行环境显式传入当前 IDE 的 DEVECO_HOME，避免 Studio2 误用另一套 Studio 的 SDK。
8. 修复 acp --help 将内容写入 stderr 时被错误判定为不支持 ACP 的问题。
9. 243 包额外携带 Node 22.22.0 和许可证。Studio2 内置 Node 18.20.1 无法解析 DevEco CLI 某些依赖使用的 RegExp /v；包内 Node 在 PATH 中优先，不要求用户另外安装全局 Node。

10. ACP 0.25.0 的 243 专用构建任务固定输入 SHA-256，并适配 1 处 dispatcher 调用、177 处协程 spill 调用、1 处 UUID 格式化调用；直接接入最终打包输入，排除原版 ACP JAR。
11. 补齐 Jewel 243 GFM alerts 依赖；修复侧栏隐藏错误、无处理器时按钮卡忙、创建失败后的资源清理，以及在界面线程同步查询旧会话的问题。
12. 增加 audit243Package，针对最终 ZIP 静态分析依赖引用及打包结构，不运行 IDE 或插件。

## 运行时外部依赖

| 依赖 | 是否包含在 ZIP 中 | 说明 |
|---|---|---|
| DevEco Studio / JBR 21 | 否 | 使用目标 IDE 自带运行时；无需为了安装插件另装 JDK |
| macOS ARM64 | 否 | 本次 ZIP 仅适用于 Apple Silicon，不是 Windows/Intel 通用包 |
| Compose / Jewel / Skiko | 是 | 不需要另装 Compose 插件 |
| DevEco Code 后端 | 是 | 从上述源码基线构建；无需全局安装 deveco 或 Bun |
| Node 22.22.0 | 是 | 插件解压后的 bin/node；无需全局安装 Node |
| @deveco/deveco-cli 1.2.2 及其 npm 依赖 | 是 | 外部 npm 发布物，不等同于当前仓库内源码；其供应方和发布仓库仍是构建供应链依赖 |
| ripgrep、ui-verification-mcp | 是 | 由现有后端打包流程携带；相关功能仍可能需要浏览器或设备等外部条件 |
| Kotlin 标准库 / 核心协程 | 否 | 使用 IDE 自带版本，避免打包第二份核心协程；Studio2 为 Kotlin 2.0.21、协程 1.8.0-intellij-11 |
| 模型服务、账号/API Key、网络 | 否 | 真实对话需要用户已有配置和网络；ZIP 不包含私人凭据 |
| HarmonyOS SDK、Hvigor、hdc、设备/模拟器 | 否 | 仅相关构建、调试、设备和 UI 工具需要；聊天本身不要求连接设备 |
| 用户自定义 MCP 的程序/服务/凭据 | 否 | 例如自定义 Node/Python/容器服务，需按各自配置准备 |
| IDE 配置和缓存目录写权限、本机回环端口 | 否 | 后端解压、数据存储和本机服务需要；不应把端口开放到公网 |

插件只运行包内捆绑的 CLI；提取失败时直接报错，不会回退到 PATH 或环境变量指定的外部程序。
Studio2 与另一套 Studio 通常使用不同配置/缓存目录；模型配置或历史会话不会因为安装相同插件就自动共享。

## 从干净源码构建还需要什么

必须保留在代码仓中的部分：

- 插件原有源码、Gradle wrapper、构建脚本与版本目录。
- 本次 src/compat243/、SessionMarkdownTheme261.kt、script/bundle-node.ts，以及其他修改。
- 完整仓库的 packages/opencode、packages/app、其他工作区包、资源、模型目录和 bun.lock；单独复制插件目录不足以构建后端。

需要外部准备或下载的部分：

- 完整 JDK 21（本次构建使用 Android Studio 自带 JBR 21，通过 JAVA_HOME 指定）。Studio2 的运行时不应被默认视为完整编译工具链。
- Bun 1.3.14（仓库 packageManager 声明）；构建 PATH 需能找到 bun。Web UI 构建过程也需要可用 Node，建议 Node 22。
- 目标 Studio2 安装目录，构建通过 -PdevecoStudioPath 显式传入。
- Gradle wrapper 首次下载 Gradle 9.6.1；Kotlin 编译插件为 2.3.20。构建适配和静态分析使用 ASM 9.7.1，仅在构建时下载使用，不进入运行安装包。
- 可访问配置中的 Maven 仓库、Google Maven、JetBrains Jewel 仓库以及 IntelliJ 构建插件仓库。
- 可访问 npm 源与 ripgrep 发布下载地址；现有脚本默认通过 ghproxy.net 下载 ripgrep，具体配置见 packages/opencode/script/postinstall.ts。
- 可访问 https://nodejs.org/dist/v22.22.0/；script/bundle-node.ts 将 ARM64 tar.gz 的 SHA-256 固定为 5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640，并携带 Node LICENSE。
- 系统 tar 工具及足够磁盘空间。

node_modules、.gradle、.intellijPlatform、packages/opencode/.build-cache、src/main/resources/cli 和 build 均是生成目录，不需要提交。首次构建应能重新生成；离线构建必须事先准备这些依赖缓存，只有 Git 源码不能完成完全离线构建。

本机此前下载时遇到过代理访问 JetBrains 下载地址失败，这属于构建网络配置，不是最终用户运行插件必须使用该代理。

注意：现有后端构建脚本会运行 bun install，可能改动 bun.lock；vendor 缓存也会缓存外部 CLI 传递依赖。本次提供固定 ZIP，但目前未承诺清空缓存后能按字节重现相同 ZIP。发布前应审查锁文件变化并保存依赖清单。

## 构建命令

先在仓库根目录执行：

```sh
bun install --frozen-lockfile
bun run --cwd packages/opencode postinstall
```

再在 integrations/deveco-code 目录执行（把两个路径换成实际路径）：

```sh
JAVA_HOME='/path/to/jdk-21/Contents/Home' ./gradlew audit243Package \
  -Pkotlin.compiler.execution.strategy=in-process \
  -Dorg.gradle.jvmargs=-Xmx2048m \
  -PplatformTarget=243 \
  '-PdevecoStudioPath=/Applications/DevEco-Studio 2.app' \
  -PcliTarget=darwin-arm64 \
  -Pversion=1.0.0-243.your-build-id
```

结果位于 build/243/distributions/。每次实际试用建议使用新版本号：插件按版本号判断是否重新解压后端，同版本反复覆盖可能复用旧缓存。

不要从干净目录使用 -x bundleLocalCli，否则会缺少后端和 Node。不要用 buildPlatformPackages 生成 243 多平台包；当前 243 原生库及 Node 打包只实现 darwin-arm64。
修改扩展注册时，必须同步 main 与 compat243 的两份 plugin.xml。

## 用户安装与验收

安装：Studio2 → Settings → Plugins → 齿轮 → Install Plugin from Disk，选择 ZIP（不要解压），按提示重启。

请按顺序反馈：

1. 插件列表显示 DevEco Code 1.0.0-243.20260917.1，无版本/依赖不兼容提示。
2. 打开一个测试项目，左侧 DevEco Code 能显示，聊天页能创建，中文能输入。
3. 如模型未配置，先在 AI Coding 设置中补齐；发送一句简单问题，确认可以流式回复并停止生成。
4. 在测试文件上体验引用文件、跳转、工具允许/拒绝，确认不出现卡死或错误弹窗。
5. 重启后会话可以恢复；有空时再测试多项目和深浅主题。

若失败，提供失败步骤和错误文字；日志从 Help → Show Log in Finder 获取。重点搜索 org.deveco.code、NoSuchMethodError、NoClassDefFoundError、LinkageError、ACP。分享日志前移除 API Key、Authorization、令牌和私人对话内容。

功能差异：此版不提供新版 IDE 内置 MCP Server；基础 Markdown 没有专门的 GFM 表格布局。未验证的功能不能仅因编译成功就视为可用。


## 本次交付与源码重建的区别

本次版本 1.0.0-243.20260917.1 重新编译插件及其 243 适配，复用上次 ZIP 中相同的后端、Node 和其他 CLI 资源。交付构建使用 -x bundleLocalCli，前提是这些资源已经恢复完整。干净源码构建必须使用上面的完整命令，不得跳过 bundleLocalCli。

`audit243Package` 会先生成最终 ZIP，再编译一个仅分析字节码的工具并读取 ZIP 中所有 JAR，不启动 IDE 或后端。报告位于 build/243/compat243/abi-report.txt；必需符号缺失、重复插件类、混入平台运行库、错误 ACP 打包或过高字节码/协程调试元数据会使此任务失败。它不替代运行验收。

前两版的局限：第一修复版只处理插件自身的 Kotlin API 目标；第二修复版的 Gradle artifact transform 未进入最终打包输入，且遗漏 ACP 中其他新版运行库调用。本版修正打包接线，并以最终 ZIP 为静态分析对象。完整证据和剩余边界见 COMPATIBILITY-243.md。
