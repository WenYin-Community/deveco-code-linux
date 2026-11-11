package org.deveco.code.acp

import com.agentclientprotocol.model.ContentBlock
import com.agentclientprotocol.model.MessageId
import com.agentclientprotocol.model.PermissionOption
import com.agentclientprotocol.model.PermissionOptionId
import com.agentclientprotocol.model.PermissionOptionKind
import com.agentclientprotocol.model.RequestPermissionOutcome
import com.agentclientprotocol.model.RequestPermissionRequest
import com.agentclientprotocol.model.RequestPermissionResponse
import com.agentclientprotocol.model.SessionId
import com.agentclientprotocol.model.SessionUpdate
import com.agentclientprotocol.model.ToolCallId
import com.agentclientprotocol.model.ToolCallStatus
import com.agentclientprotocol.model.ToolKind
import com.intellij.openapi.application.ApplicationManager
import com.intellij.serviceContainer.ComponentManagerImpl
import com.intellij.testFramework.LightPlatformTestCase
import kotlinx.coroutines.runBlocking
import org.deveco.code.session.SessionStorage
import java.io.File

/**
 * Platform-fixture unit tests for [AcpClientService]: the per-project facade
 * over [SharedAcpBackend]. Covers the disconnected (no spawnable CLI)
 * behavior — query defaults, prompt error tracking with abnormal-session
 * marking, listener fan-out, permission handler chain, and graceful
 * connect/disconnect. Session routing with a live agent subprocess is
 * covered by integration testing.
 */
class AcpClientServiceTest : LightPlatformTestCase() {

    private lateinit var serviceInstance: AcpClientService

    override fun setUp() {
        super.setUp()
        // plugin.xml-declared services (post-0.3.1, AcpClientService and
        // SharedAcpBackend are no longer light services) are not resolvable in
        // the bare test platform: register the app backend, then wire the
        // project facade through the project container so getService lookups
        // behave like production.
        (ApplicationManager.getApplication() as ComponentManagerImpl).replaceServiceInstance(
            SharedAcpBackend::class.java,
            SharedAcpBackend(),
            testRootDisposable,
        )
        serviceInstance = AcpClientService(getProject())
        (getProject() as ComponentManagerImpl).replaceServiceInstance(
            AcpClientService::class.java,
            serviceInstance,
            testRootDisposable,
        )
    }

    private fun service(): AcpClientService = getProject().getService(AcpClientService::class.java)

    private fun sampleUpdate(): AcpSessionUpdate =
        AcpSessionUpdate(SessionId("sess-1"), SessionUpdate.UserMessageChunk(ContentBlock.Text("hi"), MessageId("m-1")))

    private fun permissionRequest(): RequestPermissionRequest = RequestPermissionRequest(
        SessionId("sess-1"),
        SessionUpdate.ToolCallUpdate(ToolCallId("tc-1"), "Read file", ToolKind.READ, ToolCallStatus.PENDING),
        listOf(PermissionOption(PermissionOptionId("opt-1"), "Allow once", PermissionOptionKind.ALLOW_ONCE)),
    )

    fun testProjectServiceLookupReturnsSameInstance() {
        assertSame(service(), service())
    }

    fun testDisconnectedQueryDefaults() {
        val service = service()

        assertFalse(service.isConnected())
        assertEquals(SharedAcpBackend.ConnectionState.STOPPED, service.connectionState())
        assertEquals("Not connected", service.statusText())
        assertNull(service.activeSessionIds())
        assertTrue(service.modelCatalog().isEmpty())
        assertTrue(service.availableProviders().isEmpty())
        assertTrue(service.mcpServerStatuses().isEmpty())
        assertTrue(service.skillEntries().isEmpty())
        assertTrue(service.sessionDiff("sess-1").isEmpty())
    }

    fun testPromptOnDisconnectedBackendReportsErrorAndMarksSessionAbnormal() {
        val service = service()
        val abnormal = mutableListOf<String>()
        service.addOnAbnormalChanged { abnormal.add(it) }
        val errors = mutableListOf<Throwable?>()

        service.prompt("sess-x", "hello") { errors.add(it) }

        assertEquals(1, errors.size)
        assertTrue(errors.single() is IllegalStateException)
        assertFalse(service.isSessionRunning("sess-x"))
        assertTrue(SessionStorage.abnormalIds(getProject()).contains("sess-x"))
        assertEquals(listOf("sess-x"), abnormal)
        assertTrue(service.lastDurationSnapshot().containsKey("sess-x"))
    }

    fun testCancelSessionWithoutConnectionIsANoop() {
        service().cancelSession("sess-x")
    }

    fun testSessionUpdateListenersReceivePublishedUpdates() {
        val service = service()
        val received = mutableListOf<AcpSessionUpdate>()
        service.addSessionListener { received.add(it) }

        val update = sampleUpdate()
        service.publishSessionUpdate(update)

        assertEquals(listOf(update), received)
    }

    fun testRemovedSessionListenerStopsReceivingUpdates() {
        val service = service()
        val received = mutableListOf<AcpSessionUpdate>()
        val listener: (AcpSessionUpdate) -> Unit = { received.add(it) }
        service.addSessionListener(listener)
        service.publishSessionUpdate(sampleUpdate())
        service.removeSessionListener(listener)
        service.publishSessionUpdate(sampleUpdate())

        assertEquals(1, received.size)
    }

    fun testFailingListenerDoesNotPreventDeliveryToOthers() {
        val service = service()
        val received = mutableListOf<AcpSessionUpdate>()
        service.addSessionListener { throw RuntimeException("listener boom") }
        service.addSessionListener { received.add(it) }

        service.publishSessionUpdate(sampleUpdate())

        assertEquals(1, received.size)
    }

    fun testPermissionRequestDefaultsToCancelledWithoutHandlers() {
        val response = runBlocking { service().requestPermission(permissionRequest()) }

        assertSame(RequestPermissionOutcome.Cancelled, response.outcome)
    }

    fun testFirstRespondingPermissionHandlerWins() {
        val service = service()
        val cancelled = RequestPermissionResponse(RequestPermissionOutcome.Cancelled)
        val seen = mutableListOf<RequestPermissionRequest>()
        service.addPermissionHandler { request ->
            seen.add(request)
            null
        }
        service.addPermissionHandler { _ -> cancelled }

        val response = runBlocking { service.requestPermission(permissionRequest()) }

        assertSame(cancelled, response)
        assertEquals(1, seen.size)
    }

    fun testConnectWithoutSpawnableCliFailsGracefully() {
        val service = service()
        // Make the extracted dummy binary unspawnable on every platform so
        // the failure is fast and deterministic.
        File(CliBinaryExtractor.extract()).setExecutable(false)
        try {
            assertFalse(service.connect())

            assertEquals(SharedAcpBackend.ConnectionState.FAILED, service.connectionState())
            assertTrue(service.statusText().contains("unavailable"))
            assertFalse(service.isConnected())
        } finally {
            service.disconnect()
        }
    }

    fun testDisconnectWithoutConnectionIsIdempotent() {
        val service = service()

        service.disconnect()
        service.disconnect()

        assertFalse(service.isConnected())
    }
}
