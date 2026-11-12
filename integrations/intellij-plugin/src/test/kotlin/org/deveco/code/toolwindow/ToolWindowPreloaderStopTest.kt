package org.deveco.code.toolwindow

import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Test

class ToolWindowPreloaderStopTest {

    @After
    fun resetStopping() {
        ToolWindowPreloader.resetForTest()
    }

    @Test
    fun `stopping truncates the platform enumeration phase`() {
        ToolWindowPreloader.stop()
        assertTrue(ToolWindowPreloader.platformClassNames(javaClass.classLoader).isEmpty())
    }
}
