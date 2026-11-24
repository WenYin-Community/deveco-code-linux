package org.deveco.code.session

import com.intellij.testFramework.LightPlatformTestCase
import org.deveco.code.util.PluginStateFiles
import java.nio.file.Files

/**
 * Platform-fixture unit tests for [TokenUsageStore]: in-memory usage bookkeeping
 * keyed by session, custom-limit handling, and the missing-entry semantics of
 * getUsage. Disk persistence runs on a coalescing pooled writer and is not
 * asserted here (non-deterministic by design).
 */
class TokenUsageStoreTest : LightPlatformTestCase() {

    private lateinit var store: TokenUsageStore

    override fun setUp() {
        super.setUp()
        Files.deleteIfExists(PluginStateFiles.path(getProject(), "token-usage.json"))
        store = TokenUsageStore(getProject())
    }

    fun testUnknownSessionHasNoUsage() {
        assertNull(store.getUsage("missing"))
    }

    fun testSaveUsageRoundTrip() {
        store.saveUsage("s1", 100L, 200L)

        assertEquals(Triple(100L, 200L, 0L), store.getUsage("s1"))
    }

    fun testSaveUsageOverwritesPreviousEntry() {
        store.saveUsage("s1", 100L, 200L)
        store.saveUsage("s1", 300L, 400L)

        assertEquals(Triple(300L, 400L, 0L), store.getUsage("s1"))
    }

    fun testAllZeroEntryIsTreatedAsMissing() {
        store.saveUsage("s1", 0L, 0L)

        assertNull(store.getUsage("s1"))
    }

    fun testCustomLimitOnlyEntryIsReported() {
        store.saveCustomLimit("s1", 500L)

        assertEquals(Triple(0L, 0L, 500L), store.getUsage("s1"))
    }

    fun testCustomLimitUpdatesExistingUsageEntry() {
        store.saveUsage("s1", 100L, 200L)
        store.saveCustomLimit("s1", 500L)

        assertEquals(Triple(100L, 200L, 500L), store.getUsage("s1"))
    }

    fun testClearUsageRemovesEntry() {
        store.saveUsage("s1", 100L, 200L)
        store.clearUsage("s1")

        assertNull(store.getUsage("s1"))
    }

    fun testSessionsAreIsolated() {
        store.saveUsage("s1", 100L, 200L)
        store.saveUsage("s2", 1L, 2L)

        assertEquals(Triple(100L, 200L, 0L), store.getUsage("s1"))
        assertEquals(Triple(1L, 2L, 0L), store.getUsage("s2"))
    }

    fun testGetInstanceResolvesRegisteredService() {
        (getProject() as com.intellij.serviceContainer.ComponentManagerImpl).replaceServiceInstance(
            TokenUsageStore::class.java,
            store,
            testRootDisposable,
        )

        assertSame(store, TokenUsageStore.getInstance(getProject()))
    }
}
