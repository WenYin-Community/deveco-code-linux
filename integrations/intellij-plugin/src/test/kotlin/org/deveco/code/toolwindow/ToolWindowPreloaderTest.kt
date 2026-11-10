package org.deveco.code.toolwindow

import org.junit.Assert.assertEquals
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
}
