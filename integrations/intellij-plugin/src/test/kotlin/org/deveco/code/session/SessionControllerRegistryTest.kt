package org.deveco.code.session

import com.intellij.openapi.application.ApplicationManager
import com.intellij.serviceContainer.ComponentManagerImpl
import com.intellij.testFramework.LightPlatformTestCase
import com.intellij.util.ui.UIUtil
import org.deveco.code.acp.AcpClientService
import org.deveco.code.acp.SharedAcpBackend
import org.deveco.code.util.PluginStateFiles
import java.nio.file.Files

/**
 * Platform-fixture unit tests for [SessionControllerRegistry] with real
 * [SessionController]s against a disconnected [AcpClientService]: acquire-once
 * reuse, user-close disposal, switch-close caching (only for loaded
 * controllers), split-editor attach counting, eviction, and teardown.
 */
class SessionControllerRegistryTest : LightPlatformTestCase() {

    private lateinit var service: AcpClientService
    private lateinit var modelStore: SessionModelStore
    private lateinit var tokenUsageStore: TokenUsageStore
    private lateinit var registry: SessionControllerRegistry
    private var factoryCalls = 0

    override fun setUp() {
        super.setUp()
        Files.deleteIfExists(PluginStateFiles.path(getProject(), "sessions.properties"))
        Files.deleteIfExists(PluginStateFiles.globalPath("models.json"))
        (ApplicationManager.getApplication() as ComponentManagerImpl).replaceServiceInstance(
            SharedAcpBackend::class.java,
            SharedAcpBackend(),
            testRootDisposable,
        )
        service = AcpClientService(getProject())
        (getProject() as ComponentManagerImpl).replaceServiceInstance(
            AcpClientService::class.java,
            service,
            testRootDisposable,
        )
        (getProject() as ComponentManagerImpl).replaceServiceInstance(
            SessionViewStateStore::class.java,
            SessionViewStateStore(),
            testRootDisposable,
        )
        modelStore = SessionModelStore(getProject())
        tokenUsageStore = TokenUsageStore(getProject())
        registry = SessionControllerRegistry(getProject())
        factoryCalls = 0
    }

    override fun tearDown() {
        registry.dispose()
        super.tearDown()
    }

    private fun factoryFor(sessionId: String): () -> SessionController = {
        factoryCalls++
        SessionController(sessionId, service, modelStore, tokenUsageStore, null, getProject(), null)
    }

    /** The registry only caches controllers whose backend load succeeded. */
    private fun markLoaded(controller: SessionController) {
        val field = SessionController::class.java.getDeclaredField("loadSucceeded")
        field.isAccessible = true
        field.set(controller, true)
    }

    fun testAcquireCreatesControllerOnceAndReusesIt() {
        val first = registry.acquire("s1", factoryFor("s1"))
        val second = registry.acquire("s1", factoryFor("s1"))

        assertSame(first, second)
        assertEquals(1, factoryCalls)
    }

    fun testUserCloseDisposesController() {
        val first = registry.acquire("s1", factoryFor("s1"))

        registry.release(first)
        UIUtil.dispatchAllInvocationEvents()

        val reopened = registry.acquire("s1", factoryFor("s1"))
        assertNotSame(first, reopened)
        assertEquals(2, factoryCalls)
    }

    fun testReleaseOfUnknownControllerIsNoop() {
        val stranger = SessionController("sx", service, modelStore, tokenUsageStore, null, getProject(), null)

        registry.release(stranger)
        UIUtil.dispatchAllInvocationEvents()

        assertEquals(0, factoryCalls)
    }

    fun testSwitchCloseRetainsLoadedControllerForReuse() {
        val first = registry.acquire("s1", factoryFor("s1"))
        markLoaded(first)

        registry.markSwitchCloses(listOf("s1"))
        registry.release(first)
        assertTrue(first.detached)
        UIUtil.dispatchAllInvocationEvents()

        val reopened = registry.acquire("s1", factoryFor("s1"))
        assertSame(first, reopened)
        assertEquals(1, factoryCalls)
        assertFalse(reopened.detached)
    }

    fun testSwitchCloseDisposesNeverLoadedController() {
        // A controller whose backend load never completed must not be cached:
        // reopening has to rebuild and retry the load.
        val first = registry.acquire("s1", factoryFor("s1"))

        registry.markSwitchCloses(listOf("s1"))
        registry.release(first)
        UIUtil.dispatchAllInvocationEvents()

        val reopened = registry.acquire("s1", factoryFor("s1"))
        assertNotSame(first, reopened)
        assertEquals(2, factoryCalls)
    }

    fun testSplitEditorsKeepControllerAttachedAfterOneRelease() {
        val controller = registry.acquire("s1", factoryFor("s1"))
        registry.acquire("s1", factoryFor("s1")) // second editor, same controller

        registry.release(controller) // one editor closes, one stays open
        UIUtil.dispatchAllInvocationEvents()

        assertSame(controller, registry.acquire("s1", factoryFor("s1")))
        assertEquals(1, factoryCalls)
    }

    fun testEvictDisposesControllerUnconditionally() {
        val first = registry.acquire("s1", factoryFor("s1"))
        markLoaded(first)

        registry.evict("s1")

        assertNotSame(first, registry.acquire("s1", factoryFor("s1")))
        assertEquals(2, factoryCalls)
    }

    fun testCacheCapEvictsOldestIdleEntry() {
        val first = registry.acquire("s0", factoryFor("s0"))
        markLoaded(first)
        registry.markSwitchCloses(listOf("s0"))
        registry.release(first)
        UIUtil.dispatchAllInvocationEvents()

        // Fill the cache past its cap (10) with switch-closed, loaded sessions.
        for (i in 1..10) {
            val id = "s$i"
            val controller = registry.acquire(id, factoryFor(id))
            markLoaded(controller)
            registry.markSwitchCloses(listOf(id))
            registry.release(controller)
            UIUtil.dispatchAllInvocationEvents()
        }

        // s0 aged out as the oldest idle entry: reopening rebuilds it.
        assertNotSame(first, registry.acquire("s0", factoryFor("s0")))
        assertEquals(12, factoryCalls)
    }

    fun testRegistryDisposeDisposesAllControllers() {
        val first = registry.acquire("s1", factoryFor("s1"))
        registry.acquire("s2", factoryFor("s2"))

        registry.dispose()

        assertNotSame(first, registry.acquire("s1", factoryFor("s1")))
        assertEquals(3, factoryCalls)
    }
}
