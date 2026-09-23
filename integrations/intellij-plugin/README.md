> 最新 SDK 自动下载、本地路径参数及 Mac/Windows 出包方式见 [BUILD-TARGETS.md](BUILD-TARGETS.md)。下文旧交付记录的目录及平台限制以该文档为准。

# Deveco-code-jetbrains-plugin

[![Twitter Follow](https://img.shields.io/badge/follow-%40JBPlatform-1DA1F2?logo=twitter)](https://twitter.com/JBPlatform)
[![Developers Forum](https://img.shields.io/badge/JetBrains%20Platform-Join-blue)][jb:forum]

## Overview

This repository implements an IntelliJ Platform plugin.

## Data Migration from CodeGenie

If you previously used the CodeGenie plugin, DevEco Code can automatically migrate your SKILL and MCP configurations.

### How it works

When you open the DevEco Code tool window, a migration prompt bar appears between the **Menu** and **Sessions** sections (if CodeGenie data is detected):

```
┌──────────────────────────────────────────────────────┐
│ (i) Import SKILL and MCP configuration from         × │
│     CodeGenie into DevEco Code.                       │
│                                                       │
│ [Start Migration]  Don't remind me                    │
└──────────────────────────────────────────────────────┘
```

- **Start Migration**: Confirms and migrates all detectable data
- **Don't remind me**: Permanently hides the prompt (see below to reset)
- **× (close)**: Hides for the current session only

### What gets migrated

| Data | Source (CodeGenie) | Target (DevEco Code) |
|------|-------------------|---------------------|
| Global skills | `<IDE-config>/Huawei/DevEcoStudio*/codegenie/skills/` | `<storageRoot>/config/skills/` |
| Project skills | `<project>/.codegenie/skills/` | `<storageRoot>/config/projects/<id>/.deveco/skills/` |
| MCP servers | `Model_Management.db` (encrypted) | `<storageRoot>/config/deveco.json(c)` mcp section |

Migration is **idempotent**: re-running it skips already-migrated items. Conflicting entries (same name, different content) are skipped and reported — your existing DevEco Code data is never overwritten.

### Reset migration

If you chose "Don't remind me" or want to re-trigger migration after new CodeGenie data was added:

**macOS**:
```bash
rm ~/Library/Caches/Huawei/DevEcoStudio26.0/deveco-code/v1/config/codegenie-migration.json
```

**Windows**:
```
del %LOCALAPPDATA%\Huawei\DevEcoStudio26.0\deveco-code\v1\config\codegenie-migration.json
```

After deleting this file, restart the IDE and reopen the DevEco Code tool window — the migration prompt will reappear.

### Verify MCP migration

MCP server configurations are stored in:
```bash
# macOS
cat ~/Library/Caches/Huawei/DevEcoStudio26.0/deveco-code/v1/config/deveco.jsonc

# Or list configured MCP servers via the DevEco Code settings
```

## Demo Functionality

The sample plugin adds a `My Tool Window` tool window with a simple functionality of shuffling a random number.

## Plugin structure

A generated project contains the following content structure:

```
.
├── .run/                   Predefined Run/Debug Configurations
├── gradle
│   ├── wrapper/            Gradle Wrapper
│   ├── libs.versions.toml  Version catalog
├── src                     Plugin sources
│   └── main
│       ├── kotlin/         Kotlin production sources
│       └── resources/      Plugin resources
│           ├── META-INF/   Plugin configuration file and logo
│           └── messages/   Message bundles
├── .gitignore              Git ignoring rules
├── build.gradle.kts        Gradle build configuration
├── gradle.properties       Gradle configuration properties
├── gradlew                 *nix Gradle Wrapper script
├── gradlew.bat             Windows Gradle Wrapper script
├── README.md               This file
└── settings.gradle.kts     Gradle project settings
```

In addition to the configuration files, the most crucial part is the `src` directory, which contains our implementation
and the manifest for our plugin – [plugin.xml][file:plugin.xml].

> [!NOTE]
> To use Java in your plugin, create the `/src/main/java` directory.

The plugin logo is placed in `src/main/resources/META-INF/pluginIcon.svg`. See [Plugin Logo][docs:logo] for more
information and logo requirements.

## Build script

The [build.gradle.kts][file:build.gradle.kts] is the core of the project definition. It applies three Gradle plugins:

| Plugin                            | Description                                                                      |
|-----------------------------------|----------------------------------------------------------------------------------|
| `org.jetbrains.kotlin.jvm`        | Adds Kotlin support                                                              |
| `org.jetbrains.changelog`         | Simplifies patching the [CHANGELOG.md][file:CHANGELOG.md] file                   |
| `org.jetbrains.intellij.platform` | The [IntelliJ Platform Gradle Plugin][docs:intellij-platform-gradle-plugin-docs] |

The `intellijPlatform` dependencies block selects the IDE to compile against:

```kotlin
intellijIdea("2025.3.5")
```

See [Target Versions][docs:target-version] for more information.

The `intellijPlatform` dependencies block also contains a dependency on the platform testing framework:

```kotlin
testFramework(TestFrameworkType.Platform)
```

See [Testing][docs:testing] for more information

## Code formatting

Spotless is the single formatting entry point for Kotlin, Gradle Kotlin scripts, Java, XML, and JSON. Kotlin uses
ktlint's IntelliJ IDEA style, Java uses Google Java Format, and XML and JSON use compact two-space indentation:

```bash
./gradlew format
```

To check formatting without changing files, run:

```bash
./gradlew formatCheck
```

The standard `check` task also runs the formatting check.

For identical IDE and command-line output, install the
[Spotless plugin](https://plugins.jetbrains.com/plugin/29287-spotless) in IntelliJ IDEA or DevEco Studio and use its
format action instead of the IDE's built-in formatter. Disable the IDE's built-in reformat-on-save action so the two
formatters do not rewrite the same file in sequence.

## Plugin configuration file

The plugin configuration file is a [plugin.xml][file:plugin.xml] file located in the `src/main/resources/META-INF`
directory. It provides general information about the plugin, its dependencies, extensions, and listeners.

You can read more about this file in the [Plugin Configuration File][docs:plugin.xml] section of our documentation.

### Plugin ID and name

Generated plugin ID and name may require adjustment.

These values are generated based on _Group ID_ and _Artifact ID_ provided in the IDE Plugin wizard. It is recommended to
review `<id>` and `<name>` elements in the plugin.xml file, and adjust them if needed.

Please note that Gradle properties `rootProject.name` and `project.group` don't need to match the `<id>` and `<name>`
elements. There is no IntelliJ Platform-related reason they should as they serve different functions.

## Predefined Run/Debug configurations

Within the default project structure, there is a `.run` directory provided containing predefined *Run/Debug
configurations* that expose corresponding Gradle tasks:

| Configuration name  | Description                                                                                                                                                                           |
|---------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Run IDE with Plugin | Runs [`:runIde`][docs:intellij-platform-gradle-plugin-runIde] IntelliJ Platform Gradle Plugin task. Use the *Debug* icon for plugin debugging.                                        |
| Run Tests           | Runs [`:check`][gradle:lifecycle-tasks] Gradle task.                                                                                                                                  |
| Run Verifications   | Runs [`:verifyPlugin`][docs:intellij-platform-gradle-plugin-verifyPlugin] IntelliJ Platform Gradle Plugin task to check the plugin compatibility against the specified IntelliJ IDEs. |

> [!NOTE]
> You can find the logs from the running task in the `idea.log` tab.

## Publishing the plugin

> [!TIP]
> Make sure to follow all guidelines listed in [Publishing a Plugin][docs:publishing] to follow all recommended and
required steps.

Releasing a plugin to [JetBrains Marketplace](https://plugins.jetbrains.com) is a straightforward operation that uses
the `publishPlugin` Gradle task provided by
the [intellij-platform-gradle-plugin][docs:intellij-platform-gradle-plugin-docs].

You can also upload the plugin to the [JetBrains Plugin Repository](https://plugins.jetbrains.com/plugin/upload)
manually via UI.

## Useful links

- [IntelliJ Platform SDK Plugin SDK][docs]
- [IntelliJ Platform Gradle Plugin Documentation][docs:intellij-platform-gradle-plugin-docs]
- [IntelliJ Platform Explorer][jb:ipe]
- [JetBrains Marketplace Quality Guidelines][jb:quality-guidelines]
- [IntelliJ Platform UI Guidelines][jb:ui-guidelines]
- [JetBrains Marketplace Paid Plugins][jb:paid-plugins]
- [IntelliJ SDK Code Samples][gh:code-samples]

[docs]: https://plugins.jetbrains.com/docs/intellij
[docs:plugin.xml]: https://plugins.jetbrains.com/docs/intellij/plugin-configuration-file.html?from=IJPluginReadmeFile
[docs:publishing]: https://plugins.jetbrains.com/docs/intellij/publishing-plugin.html?from=IJPluginReadmeFile
[docs:intellij-platform-gradle-plugin-docs]: https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin.html?from=IJPluginReadmeFile
[docs:intellij-platform-gradle-plugin-runIde]: https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin-tasks.html?from=IJPluginReadmeFile#runIde
[docs:intellij-platform-gradle-plugin-verifyPlugin]: https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin-tasks.html?from=IJPluginReadmeFile#verifyPlugin
[docs:logo]: https://plugins.jetbrains.com/docs/intellij/plugin-icon-file.html?from=IJPluginReadmeFile
[docs:target-version]: https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin-dependencies-extension.html?from=IJPluginReadmeFile#target-versions
[docs:testing]: https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin-dependencies-extension.html?from=IJPluginReadmeFile#testing

[file:build.gradle.kts]: ./build.gradle.kts
[file:CHANGELOG.md]: ./CHANGELOG.md
[file:gradle.properties]: ./gradle.properties
[file:plugin.xml]: ./src/main/resources/META-INF/plugin.xml

[gh:code-samples]: https://github.com/JetBrains/intellij-sdk-code-samples

[gradle:lifecycle-tasks]: https://docs.gradle.org/current/userguide/java_plugin.html#lifecycle_tasks

[jb:github]: https://github.com/JetBrains/.github/blob/main/profile/README.md
[jb:forum]: https://platform.jetbrains.com/
[jb:quality-guidelines]: https://plugins.jetbrains.com/docs/marketplace/quality-guidelines.html
[jb:paid-plugins]: https://plugins.jetbrains.com/docs/marketplace/paid-plugins-marketplace.html
[jb:ipe]: https://jb.gg/ipe
[jb:ui-guidelines]: https://jetbrains.github.io/ui

## DevEco Studio 243 compatibility build

Use `-PplatformTarget=243 -PdevecoStudioPath=<Studio2.app> -PcliTarget=darwin-arm64`.
The default target remains 261. See [BUILD-243.md](BUILD-243.md) for build prerequisites,
bundled/external dependencies, known feature differences, and manual acceptance steps.

243 的集中适配范围、最终安装包静态分析结果与边界见 [COMPATIBILITY-243.md](COMPATIBILITY-243.md)。
