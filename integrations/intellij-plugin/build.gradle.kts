import org.objectweb.asm.ClassReader
import org.objectweb.asm.ClassWriter
import org.objectweb.asm.ClassVisitor
import org.objectweb.asm.MethodVisitor
import org.objectweb.asm.Opcodes
import java.security.MessageDigest
import java.util.zip.ZipFile
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

import com.diffplug.spotless.extra.wtp.EclipseWtpFormatterStep
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.intellij.platform.gradle.tasks.PatchPluginXmlTask

// ASM is build-only: adapt ACP to the dispatcher ABI bundled with IDE 243.
buildscript {
    repositories {
        maven("https://repo.huaweicloud.com/repository/maven/") { content { includeGroup("org.ow2.asm") } }
        gradlePluginPortal()
        mavenCentral()
    }
    dependencies { classpath("org.ow2.asm:asm:9.7.1") }
}

plugins {
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.changelog")
    id("org.jetbrains.intellij.platform")
    id("com.diffplug.spotless")
}

val platformTarget = providers.gradleProperty("platformTarget").orElse("261").get()
require(platformTarget in setOf("243", "261")) { "platformTarget must be 243 or 261" }
val legacyPlatform = platformTarget == "243"
val hostOs = System.getProperty("os.name").lowercase()
val requestedTaskNames = gradle.startParameter.taskNames.map { it.substringAfterLast(':') }.toSet()
val explicitCliTarget = providers.gradleProperty("cliTarget").orNull
val linuxHost = !hostOs.startsWith("windows") && !hostOs.startsWith("mac")
val compatibilityPackageEntryPoints = setOf("buildPlugin", "buildPlatformPackages", "build", "assemble")
val redirectLinuxPackageBuild =
    linuxHost && explicitCliTarget == null && requestedTaskNames.any { it in compatibilityPackageEntryPoints }
val compatibilityPackageBuild =
    "buildCompatibilityPackages" in requestedTaskNames || redirectLinuxPackageBuild
val defaultCliTarget = when {
    hostOs.startsWith("windows") -> "win32-x64"
    hostOs.startsWith("mac") && System.getProperty("os.arch") in setOf("aarch64", "arm64") -> "darwin-arm64"
    hostOs.startsWith("mac") -> "darwin-x64"
    else -> null
}
val cliTarget = explicitCliTarget ?: defaultCliTarget
    // Linux cannot infer the target resources. A harmless value lets Gradle
    // configure non-package tasks and the outer aggregate build. Packaging
    // entry points without an explicit target are redirected below.
    ?: "darwin-arm64"
require(cliTarget in setOf("darwin-arm64", "darwin-x64", "win32-x64", "win32-x64-baseline")) {
    "Unsupported CLI target: $cliTarget"
}
layout.buildDirectory.set(layout.projectDirectory.dir("build/$platformTarget/$cliTarget"))

kotlin {
    jvmToolchain(21)
    if (legacyPlatform) {
        // Studio 243 supplies Kotlin 2.0.21. Kotlin 2.3's default API target
        // emits DebugMetadata v2, which its coroutine debug probes cannot read.
        compilerOptions.apiVersion.set(org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_0)
        compilerOptions.optIn.add("androidx.compose.foundation.layout.ExperimentalLayoutApi")
        sourceSets.main {
            kotlin.exclude(
                "**/FenceLanguage261.kt",
                "**/IdeMcpSession.kt",
                "**/MarkdownChipRenderer261.kt",
                "**/PlatformComposePanel261.kt",
                "**/PlatformComposeTab261.kt",
                "**/SessionMarkdownTheme261.kt",
                "**/TokenUsageShadow.kt",
            )
            kotlin.srcDir("src/compat243/kotlin")
        }
        // The 243 line renders with Jewel 0.27.0, which lacks the platform
        // RenderOrderedList API and its positive-integer validation entirely.
        sourceSets.test {
            kotlin.exclude(
                "**/MarkdownChipRendererTest.kt",
                "**/SafeOrderedListRendererTest.kt",
            )
        }
    }
}

java {
    toolchain.languageVersion.set(JavaLanguageVersion.of(21))
}

spotless {
    // Keep the formatter separate from non-autocorrectable naming and code-quality policy.
    val nonFormattingRules = listOf(
        "standard:function-naming",
        "standard:kdoc",
        "standard:max-line-length",
        "standard:mixed-condition-operators",
        "standard:no-wildcard-imports",
        "standard:property-naming",
    )

    kotlin {
        target("src/**/*.kt")
        targetExclude("src/main/resources/cli/**")
        ktlint("1.8.0").setEditorConfigPath(rootProject.file(".editorconfig"))
        trimTrailingWhitespace()
        endWithNewline()
        nonFormattingRules.forEach { rule ->
            suppressLintsFor { shortCode = rule }
        }
    }

    kotlinGradle {
        target("*.gradle.kts", "gradle/**/*.gradle.kts")
        ktlint("1.8.0").setEditorConfigPath(rootProject.file(".editorconfig"))
        trimTrailingWhitespace()
        endWithNewline()
        nonFormattingRules.forEach { rule ->
            suppressLintsFor { shortCode = rule }
        }
    }

    java {
        target("src/**/*.java")
        targetExclude("src/main/resources/cli/**")
        googleJavaFormat()
        trimTrailingWhitespace()
        endWithNewline()
    }

    format("xml") {
        target("src/**/*.xml")
        targetExclude("src/main/resources/cli/**")
        eclipseWtp(EclipseWtpFormatterStep.XML).configFile(rootProject.file("config/spotless.xml.prefs"))
        leadingTabsToSpaces(2)
        trimTrailingWhitespace()
        endWithNewline()
    }

    json {
        target("src/**/*.json", "*.json")
        targetExclude("src/main/resources/cli/**")
        simple().indentWithSpaces(2)
        trimTrailingWhitespace()
        endWithNewline()
    }
}

tasks.register("format") {
    group = "formatting"
    description = "Formats source and configuration files"
    dependsOn("spotlessApply")
}

tasks.register("formatCheck") {
    group = "verification"
    description = "Checks source and configuration file formatting"
    dependsOn("spotlessCheck")
}

// Uses -PcliTarget when supplied; otherwise bundles the build host's CLI binary.

abstract class BuildLocalCliTask : DefaultTask() {

    @get:Inject
    abstract val execOperations: ExecOperations

    @get:OutputDirectory
    abstract val cliResourceDir: DirectoryProperty

    @get:Internal
    abstract val repositoryRoot: DirectoryProperty

    @get:Internal
    abstract val pluginDir: DirectoryProperty

    @get:Input
    abstract val targetPlatform: Property<String>

    @get:Input
    abstract val includeNodeRuntime: Property<Boolean>

    @TaskAction
    fun execute() {
        val repo = repositoryRoot.get().asFile
        val opencode = File(repo, "packages/opencode")
        val target = targetPlatform.get()
        val (distributionName, binaryName) = when (target) {
            "darwin-arm64" -> "deveco-darwin-arm64" to "deveco"
            "darwin-x64" -> "deveco-darwin-x64" to "deveco"
            "win32-x64" -> "deveco-windows-x64" to "deveco.exe"
            "win32-x64-baseline" -> "deveco-windows-x64-baseline" to "deveco.exe"
            else -> throw GradleException("Unsupported CLI target: $target")
        }
        if (!File(opencode, "package.json").isFile) {
            throw GradleException("DevEco Code source package not found: ${opencode.absolutePath}")
        }

        logger.lifecycle("Building DevEco Code from current repository source")
        // GUI-launched Gradle daemons may run with a minimal PATH that lacks
        // /usr/local/bin (newer macOS ignores `launchctl config user path` for
        // GUI apps), so resolve bun to an absolute path as a fallback.
        val bunName = if (System.getProperty("os.name").lowercase().startsWith("windows")) "bun.exe" else "bun"
        val bun = ((System.getenv("PATH") ?: "").split(File.pathSeparator))
            .map { File(it, bunName) }
            .firstOrNull { it.isFile }?.absolutePath
            ?: listOf(File("/usr/local/bin/bun"), File(System.getProperty("user.home"), ".bun/bin/$bunName"))
                .firstOrNull { it.isFile }?.absolutePath
            ?: bunName
        execOperations.exec {
            workingDir = repo
            // Plugin packages must contain the repository's model catalog even
            // when the caller's shell disables model fetching for local tests.
            environment("DEVECO_DISABLE_MODELS_FETCH", "false")
            commandLine(
                bun,
                "run",
                "--cwd",
                "packages/opencode",
                "build",
                "--target=$target",
            )
        }

        val source = File(opencode, "dist/$distributionName")
        val binary = File(source, "bin/$binaryName")
        if (!binary.isFile) {
            throw GradleException("Locally built DevEco Code binary not found: ${binary.absolutePath}")
        }

        val dst = cliResourceDir.get().asFile
        val versionFile = File(dst, ".version")
        dst.deleteRecursively()
        source.copyRecursively(dst, overwrite = true)
        File(dst, "bin/$binaryName").setExecutable(true)

        execOperations.exec {
            workingDir = repo
            commandLine(
                bun,
                "run",
                File(pluginDir.get().asFile, "script/bundle-builtin-plugins.ts").absolutePath,
                dst.absolutePath,
                target,
            )
        }

        if (includeNodeRuntime.get()) {
            execOperations.exec {
                workingDir = repo
                commandLine(bun, "run", File(pluginDir.get().asFile, "script/bundle-node.ts").absolutePath, dst.absolutePath, target)
            }
        }

        // Match Gradle's resource FileTree defaults so the extraction manifest
        // does not advertise VCS metadata that processResources will omit.
        val defaultExcludes = org.apache.tools.ant.DirectoryScanner.getDefaultExcludes()
        val manifestLines = dst.walkTopDown()
            .filter { it.isFile && it.name != "manifest.txt" && it.name != ".version" }
            .map { dst.toPath().relativize(it.toPath()).toString().replace('\\', '/') }
            .filter { relative -> defaultExcludes.none { org.apache.tools.ant.types.selectors.SelectorUtils.matchPath(it, relative) } }
            .sorted()
            .toList()
        File(dst, "manifest.txt").writeText(manifestLines.joinToString("\n"))
        versionFile.writeText("local-source")
        logger.lifecycle("Bundled locally built DevEco Code distribution from ${source.absolutePath}")
    }
}

tasks.register<BuildLocalCliTask>("bundleLocalCli") {
    group = "build"
    description = "Build DevEco Code from this repository and bundle it into the plugin"
    repositoryRoot.set(layout.projectDirectory.dir("../.."))
    pluginDir.set(layout.projectDirectory)
    includeNodeRuntime.set(legacyPlatform)
    targetPlatform.set(cliTarget)
    cliResourceDir.set(layout.buildDirectory.dir("generated-resources/cli"))
    outputs.upToDateWhen { false }
}

tasks.matching { it.name in setOf("spotlessKotlin", "spotlessJava", "spotlessXml", "spotlessJson") }.configureEach {
    mustRunAfter("bundleLocalCli")
}

// Never pick up an old source-tree CLI left behind by another target.
sourceSets.main { resources.exclude("cli/**") }
val repositoryLicensePaths = listOf("LICENSE", "LICENSING.md", "NOTICE", "LICENSES/MIT.txt")
val repositoryLicenseFiles = repositoryLicensePaths.map { layout.projectDirectory.file("../../$it").asFile }
tasks.named<ProcessResources>("processResources") {
    // Capture plain files instead of the build script in the configuration-cache action.
    val licensingFiles = repositoryLicenseFiles
    inputs.files(licensingFiles)
    doFirst {
        licensingFiles.forEach { require(it.isFile) { "Required licensing file is missing: $it" } }
    }
    from(tasks.named<BuildLocalCliTask>("bundleLocalCli").flatMap { it.cliResourceDir }) { into("cli") }
    from(rootProject.file("../..")) {
        include(repositoryLicensePaths)
        into("META-INF/deveco")
    }
}

// The CLI test fixture used by CliBinaryExtractorTest contains placeholder files
// whose names/paths are forbidden file types for the repository static gate
// (an ".exe" suffix and a node_modules/ path), so only manifest.txt and
// vendor/info.txt live in src/test/resources; the binary-like entries are
// generated into an extra test resource dir at build time instead. The extra
// dir is "generated-test-resources" (NOT ".../cli") so the fixture keeps its
// "cli/" classpath prefix: a SourceDirectorySet copies a dir's contents to the
// resource root, so srcDir(".../cli") would flatten "cli/" away.
val cliTestFixtureDir = layout.buildDirectory.dir("generated-test-resources")
val generateCliTestFixtures = tasks.register("generateCliTestFixtures") {
    description = "Generates the placeholder CLI entries extracted by CliBinaryExtractorTest"
    val fixtureDir = cliTestFixtureDir
    outputs.dir(fixtureDir)
    doLast {
        val cliDir = fixtureDir.get().asFile.resolve("cli")
        cliDir.resolve("bin/deveco").let { it.parentFile.mkdirs(); it.writeText("fake-unix-binary\n") }
        cliDir.resolve("bin/deveco.exe").let { it.parentFile.mkdirs(); it.writeText("fake-windows-binary\n") }
        cliDir
            .resolve("node_modules/@deveco/deveco-cli/dist/cli.js")
            .let { it.parentFile.mkdirs(); it.writeText("fake-cli-entry\n") }
    }
}
sourceSets.test {
    resources.srcDir(generateCliTestFixtures.map { it.outputs.files })
}

// Read more: https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin.html
// New neutral name, with backward-compatible aliases. A supplied invalid path fails;
// it never silently falls back to a downloaded SDK.
val configuredLocalDevEcoStudio = providers.gradleProperty("ideSdkPath")
    .orElse(providers.gradleProperty("devecoStudioPath"))
    .orElse(providers.environmentVariable("IDE_SDK_PATH"))
    .orElse(providers.environmentVariable("DEVECO_STUDIO_HOME"))
// One generic path cannot serve both IDE lines in the aggregate build. The
// aggregate task has explicit 243/261 properties and forwards them to each
// nested invocation instead.
val localDevEcoStudio = configuredLocalDevEcoStudio.filter { !compatibilityPackageBuild }
val localIdeHome = localDevEcoStudio.map { raw ->
    require(raw.isNotBlank()) { "IDE SDK path must not be empty" }
    val supplied = file(raw)
    val home = if (File(supplied, "Contents/lib").isDirectory) File(supplied, "Contents") else supplied
    require(File(home, "lib").isDirectory) { "IDE SDK must contain lib/: ${supplied.absolutePath}" }
    val buildFile = listOf(File(home, "build.txt"), File(home, "Resources/build.txt")).firstOrNull { it.isFile }
    requireNotNull(buildFile) { "IDE SDK build.txt is missing: ${supplied.absolutePath}" }
    val build = buildFile.readText().trim().substringAfter('-')
    require(build.substringBefore('.') == platformTarget) {
        "IDE SDK build $build does not match -PplatformTarget=$platformTarget"
    }
    home
}

// Runs nested Gradle builds in this same project directory; verified to work in
// Gradle 9 when the nested invocation uses --no-daemon (a shared busy daemon
// would queue the nested build behind this one and deadlock).
abstract class BuildPlatformPackagesTask : DefaultTask() {

    @get:Inject
    abstract val execOperations: ExecOperations

    @get:Internal
    abstract val projectDir: DirectoryProperty

    @get:Input
    abstract val pluginVersion: Property<String>

    @get:Input
    abstract val platformTarget: Property<String>

    @get:Input
    @get:Optional
    abstract val devecoStudioPath: Property<String>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun execute() {
        val targets = listOf(
            "darwin-arm64" to "macos-arm64",
            "darwin-x64" to "macos-x64",
            "win32-x64" to "windows-x64",
            "win32-x64-baseline" to "windows-x64-baseline",
        )
        val directory = projectDir.get().asFile
        val isWindows = System.getProperty("os.name").lowercase().startsWith("windows")
        val gradlew = File(directory, if (isWindows) "gradlew.bat" else "gradlew")
        val version = pluginVersion.get()
        outputDir.get().asFile.mkdirs()
        for ((target, suffix) in targets) {
            logger.lifecycle("Building plugin package for $suffix")
            execOperations.exec {
                workingDir = directory
                commandLine(
                    *(if (isWindows) listOf("cmd.exe", "/d", "/c", gradlew.absolutePath) else listOf(gradlew.absolutePath)).toTypedArray(),
                    "--no-daemon",
                    "buildPlugin",
                    "-PplatformTarget=${platformTarget.get()}",
                    "-Pversion=$version",
                    "-PcliTarget=$target",
                )
                if (devecoStudioPath.isPresent) {
                    args("-PideSdkPath=${devecoStudioPath.get()}")
                }
            }
            val generic = File(directory, "build/${platformTarget.get()}/$target/distributions/deveco-code-jetbrains-plugin-$version.zip")
            if (!generic.isFile) {
                throw GradleException("Plugin package was not generated: ${generic.absolutePath}")
            }
            val destination = File(outputDir.get().asFile, "deveco-code-core-plugin-$version-$suffix.zip")
            generic.copyTo(destination, overwrite = true)
            logger.lifecycle("Created ${destination.absolutePath}")
        }
    }
}

val platformTargetValue = platformTarget
tasks.register<BuildPlatformPackagesTask>("buildPlatformPackages") {
    group = "build"
    description =
        "Builds plugin packages bundling the CLI for every supported platform (macos-arm64, macos-x64, windows-x64, windows-x64-baseline)"
    projectDir.set(layout.projectDirectory)
    pluginVersion.set(providers.gradleProperty("version"))
    platformTarget.set(platformTargetValue)
    devecoStudioPath.set(localDevEcoStudio)
    outputDir.set(layout.projectDirectory.dir("build/$platformTargetValue/packages"))
    // The nested CLI builds read repository sources Gradle does not track as task inputs,
    // so the task must always execute (same reasoning as bundleLocalCli).
    outputs.upToDateWhen { false }
}

// Builds the release matrix required by a headless Linux CI worker. Nested
// invocations are deliberately sequential because packages/opencode/dist is
// shared and each backend build clears it.
abstract class BuildCompatibilityPackagesTask : DefaultTask() {

    @get:Inject
    abstract val execOperations: ExecOperations

    @get:Internal
    abstract val projectDir: DirectoryProperty

    @get:Input
    abstract val pluginVersion: Property<String>

    @get:Input
    abstract val platforms: ListProperty<String>

    @get:Input
    @get:Optional
    abstract val ideSdkPath243: Property<String>

    @get:Input
    @get:Optional
    abstract val ideSdkPath261: Property<String>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun execute() {
        val targets = listOf(
            "darwin-arm64" to "macos-arm64",
            "darwin-x64" to "macos-x64",
            "win32-x64" to "windows-x64",
        )
        val requestedPlatforms = platforms.get()
        require(requestedPlatforms.isNotEmpty() && requestedPlatforms.all { it in setOf("243", "261") }) {
            "platform must be 243 or 261"
        }
        val directory = projectDir.get().asFile
        val isWindows = System.getProperty("os.name").lowercase().startsWith("windows")
        val gradlew = File(directory, if (isWindows) "gradlew.bat" else "gradlew")
        val version = pluginVersion.get()
        // A previous run may have left packages for the other IDE line behind.
        val destinationDir = outputDir.get().asFile.apply {
            deleteRecursively()
            mkdirs()
        }

        for ((target, suffix) in targets) {
            for (platform in requestedPlatforms) {
                logger.lifecycle("Building IDE $platform plugin package for $suffix")
                execOperations.exec {
                    workingDir = directory
                    // A generic SDK variable cannot represent both IDE lines.
                    // Remove it from nested builds and use the version-specific
                    // properties below; otherwise one of the two builds fails
                    // the build-number validation.
                    setEnvironment(
                        environment.filterKeys {
                            it !in setOf("IDE_SDK_PATH", "DEVECO_STUDIO_HOME")
                        },
                    )
                    commandLine(
                        *(if (isWindows) {
                            listOf("cmd.exe", "/d", "/c", gradlew.absolutePath)
                        } else {
                            listOf(gradlew.absolutePath)
                        }).toTypedArray(),
                        "--no-daemon",
                        "buildPlugin",
                        "-PplatformTarget=$platform",
                        "-Pversion=$version",
                        "-PcliTarget=$target",
                    )
                    val sdkPath = when (platform) {
                        "243" -> ideSdkPath243.orNull
                        else -> ideSdkPath261.orNull
                    }
                    if (sdkPath != null) args("-PideSdkPath=$sdkPath")
                }

                val generic = File(
                    directory,
                    "build/$platform/$target/distributions/deveco-code-jetbrains-plugin-$version.zip",
                )
                if (!generic.isFile) {
                    throw GradleException("Plugin package was not generated: ${generic.absolutePath}")
                }
                // One IDE line per release run: the version is already platform-specific,
                // so keep the filename free of 243/261. Multi-platform local builds keep
                // the platform segment to avoid collisions.
                val platformSuffix = if (requestedPlatforms.size > 1) "-$platform" else ""
                val destination = File(
                    destinationDir,
                    "deveco-code-core-plugin-$version$platformSuffix-$suffix.zip",
                )
                generic.copyTo(destination, overwrite = true)
                logger.lifecycle("Created ${destination.absolutePath}")
            }
        }
    }
}

val buildCompatibilityPackages = tasks.register<BuildCompatibilityPackagesTask>("buildCompatibilityPackages") {
    group = "build"
    description =
        "Sequentially builds the requested IDE line (243 or 261) packages for macOS ARM64, macOS x64, and Windows x64; omit -Pplatform to build both"
    projectDir.set(layout.projectDirectory)
    pluginVersion.set(providers.gradleProperty("version"))
    platforms.set(
        providers.gradleProperty("platform")
            .map { listOf(it) }
            .orElse(providers.provider { listOf("243", "261") }),
    )
    ideSdkPath243.set(
        providers.gradleProperty("ideSdkPath243")
            .orElse(providers.environmentVariable("IDE_SDK_PATH_243")),
    )
    ideSdkPath261.set(
        providers.gradleProperty("ideSdkPath261")
            .orElse(providers.environmentVariable("IDE_SDK_PATH_261")),
    )
    outputDir.set(layout.projectDirectory.dir("build/compatibility-packages"))
    outputs.upToDateWhen { false }
}

if (redirectLinuxPackageBuild) {
    logger.lifecycle(
        "Linux build has no cliTarget; redirecting ${requestedTaskNames.intersect(compatibilityPackageEntryPoints)} " +
            "to buildCompatibilityPackages",
    )
    // Preserve existing CI commands. Replace the requested package/lifecycle
    // entry point after every plugin has configured it, so the outer build does
    // not also execute a seventh fallback package after the six nested builds.
    gradle.projectsEvaluated {
        requestedTaskNames.intersect(compatibilityPackageEntryPoints).forEach { taskName ->
            tasks.named(taskName).configure {
                setDependsOn(listOf(buildCompatibilityPackages))
                actions.clear()
            }
        }
    }
}

/** Adapt the pinned SDK without replacing Kotlin/coroutines owned by the IDE. */
abstract class AdaptAcp243Task : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val sourceJar: RegularFileProperty

    @get:OutputFile
    abstract val outputJar: RegularFileProperty

    @TaskAction
    fun adapt() {
        val input = sourceJar.get().asFile
        val sha256 = MessageDigest.getInstance("SHA-256").digest(input.readBytes())
            .joinToString("") { "%02x".format(it) }
        check(sha256 == "d181b9b98df469422242436889ba60a774a7bb426237e5d49fab6545d1198622") { "ACP 0.25.0 changed: review the 243 adapter before building" }
        var dispatcherCalls = 0
        var spillCalls = 0
        var uuidCalls = 0
        val output = outputJar.get().asFile.apply { parentFile.mkdirs() }
        ZipFile(input).use { source ->
            ZipOutputStream(output.outputStream()).use { target ->
                for (entry in source.entries()) {
                    var bytes = source.getInputStream(entry).use { it.readBytes() }
                    if (entry.name.endsWith(".class")) {
                        val reader = ClassReader(bytes)
                        // Do not copy the old constant pool: remove stale references as well.
                        val writer = ClassWriter(0)
                        reader.accept(object : ClassVisitor(Opcodes.ASM9, writer) {
                            override fun visitMethod(access: Int, name: String, descriptor: String, signature: String?, exceptions: Array<out String>?): MethodVisitor {
                                val delegate = super.visitMethod(access, name, descriptor, signature, exceptions)
                                return object : MethodVisitor(Opcodes.ASM9, delegate) {
                                    override fun visitMethodInsn(opcode: Int, owner: String, name: String, descriptor: String, isInterface: Boolean) {
                                        when {
                                            opcode == Opcodes.INVOKESTATIC && owner == "kotlinx/coroutines/CoroutineDispatcher" &&
                                                name == "limitedParallelism\$default" &&
                                                descriptor == "(Lkotlinx/coroutines/CoroutineDispatcher;ILjava/lang/String;ILjava/lang/Object;)Lkotlinx/coroutines/CoroutineDispatcher;" -> {
                                                dispatcherCalls++
                                                super.visitMethodInsn(opcode, "org/deveco/code/acp/LegacyCoroutineBridge", "limitedParallelismDefault", descriptor, false)
                                            }
                                            opcode == Opcodes.INVOKESTATIC && owner == "kotlin/coroutines/jvm/internal/SpillingKt" &&
                                                name == "nullOutSpilledVariable" && descriptor == "(Ljava/lang/Object;)Ljava/lang/Object;" -> {
                                                // Kotlin 2.2's helper always returns null; preserve its exact stack semantics.
                                                spillCalls++
                                                super.visitInsn(Opcodes.POP)
                                                super.visitInsn(Opcodes.ACONST_NULL)
                                            }
                                            opcode == Opcodes.INVOKEVIRTUAL && owner == "kotlin/uuid/Uuid" &&
                                                name == "toHexDashString" && descriptor == "()Ljava/lang/String;" -> {
                                                // Kotlin 2.0 Uuid.toString uses the same canonical dashed representation.
                                                uuidCalls++
                                                super.visitMethodInsn(opcode, owner, "toString", descriptor, false)
                                            }
                                            else -> super.visitMethodInsn(opcode, owner, name, descriptor, isInterface)
                                        }
                                    }
                                }
                            }
                        }, 0)
                        bytes = writer.toByteArray()
                    }
                    target.putNextEntry(ZipEntry(entry.name).apply { time = 0L })
                    target.write(bytes)
                    target.closeEntry()
                }
            }
        }
        check(dispatcherCalls == 1 && uuidCalls == 1 && spillCalls > 0) {
            "Unexpected ACP adaptation counts: dispatcher=$dispatcherCalls, spills=$spillCalls, uuid=$uuidCalls"
        }
        logger.lifecycle("ACP 243 adapted: dispatcher=$dispatcherCalls, spills=$spillCalls, uuid=$uuidCalls")
    }
}

if (legacyPlatform) {
    require(libs.acp.kotlin.get().versionConstraint.requiredVersion == "0.25.0") {
        "Review the ACP 243 adapter before changing the ACP SDK version"
    }
    val acp243Original = configurations.create("acp243Original") { isTransitive = false }
    dependencies.add(acp243Original.name, libs.acp.kotlin)
    val adaptAcp243 = tasks.register<AdaptAcp243Task>("adaptAcp243") {
        sourceJar.set(layout.file(acp243Original.elements.map { it.single().asFile }))
        outputJar.set(layout.buildDirectory.file("compat243/acp-jvm-0.25.0-deveco243.jar"))
    }
    // Wire the actual sandbox/package inputs, not a runtimeClasspath artifact attribute:
    // the IntelliJ plugin's own artifact view otherwise bypasses the adaptation.
    tasks.withType<org.jetbrains.intellij.platform.gradle.tasks.PrepareSandboxTask>().configureEach {
        runtimeClasspath.setFrom(
            configurations.named("runtimeClasspath").map { files -> files.filter { it.name != "acp-jvm-0.25.0.jar" } },
            adaptAcp243.flatMap { it.outputJar },
        )
    }
}

dependencies {
    testImplementation(libs.junit)
    if (legacyPlatform) {
        implementation(libs.jewel.bridge)
        implementation(libs.jewel.markdown.styling)
        implementation(libs.jewel.markdown.alerts)
        implementation(when (cliTarget) {
            "darwin-arm64" -> libs.skiko.macos.arm64
            "darwin-x64" -> libs.skiko.macos.x64
            else -> libs.skiko.windows.x64
        })
    }
    implementation(libs.sqlite.jdbc)
    implementation(libs.acp.kotlin) {
        // IntelliJ already provides these at runtime; bundling another copy can cause
        // class-loader conflicts during plugin reloads.
        exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib")
        exclude(group = "org.jetbrains.kotlinx", module = "kotlinx-coroutines-core-jvm")
    }

    if (localDevEcoStudio.isPresent) {
        compileOnly(fileTree(File(localIdeHome.get(), "lib")) { include("*.jar") })
        if (!legacyPlatform) {
            compileOnly(fileTree(File(localIdeHome.get(), "plugins/mcpserver/lib")) { include("*.jar") })
        }
    }

    // IntelliJ Platform Gradle Plugin Dependencies Extension - read more: https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin-dependencies-extension.html
    intellijPlatform {
        if (localDevEcoStudio.isPresent) {
            local(localIdeHome.get())
        } else if (legacyPlatform) {
            // Exact upstream baseline of Studio 243.24978.46.
            intellijIdeaCommunity("2024.3.3") { useInstaller = false }
        } else {
            intellijIdea("2026.1.1") { useInstaller = false }
            @Suppress("UnstableApiUsage")
            composeUI()
            bundledModule("intellij.platform.jewel.markdown.core")
            bundledModule("intellij.platform.jewel.markdown.extensions.gfmTables")
            bundledModule("intellij.platform.jewel.markdown.ideLafBridgeStyling")
            bundledPlugin("com.intellij.mcpServer")
        }
        testFramework(TestFrameworkType.Platform)

        // Add plugin dependencies for compilation here, for example:
        // bundledPlugin("com.intellij.java")
    }
}

intellijPlatform {
    // DevEco Studio does not ship JetBrains' separate form-instrumentation
    // artifact, and this plugin has no GUI Designer forms.
    instrumentCode = false
    buildSearchableOptions = false

    pluginConfiguration {
        ideaVersion {
            sinceBuild = if (legacyPlatform) "243.24978.46" else "261.23567.138"
            untilBuild = "$platformTarget.*"
        }
    }
}

if (legacyPlatform) {
    configurations.configureEach {
        if (name in setOf("compileClasspath", "runtimeClasspath")) {
            exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib")
            exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib-jdk7")
            exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib-jdk8")
            exclude(group = "org.jetbrains.kotlinx", module = "kotlinx-coroutines-core")
            exclude(group = "org.jetbrains.kotlinx", module = "kotlinx-coroutines-core-jvm")
        }
    }
    tasks.named<PatchPluginXmlTask>("patchPluginXml") {
        inputFile.set(layout.projectDirectory.file("src/compat243/resources/META-INF/plugin.xml"))
    }
}

abstract class Abi243Arguments : CommandLineArgumentProvider {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val sdkHome: DirectoryProperty
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val archive: RegularFileProperty
    @get:OutputFile
    abstract val report: RegularFileProperty
    override fun asArguments(): Iterable<String> = listOf(
        sdkHome.dir("lib").get().asFile.absolutePath,
        archive.get().asFile.absolutePath,
        report.get().asFile.absolutePath,
    )
}
val resolvedSdkDirectory = layout.dir(providers.provider { intellijPlatform.platformPath.toFile() })

abstract class PrepareIdeSdkTask : DefaultTask() {
    @get:Internal
    abstract val sdkDirectory: DirectoryProperty
    @get:Input
    abstract val expectedBranch: Property<String>
    @TaskAction
    fun showSdk() {
        val home = sdkDirectory.get().asFile
        val buildFile = listOf(File(home, "build.txt"), File(home, "Resources/build.txt")).firstOrNull { it.isFile }
        requireNotNull(buildFile) { "Resolved IDE SDK build.txt is missing: $home" }
        val build = buildFile.readText().trim().substringAfter('-')
        require(build.substringBefore('.') == expectedBranch.get()) { "SDK $build does not match ${expectedBranch.get()}" }
        logger.lifecycle("IDE SDK: ${home.absolutePath} (build $build)")
    }
}
val prepareIdeSdk = tasks.register<PrepareIdeSdkTask>("prepareIdeSdk") {
    group = "build setup"
    description = "Resolve/download the target IDE SDK without building the backend or starting an IDE"
    sdkDirectory.set(resolvedSdkDirectory)
    expectedBranch.set(platformTarget)
}
tasks.named("compileKotlin") { dependsOn(prepareIdeSdk) }


// Opt-in static inspection of the final ZIP. This never starts the IDE or backend.
if (legacyPlatform) {
    val auditTools = configurations.create("abi243AuditTools")
    dependencies.add(auditTools.name, "org.ow2.asm:asm:9.7.1")
    val compileAudit = tasks.register<JavaCompile>("compile243AbiAudit") {
        source("script/compat243/AbiAudit.java")
        classpath = auditTools
        destinationDirectory.set(layout.buildDirectory.dir("compat243/audit-classes"))
        options.release.set(21)
        javaCompiler.set(javaToolchains.compilerFor { languageVersion.set(JavaLanguageVersion.of(21)) })
    }
    tasks.register<JavaExec>("audit243Package") {
        group = "verification"
        description = "Statically inspects all final ZIP classes against the local 243 IDE; does not run the plugin"
        dependsOn("buildPlugin", compileAudit)
        classpath(auditTools, compileAudit.flatMap { it.destinationDirectory })
        mainClass.set("AbiAudit")
        javaLauncher.set(javaToolchains.launcherFor { languageVersion.set(JavaLanguageVersion.of(21)) })
        maxHeapSize = "2g"
        argumentProviders.add(objects.newInstance(Abi243Arguments::class.java).apply {
            sdkHome.set(resolvedSdkDirectory)
            archive.set(tasks.named<Zip>("buildPlugin").flatMap { it.archiveFile })
            report.set(layout.buildDirectory.file("compat243/abi-report.txt"))
        })
    }
}
