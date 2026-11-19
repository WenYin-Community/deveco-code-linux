package org.deveco.code.util

import com.intellij.openapi.application.PathManager
import com.intellij.testFramework.LightPlatformTestCase
import com.intellij.util.ui.UIUtil
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Tests for the root-package utilities: storage/config directory layout under
 * the IDE system path, [errorMessage] extraction, and [Project.runInEdt]
 * deferred execution.
 */
class ProjectExtensionsTest : LightPlatformTestCase() {

    private class QuietThrowable : Throwable()

    fun testStorageAndConfigRootsLiveUnderTheIdeSystemDir() {
        val systemDir = Path.of(PathManager.getSystemPath()).toAbsolutePath().normalize()
        assertTrue(devecoStorageRoot.startsWith(systemDir))
        assertEquals(devecoStorageRoot, opencodeConfigDir.parent)
    }

    fun testErrorMessagePrefersTheThrowableMessage() {
        assertEquals("boom", errorMessage(IllegalStateException("boom")))
    }

    fun testErrorMessageFallsBackToTheSimpleClassName() {
        assertEquals("QuietThrowable", errorMessage(QuietThrowable()))
    }

    fun testRunInEdtExecutesTheActionLater() {
        val executed = AtomicBoolean(false)
        project.runInEdt { executed.set(true) }

        UIUtil.dispatchAllInvocationEvents()

        assertTrue(executed.get())
    }
}
