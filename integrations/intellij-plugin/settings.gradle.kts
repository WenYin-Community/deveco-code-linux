import org.jetbrains.intellij.platform.gradle.extensions.intellijPlatform

rootProject.name = "deveco-code-jetbrains-plugin"

pluginManagement {
    plugins {
        id("org.jetbrains.kotlin.jvm") version "2.3.20"
        id("org.jetbrains.kotlin.plugin.compose") version "2.3.20"
        id("org.jetbrains.changelog") version "2.5.0"
        id("com.diffplug.spotless") version "8.10.2"
    }
}

plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
    id("org.jetbrains.intellij.platform.settings") version "2.18.1"
}

dependencyResolutionManagement {
    // Configure all projects' repositories
    repositories {
        exclusiveContent {
            forRepository { maven("https://packages.jetbrains.team/maven/p/kpm/public/") }
            filter { includeGroup("org.jetbrains.jewel") }
        }
        // 华为云 Maven Central 镜像
        maven {
            url = uri("https://repo.huaweicloud.com/repository/maven/")
        }
        // 兜底：保留原始仓库（万一华为云缺包）
        mavenCentral()
        google()

        // IntelliJ Platform 仓库（IntelliJ SDK + JetBrains 插件依赖）
        intellijPlatform {
            // 华为云 IntelliJ 镜像
            maven {
                url = uri("https://repo.huaweicloud.com/repository/maven/")
            }
            // 兜底 JetBrains 官方仓库
            defaultRepositories()
        }
    }
}
