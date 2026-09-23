# DevEco Studio 243 完整适配分析与交付记录

## 结论和范围

本次交付版本：**1.0.0-243.20260917.1**。针对本机 `/Applications/DevEco-Studio 2.app` 的 DevEco Studio 6.1.1.300 / 243.24978.46.36.611300、macOS Apple Silicon。

已经完成插件编译、依赖/代码路径分析和最终安装包的静态 ABI 检查。40 个 JAR、11,044 个 Java 21 有效类，对照 IDE 与 JDK 类进行继承关系及直接方法/字段引用解析，**必需的未解析符号和包结构问题为 0**。不把编译成功或静态分析当作实际功能运行成功；按用户要求，未启动 IDE、运行后端、做模型对话或自动化功能测试。

源码基线是 intellij-plugin 的 54f19e4c0d0c700656d48c691b427b2b2e803430。改动在独立 compat-243 工作区中，未切换用户主工作区的 develop，也未替用户提交或推送。

## 为什么此前连续失败

1. 原版依赖 261 的 IDE、Compose/Jewel 和 Kotlin 运行库；仅降低 plugin.xml 的构建号不能完成兼容。
2. 首个 243 包仍以 Kotlin 2.3 API 目标生成插件协程，IDE Kotlin 2.0.21 无法读取 DebugMetadata v2。
3. 将插件 API 目标降为 2.0 之后，预编译的 ACP 0.25.0 仍包含新版库方法。调整插件编译目标不会重编译第三方 JAR。
4. 第二修复版的 Gradle artifact transform 没有作用于 IntelliJ 打包任务的实际输入，ZIP 中仍为原版 acp-jvm-0.25.0.jar。用户 15:10 的日志显示原来的 limitedParallelism 错误仍在。
5. UI 把错误写到 status 后，空会话界面只渲染“尚无会话”，所以用户看到按钮却看不到失败原因。

## 兼容性清单

| 层次 | 243 约束/发现 | 本次处理与证据 |
| --- | --- | --- |
| 插件描述文件 | 不存在新版 Compose/Jewel/MCP IDE 模块 | 使用独立 243 plugin.xml；最终 ZIP 声明 243.24978.46–243.*，保留 platform 依赖和实际扩展 |
| JVM | Studio2 为 JBR 21 | 编译 JVM 21；扫描最终类文件，无高于 Java 21 的有效字节码 |
| Kotlin | IDE 标准库 2.0.21 | 插件 compiler API 目标 2.0；未打包另一份 Kotlin；最终类无 DebugMetadata v2 |
| 核心协程 | IDE 1.8.0-intellij-11 | 保留 IDE 协程；不更换 IDE 文件，不通过关闭调试规避错误 |
| ACP 调度 | newer limitedParallelism 默认参数签名缺失 | 1 处转到 LegacyCoroutineBridge，再调用旧 limitedParallelism(int)，保留并行度 1 |
| ACP 协程恢复 | SpillingKt.nullOutSpilledVariable 缺失 | 177 处调用替换为 POP + ACONST_NULL；读取原标准库实现确认其语义为丢弃参数并返回 null |
| ACP 分页 | Uuid.toHexDashString 缺失 | 1 处替换为 Kotlin 2.0 的 Uuid.toString；其实现同为 36 字符、带连字符的格式 |
| ACP 打包 | artifact view 绕过旧转换 | 显式 AdaptAcp243Task 接入 PrepareSandboxTask.runtimeClasspath；最终 ZIP 只有适配后的 acp-jvm-0.25.0-deveco243.jar |
| SDK 升级风险 | 二进制适配必须限定版本 | 输入 JAR 的 SHA-256 固定为 d181b9b98df469422242436889ba60a774a7bb426237e5d49fab6545d1198622；版本不为 0.25.0 或调用数量不符则构建失败 |
| Compose / Jewel | Studio2 无内置 UI 库 | 打包 Compose 1.7.1、Jewel 243 0.27.0、Skiko 0.8.18，使用旧版可用 API |
| Markdown | styling JAR 引用了未传递引入的 alerts 类 | 补齐 jewel-markdown-extension-gfm-alerts-243:0.27.0；保持基础 Markdown，未引入新版 GFM 表格渲染 |
| 序列化与 ACP 模型 | 预编译依赖也必须适配 IDE 运行库 | 扫描 acp-model、serialization、immutable、atomicfu、io、logging 等全部最终 JAR；无必需缺失引用 |
| 原生库 | macOS ARM64 架构 | ZIP 内 Node、后端、Skiko ARM64 和 SQLite Mac/aarch64 文件头均为 ARM64 Mach-O；未执行它们 |
| IDE 内置 MCP | 243 没有 261 的服务 API | compat243 实现返回无内置 IDE MCP；后端普通工具及外部 MCP 仍可配置，具体功能需用户验收 |
| 侧栏错误 | 空列表隐藏 status 错误 | 独立 error 状态持续显示错误；失败解除 busy，取消继续传播 |
| 新建会话 | 旧会话复用在界面线程查询后端 | 移至后台线程；列表成功后才复用/清理未发送会话；避免 UI 同步等待连接 |
| 按钮与恢复 | 无 handler 或异常恢复可能留下 busy | 无 handler 不置 busy；同步异常释放 busy；恢复意外创建的会话时释放 busy 并刷新 |
| 失败清理 | candidate 未赋值，失败路径无法关闭连接对象 | 创建后立即记录 candidate，失败执行既有 closeQuietly，释放连接 scope |
| 设置、消息、工具、编辑器 | 依赖 IDE、Compose 与 ACP API | 插件所有编译类及传递依赖统一纳入扫描；包括模型/技能/归档、聊天编辑器、附件、权限、消息恢复等路径 |
| 反射 | 消息恢复动态加载 ToolKind、ToolCallStatus | 两个类均在最终 acp-model JAR；261 MCP 反射代码被 243 源集排除 |
| 后端环境 | GUI PATH 与双 Studio SDK 位置 | 内置 bin/node 优先；DEVECO_HOME 指向当前 IDE；模型凭据/SDK/设备仍由外部提供 |

Jewel alerts 模块坐标来自 [JetBrains 官方 Maven 目录](https://packages.jetbrains.team/maven/p/kpm/public/org/jetbrains/jewel/jewel-markdown-extension-gfm-alerts-243/)。其余结论依据本机 IDE、源码、已发布依赖字节码及最终 ZIP。

## 新建会话到聊天的代码路径检查

- 侧栏/工具栏 → DevEcoSessionActions → SessionOps.createNewSession：busy 管理、后台连接、已有会话复用、错误显示。
- AcpClientService.connect → 后端探测与进程启动 → AcpClientConnection → ACP Protocol / Client.initialize：调度方法、协程恢复、超时、失败释放。
- Client.listSessions / newSession / loadSession → 模型反序列化 → SessionFileEditor / SessionController：同一批 ACP 字节码适配覆盖初始化、新建、恢复、分页及后续请求，不限于堆栈中的一个方法。
- prompt / promptWithBlocks → 流式更新、工具输入、权限请求 → 结束/取消：相关插件类、协议类、模型类与 UI 类已纳入全量引用扫描；真实网络行为未运行。
- 编辑器预览使用 IDE EditorFactory 等 API；不是依靠浏览器或 JCEF 承载聊天。自定义 MCP/后端浏览器工具的依赖另算。
- 模型、技能、归档和历史恢复使用现有 HTTP/本地存储路径；HTTP 调用已有连接/请求超时。会话迁移/存储和真实模型账号保持用户数据，不执行清理或重置。

## 静态报告与例外

`audit243Package` 从最终 ZIP 提取 JAR，分析类定义、直接字节码调用、字段、描述符、继承、动态调用 bootstrap 的显式句柄、DebugMetadata 和 Java 主版本。同时检查适配 ACP 是否真正入包、原版是否仍在、是否重复类、是否捆绑 Kotlin/核心协程。不会加载或执行插件类。

最终统计：11,044 个插件/依赖类；索引 127,228 个 IDE/插件类，JDK 类按需读取；必需问题 0。最终 ZIP 为 40 个 JAR。

保留 6 个可选报告项：SQLite 3.51.1.0 的 org.sqlite.nativeimage.SqliteJdbcFeature 引用 GraalVM hosted API。它们仅用于 native-image 编译阶段，由 META-INF/native-image 元数据描述；本插件在 JBR 上运行，不构建 GraalVM 原生程序。检查器仅对该固定 JAR/该类的引用分类，不全局忽略 GraalVM 缺失，也不要求用户安装 GraalVM。

这是一套直接引用解析工具，不是完整 JVM 链接器或 JetBrains Plugin Verifier。它不证明反射/ServiceLoader 的所有动态路径、IDE 模块类加载可见性、访问标志、原生加载、绘制行为、后端协议时序或模型服务一定正常。已对现有显式反射和打包依赖另行阅读；剩余动态行为由用户整体验收。未运行 IDE、后端或自动化功能测试。

## 外部环境与源码可复现边界

- 运行：Studio2/JBR21、模型服务及凭据、网络、配置/缓存写权限和本机端口。普通聊天无需全局 Node/Bun；包中已有 Node22.22.0。HarmonyOS 构建、设备、浏览器工具和用户自定义 MCP 另需对应 SDK、设备/浏览器/服务。
- 构建：完整基线仓库、JDK21、Bun、Node、目标 Studio2 安装、Gradle/Maven/JetBrains/npm 下载网络和 tar。ASM9.7.1 为新增的构建/分析依赖，不是运行环境依赖。
- 本次后端和 Node 复用前包，未更新 npm 后端依赖；源码全新构建不能跳过 bundleLocalCli。
- 应提交源码、compat243、Gradle 配置、bundle-node.ts、AbiAudit.java 及本文档；不提交 IDE/JDK、Gradle 缓存、node_modules、生成的 CLI 资源或 build 输出。
- 当前仅支持 macOS ARM64 的 243 包，未声明 Windows/Linux/Intel Mac 兼容；不承诺干净网络重建按字节复现相同 ZIP。

## 一次性用户验收

安装本版 ZIP 后完全重启，确认版本 1.0.0-243.20260917.1。依次完成：打开侧栏 → 创建会话/输入中文 → 配置并切换模型 → 发送消息/流式回复 → 引用文件/工具允许与拒绝 → 停止生成 → 打开模型/技能/归档设置 → 重启后恢复会话。

若失败，记录失败步骤、发生时间和侧栏错误；提供对应 idea.log 的异常上下文。无需清空历史/模型设置。此清单是整体验收，不再要求用户逐个暴露基础 ABI 问题后逐点修补。
