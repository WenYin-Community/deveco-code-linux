package org.deveco.code.toolwindow

import com.intellij.util.PathUtil
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class ToolWindowPreloaderTest {

    @get:Rule
    val temp = TemporaryFolder()

    @Test
    fun `jar class entries become names and other entries are skipped`() {
        val jar = File(temp.newFolder(), "plugin.jar")
        ZipOutputStream(jar.outputStream()).use { zip ->
            zip.putNextEntry(ZipEntry("org/deveco/code/Sample.class"))
            zip.closeEntry()
            zip.putNextEntry(ZipEntry("module-info.class"))
            zip.closeEntry()
            zip.putNextEntry(ZipEntry("META-INF/MANIFEST.MF"))
            zip.closeEntry()
        }
        assertEquals(listOf("org.deveco.code.Sample"), ToolWindowPreloader.classNames(jar))
    }

    @Test
    fun `directory class files become names with platform separators normalized`() {
        val classes = File(temp.newFolder(), "classes")
        val pkg = File(classes, "org/deveco/code").apply { mkdirs() }
        File(pkg, "Sample.class").writeBytes(ByteArray(0))
        assertEquals(listOf("org.deveco.code.Sample"), ToolWindowPreloader.classNames(classes))
    }

    @Test
    fun `every platform seed names a loadable class whose location enumerates`() {
        // The jewel bridge pair is one jar across platform lines: 243 ships Jewel 0.27,
        // where JewelComposePanel is a class, while 261 ships the renamed
        // JewelComposePanelWrapperKt wrapper and has no such class — exactly one of the
        // pair must resolve on either line, the other is skipped harmlessly at runtime.
        // The strict per-seed contract is a property of 261, where the seeds locate the
        // IDE's platform jars: 243 ships Jewel/Compose/Skiko inside the plugin (already
        // covered by the plugin-jar enumeration) and several seed jars do not exist on
        // that line at all, so a dead name there is by design. A 261 seed that points at
        // a composable function instead of a class (the original dead-seed regression)
        // never loads, and the jar it was meant to enumerate is silently dropped.
        val crossPlatformSeeds = setOf(
            "org.jetbrains.jewel.bridge.JewelComposePanel",
            "org.jetbrains.jewel.bridge.JewelComposePanelWrapperKt",
        )
        // 261-only class per the build's 243 source-set exclusion; probes the platform line.
        val on261 = runCatching {
            Class.forName("org.deveco.code.platform.PlatformComposePanel261Kt", false, javaClass.classLoader)
        }.isSuccess
        var bridgeSeedsResolved = 0
        for (seed in ToolWindowPreloader.platformSeedClasses) {
            val seedClass = runCatching { Class.forName(seed, false, javaClass.classLoader) }.getOrNull()
            if (seed in crossPlatformSeeds) {
                if (seedClass != null) bridgeSeedsResolved++
                continue
            }
            if (!on261) continue
            assertNotNull("platform seed must name a loadable class: $seed", seedClass)
            val location = PathUtil.getJarPathForClass(seedClass!!)
            assertNotNull("platform seed must map to a jar or classes dir: $seed", location)
            assertFalse(
                "platform seed location must enumerate class entries: $seed",
                ToolWindowPreloader.classNames(File(location)).isEmpty(),
            )
        }
        assertEquals("exactly one jewel bridge seed may resolve per platform line", 1, bridgeSeedsResolved)
    }
}
