package org.deveco.code.toolwindow

import com.intellij.openapi.diagnostic.Logger
import com.intellij.util.PathUtil
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.ZipFile

/**
 * Defines this plugin's classes and the Jewel/Compose/Skiko stack they render through on a
 * background daemon thread at startup.
 *
 * The first tool window tab is created synchronously on the EDT when DevEco Studio's login
 * handler force-shows the window, and its first-use defineClass/verify cascade — thousands
 * of classes across the plugin jars and the platform UI modules — froze the IDE for
 * seconds: the EDT sat in `ClassLoader.defineClass2` while the macOS Appkit thread stalled
 * behind it, which is what the freeze report captured.
 *
 * Only class *definition* moves off the EDT. `Class.forName(..., initialize = false)` never
 * runs a static initializer, and the JVM defines a given class name under a per-class lock
 * exactly once per loader, so the EDT either finds the class already defined or defines it
 * exactly as before. One thread loading through the same parent-first delegation order the
 * EDT itself would use cannot deadlock or double-define anything: the preload changes
 * timing, never behavior. A class that fails to resolve here would fail equally on the
 * EDT and is simply skipped.
 */
object ToolWindowPreloader {
    private val log = Logger.getInstance(ToolWindowPreloader::class.java)
    private val scheduled = AtomicBoolean(false)

    // Resolved by name so an absent entry degrades to "keep loading lazily" instead of a
    // compile-time dependency. On the 261 line these locate the platform module jars that
    // hold Jewel, Compose and Skiko; on 243 those ship inside this plugin and are already
    // covered by the plugin-loader enumeration. One seed per jar the chat editor's first
    // composition loads from. foundation-desktop is reached through CoreTextFieldKt:
    // layout.Box is a composable function, so no class of that name exists to seed with,
    // and its CoreTextField/KeyboardActions defineClass cost is what the freeze reports
    // captured. The chat theme also constructs the markdown processor, the GFM table
    // extension and the markdown styling bridge directly, so those jars need seeds too.
    // The two jewel bridge names seed one jar across platform lines: 243 ships Jewel 0.27,
    // where JewelComposePanel is a class, while 261 renamed the wrapper composable and
    // has no such class — whichever name the running line cannot resolve is skipped.
    internal val platformSeedClasses = listOf(
        "org.jetbrains.jewel.bridge.JewelComposePanel",
        "org.jetbrains.jewel.bridge.JewelComposePanelWrapperKt",
        "androidx.compose.foundation.text.CoreTextFieldKt",
        "androidx.compose.runtime.Composable",
        "androidx.compose.ui.Modifier",
        "org.jetbrains.skiko.SkiaLayer",
        "org.jetbrains.jewel.ui.theme.JewelThemeKt",
        "org.jetbrains.jewel.foundation.theme.JewelThemeKt",
        "org.jetbrains.jewel.intui.markdown.bridge.BridgeProvideMarkdownStylingKt",
        "org.jetbrains.jewel.markdown.MarkdownBlock",
        "org.jetbrains.jewel.markdown.extensions.github.tables.GfmTableColors",
    )

    private val platformUiPackages = listOf(
        "org.jetbrains.jewel.",
        "androidx.compose.",
        "org.jetbrains.skiko.",
    )

    fun schedule() {
        if (!scheduled.compareAndSet(false, true)) return
        Thread(::preload, "DevEco Code class preload").apply {
            isDaemon = true
            start()
        }
    }

    private fun preload() {
        val startedAt = System.currentTimeMillis()
        try {
            val loader = ToolWindowPreloader::class.java.classLoader
            val names = LinkedHashSet(pluginClassNames())
            names.addAll(platformClassNames(loader))
            var defined = 0
            for (name in names) {
                try {
                    Class.forName(name, false, loader)
                    defined++
                } catch (e: Throwable) {
                    // A class that cannot resolve off the EDT could not resolve on the EDT
                    // either; skipping keeps first-use behavior identical.
                }
            }
            log.info(
                "Defined $defined of ${names.size} DevEco Code UI classes off the EDT in ${System.currentTimeMillis() - startedAt} ms",
            )
        } catch (e: Throwable) {
            log.warn(
                "DevEco Code UI class preload failed; the first tool window open pays the load on the EDT as before",
                e,
            )
        }
    }

    private fun pluginClassNames(): List<String> {
        // Locate every jar this plugin ships with through our own class's location: the
        // distributed layout is <plugin>/lib/*.jar and the sandbox layout is <plugin>/lib
        // next to a classes/ directory. This stays independent of the loader's internals.
        val ourLocation =
            PathUtil.getJarPathForClass(ToolWindowPreloader::class.java)?.let(::File) ?: return emptyList()
        val pluginRoot = ourLocation.parentFile ?: return emptyList()
        val jars = pluginRoot.walkTopDown().filter { it.isFile && it.name.endsWith(".jar") }.toList()
        val classes = if (ourLocation.isDirectory) classNames(ourLocation) else emptyList()
        return jars.flatMap(::classNames) + classes
    }

    private fun platformClassNames(loader: ClassLoader): List<String> = platformSeedClasses.flatMap { seed ->
        runCatching { Class.forName(seed, false, loader) }.getOrNull()
            ?.let { PathUtil.getJarPathForClass(it) }
            ?.let { classNames(File(it)) }
            .orEmpty()
            .filter { name -> platformUiPackages.any { name.startsWith(it) } }
    }.distinct()

    internal fun classNames(file: File): List<String> = runCatching {
        when {
            file.isDirectory -> file.walkTopDown()
                .filter { it.isFile && it.name.endsWith(".class") }
                .map { file.toPath().relativize(it.toPath()).toString().replace('\\', '/') }
                .toList()

            file.isFile -> ZipFile(file).use { zip -> zip.entries().toList().map { it.name } }

            else -> emptyList()
        }
    }
        .getOrDefault(emptyList())
        .filter { it.endsWith(".class") && it != "module-info.class" }
        .map { it.removeSuffix(".class").replace('/', '.') }
}
