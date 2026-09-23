# SDK 来源和 Mac / Windows 出包

## SDK 选择

优先级为：`-PideSdkPath` → 旧参数 `-PdevecoStudioPath` → `IDE_SDK_PATH` → `DEVECO_STUDIO_HOME`。
没有提供以上路径时，Gradle 自动下载固定版本的 IntelliJ SDK：

| platformTarget | 自动获取 | 平台构建号 |
| --- | --- | --- |
| 243 | IntelliJ IDEA Community 2024.3.3 | 243.24978.46 |
| 261 | IntelliJ IDEA 2026.1.1 | 261.23567.138 |

使用 JetBrains 官方 IntelliJ Platform Gradle Plugin 的 `intellijIdeaCommunity` / `intellijIdea`，设置 `useInstaller=false`，从已配置的 IntelliJ Maven 仓库获取 multi-OS SDK ZIP，并由插件负责解析、解压和缓存。该 ZIP 不带 JBR，也不需要安装/启动 IDE；编译节点仍须自己准备完整 JDK 21。如果日后要运行 runIde，应另行配置目标 IDE 所需 JBR。

传入的路径支持 macOS `.app`、其 `Contents`，或 Windows/Linux 解压根目录（包含 lib、build.txt）。路径不存在、结构错误或 243/261 分支不匹配会报错，不会悄悄改用远程 SDK。不要传 DMG/EXE 安装器路径；先解压。

SDK 来源由构建宿主和所选平台依赖处理；`cliTarget` 是最终插件后端/原生资源的目标，不是下载 SDK 的操作系统开关。

## 命令

在 integrations/deveco-code 下执行。Windows 用 `gradlew.bat` 替换 `./gradlew`，并按 PowerShell/CMD 的规则换行。

```sh
# 只下载/准备 243 SDK，不构建后端、不启动 IDE
./gradlew prepareIdeSdk -PplatformTarget=243 -PcliTarget=darwin-arm64

# 自动 SDK：243 + Mac ARM64
./gradlew buildPlugin -PplatformTarget=243 -PcliTarget=darwin-arm64 -Pversion=1.0.0-243.build1

# 自动 SDK：243 + Windows x64
./gradlew buildPlugin -PplatformTarget=243 -PcliTarget=win32-x64 -Pversion=1.0.0-243.build1

# 自动 SDK：261 + Windows x64
./gradlew buildPlugin -PplatformTarget=261 -PcliTarget=win32-x64 -Pversion=1.0.0-261.build1

# 本地 SDK 优先
./gradlew buildPlugin -PplatformTarget=243 -PcliTarget=darwin-arm64 '-PideSdkPath=/Applications/DevEco-Studio 2.app' -Pversion=1.0.0-243.build1
```

如需强制自动下载，确保没有通过上述环境变量或 gradle.properties 配置本地路径。首次需要访问 Maven、JetBrains 等仓库；缓存可供后续构建复用。传本地 SDK 仅省去 SDK 下载，其余依赖仍可能需要网络。

### Linux 流水线一次构建六个包

Linux 无法从宿主系统自动推断最终插件资源的操作系统和 CPU。构建单个包时必须传 `-PcliTarget`；需要发布完整兼容矩阵时，使用聚合任务：

```sh
./gradlew --no-daemon buildCompatibilityPackages \
  -Pversion=1.0.0.build1
```

该任务严格按以下顺序执行六次 `buildPlugin`，不会在同一个 checkout 中并发访问共享的 `packages/opencode/dist`：

1. macOS ARM64：243、261
2. macOS x64：243、261
3. Windows x64：243、261

没有提供 SDK 时，六次子构建分别自动下载对应的 243 或 261 IntelliJ SDK。流水线缓存了两套本地 SDK 时，使用不同参数，不能用一个通用路径同时代表两个版本：

```sh
./gradlew --no-daemon buildCompatibilityPackages \
  -Pversion=1.0.0.build1 \
  -PideSdkPath243=/opt/ide-sdk/243 \
  -PideSdkPath261=/opt/ide-sdk/261
```

也可以设置 `IDE_SDK_PATH_243` 和 `IDE_SDK_PATH_261`。聚合任务会清除子构建继承的通用 `IDE_SDK_PATH` 和 `DEVECO_STUDIO_HOME`，避免同一 SDK 被错误用于两个 IDE 版本。

汇总产物位于：

```text
build/compatibility-packages/
  deveco-code-jetbrains-plugin-<version>-243-macos-arm64.zip
  deveco-code-jetbrains-plugin-<version>-261-macos-arm64.zip
  deveco-code-jetbrains-plugin-<version>-243-macos-x64.zip
  deveco-code-jetbrains-plugin-<version>-261-macos-x64.zip
  deveco-code-jetbrains-plugin-<version>-243-windows-x64.zip
  deveco-code-jetbrains-plugin-<version>-261-windows-x64.zip
```

为兼容已有流水线，Linux 上调用 `buildPlugin`、`buildPlatformPackages`、`build` 或 `assemble` 且不传 `cliTarget` 时，会自动转为上述 `buildCompatibilityPackages` 六包构建。传入 `cliTarget` 后仍只构建指定的单包。其他任务（例如 `help`、`tasks`、格式检查）无需 `cliTarget`，也不会触发打包。

## 多平台资源选择

`cliTarget` 支持 darwin-arm64、darwin-x64、win32-x64、win32-x64-baseline。

- 243 按目标选择 Skiko 0.8.18 的 macOS ARM64、macOS x64 或 Windows x64 原生依赖。
- 243 按目标携带官方 Node 22.22.0，Mac 为 bin/node，Windows 为 bin/node.exe；baseline 和普通 Windows 使用相同 Node。三种官方压缩包的 SHA-256 固定在 bundle-node.ts。
- macOS Node 使用 tar 解压；Windows ZIP 在 Windows 上用 PowerShell Expand-Archive，在非 Windows 宿主上用 unzip。
- 原有后端构建流程选择对应 deveco/deveco.exe、vendor CLI 和 ripgrep 资源；SQLite JDBC 使用其自带多平台原生资源。
- Gradle 的 Bun 查找支持 Windows bun.exe，SDK lib/plugins 路径不再固定为 macOS Contents。

输出和生成的 CLI 资源已按两个维度分开：

```text
build/<243或261>/<cliTarget>/distributions/
build/<243或261>/<cliTarget>/generated-resources/cli/
```

不再把新生成的 CLI 写回 src/main/resources/cli，遗留的该目录也不会混入新包。不要在干净构建时加 -x bundleLocalCli。

`buildPlatformPackages` 按顺序构建四个目标，并透传 platformTarget、version、本地 SDK 路径，汇总到 build/<243或261>/packages。流水线更推荐每个矩阵任务单独调用 buildPlugin、使用独立 checkout。

**不要在同一个 checkout 中并发完整后端构建**：仓库的 packages/opencode 构建仍会清理共享 dist，还有其他共享工作区产物。插件输出隔离不等于整个仓库支持同目录并发。Mac/Windows 原生节点优先；跨平台构建能力仍受仓库后端依赖脚本限制。

## 本地四目标构建（20260917.2）

本次使用 Mac ARM64 宿主、Android Studio 自带完整 JDK 21.0.8、Bun 1.4.2，以及本地两个 DevEco SDK。四个目标为 243/261 × Mac ARM64/Windows x64。Windows 包由 Mac 交叉构建，Intel Mac 不在这次四包范围内。

在本目录运行以下命令，按顺序构建：

```sh
export JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home'
./gradlew buildPlugin -PplatformTarget=243 -PcliTarget=darwin-arm64 '-PideSdkPath=/Applications/DevEco-Studio 2.app' -Pversion=1.0.0-243.20260917.2
./gradlew buildPlugin -PplatformTarget=243 -PcliTarget=win32-x64 '-PideSdkPath=/Applications/DevEco-Studio 2.app' -Pversion=1.0.0-243.20260917.2
./gradlew buildPlugin -PplatformTarget=261 -PcliTarget=darwin-arm64 '-PideSdkPath=/Applications/DevEco-Studio.app' -Pversion=1.0.0-261.20260917.2
./gradlew buildPlugin -PplatformTarget=261 -PcliTarget=win32-x64 '-PideSdkPath=/Applications/DevEco-Studio.app' -Pversion=1.0.0-261.20260917.2
```

- 243 SDK：DevEco Studio 6.1.1 Release（243.24978.46.36.611300）。261 SDK：261.23567.138.36.2600621。
- `gradle.properties` 为 Gradle 与 Kotlin 编译进程分别配置最大 2 GiB 堆，避免连续切换 SDK 时默认编译堆不足；流水线还需为 Bun/前端打包进程预留内存。
- 修复 Node 缓存哈希校验的 ArrayBuffer 类型错误；CLI 清单按 Gradle 默认排除规则过滤，避免列入实际未打包的 VCS 元数据。
- 安装包汇总在仓库根目录 `build-artifacts/plugin-matrix-20260917.2/`，含构建日志和 SHA-256；该目录已被 Git 忽略。原始输出仍位于上述按目标隔离的 `distributions/`。
- 本地 SDK 只提供编译平台依赖：仍需要 Bun、仓库 JS 依赖及目标平台后端资源。首次构建可能下载 Maven 依赖、Bun 交叉编译资源、vendor CLI、ripgrep，以及 243 所需 Node 官方归档。261 包不额外携带 Node，运行时需要目标 DevEco 自带或 PATH 中可用的兼容 Node。
- 后端现有构建脚本会调用 `bun install`，可能重写根 `bun.lock`；本次未把这类构建副作用当作源码修复提交。

## 验收边界

本次检查范围为完整编译、后端打包和最终 ZIP 内容，包括 IDE 构建号范围、依赖隔离、CLI/Node/ripgrep 目标架构和文件清单一致性。未执行 IDE 功能测试或 Windows 实机验证；安装、New Session 和发送消息由用户验收。

此次使用本地 DevEco SDK，不代表自动下载 IntelliJ SDK 或 Intel Mac 出包已验收。通用 IntelliJ SDK 不包含 DevEco 专属扩展，实际 DevEco 运行兼容性仍需验收。此前 BUILD-243.md / COMPATIBILITY-243.md 中的编译与 ABI 扫描数据属于历史 20260917.1 包，不能直接当作本次包的扫描结论。

官方资料：
- https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin-dependencies-extension.html
- https://youtrack.jetbrains.com/articles/IDEA-A-2100662361/IntelliJ-IDEA-2024.3.3-243.24978.46-build-Release-Notes
