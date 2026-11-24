package org.deveco.code.util

import com.intellij.testFramework.LightPlatformTestCase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import java.nio.file.Files
import java.util.Properties
import java.util.UUID

/**
 * Platform tests for [PluginStateFiles]: per-project state files are isolated
 * under a key derived from the project location, global files live under the
 * global root, JSON/properties round-trips work, and missing files read back
 * as null/empty without throwing.
 */
class PluginStateFilesTest : LightPlatformTestCase() {

    private class TestState(var value: String = "", var count: Int = 0)

    private val written = mutableListOf<java.nio.file.Path>()

    @Throws(Exception::class)
    override fun tearDown() {
        written.forEach { Files.deleteIfExists(it) }
        super.tearDown()
    }

    private fun uniqueName(): String = "test-${UUID.randomUUID()}.json"

    private fun track(path: java.nio.file.Path): java.nio.file.Path {
        written.add(path)
        return path
    }

    fun testProjectStateFileLivesUnderTheProjectKeyedRoot() {
        val name = uniqueName()
        val file = track(PluginStateFiles.path(project, name))

        assertEquals(devecoStorageRoot.resolve("state/plugin/projects"), file.parent.parent)
        assertEquals(name, file.fileName.toString())
        assertTrue(file.startsWith(devecoStorageRoot))
    }

    fun testGlobalStateFileLivesUnderTheGlobalRoot() {
        val name = uniqueName()
        val file = track(PluginStateFiles.globalPath(name))

        assertEquals(devecoStorageRoot.resolve("state/plugin/global"), file.parent)
        assertEquals(name, file.fileName.toString())
        assertTrue(file.startsWith(devecoStorageRoot))
    }

    fun testProjectJsonRoundTripAndMissingFile() {
        val name = uniqueName()
        assertNull(PluginStateFiles.readJson(project, name, TestState::class.java))

        PluginStateFiles.writeJson(project, name, TestState(value = "hello", count = 42))
        track(PluginStateFiles.path(project, name))

        val read = PluginStateFiles.readJson(project, name, TestState::class.java)
        assertNotNull(read)
        assertEquals("hello", read!!.value)
        assertEquals(42, read.count)
    }

    fun testGlobalJsonRoundTrip() {
        val name = uniqueName()
        PluginStateFiles.writeJsonGlobal(name, TestState(value = "global", count = 1))
        track(PluginStateFiles.globalPath(name))

        val read = PluginStateFiles.readJsonGlobal(name, TestState::class.java)
        assertNotNull(read)
        assertEquals("global", read!!.value)
        assertEquals(1, read.count)
    }

    fun testRepeatedJsonWritesReplaceThePreviousContent() {
        val name = uniqueName()
        PluginStateFiles.writeJson(project, name, TestState(value = "first"))
        PluginStateFiles.writeJson(project, name, TestState(value = "second"))
        track(PluginStateFiles.path(project, name))

        assertEquals("second", PluginStateFiles.readJson(project, name, TestState::class.java)!!.value)
    }

    fun testPropertiesRoundTripAndMissingFile() {
        val name = "test-${UUID.randomUUID()}.properties"
        assertTrue(PluginStateFiles.readProperties(project, name).isEmpty)

        val properties = Properties()
        properties.setProperty("alpha", "1")
        properties.setProperty("beta", "two words")
        PluginStateFiles.writeProperties(project, name, properties)
        track(PluginStateFiles.path(project, name))

        val read = PluginStateFiles.readProperties(project, name)
        assertEquals("1", read.getProperty("alpha"))
        assertEquals("two words", read.getProperty("beta"))
    }
}
