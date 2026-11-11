package org.deveco.code.acp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import java.nio.file.Files

/**
 * Unit tests for [SharedAcpBackend]'s state machine without a usable agent:
 * initial STOPPED state, tolerant teardown calls, the FAILED transition when
 * the bundled CLI cannot be spawned, and idempotent disposal. Attachment
 * routing with live facades needs a platform fixture (later batch).
 */
class SharedAcpBackendTest {

    companion object {

        @BeforeClass
        @JvmStatic
        fun ensurePlatformPaths() {
            // PathManager must resolve the sandbox system/config dirs before
            // the first call caches them. The Gradle test task normally sets
            // these; only fill the gap so a plain JVM run never derives paths
            // inside the IDE installation.
            if (System.getProperty("idea.system.path") == null) {
                System.setProperty("idea.system.path", Files.createTempDirectory("deveco-test-system").toString())
            }
            if (System.getProperty("idea.config.path") == null) {
                System.setProperty("idea.config.path", Files.createTempDirectory("deveco-test-config").toString())
            }
        }
    }

    @Test
    fun initialStateIsStoppedAndDisconnected() {
        val backend = SharedAcpBackend()

        assertEquals(SharedAcpBackend.ConnectionState.STOPPED, backend.connectionState())
        assertFalse(backend.isConnected())
        assertNull(backend.httpApi())
        assertEquals("Not connected", backend.statusText())
    }

    @Test
    fun requireConnectionThrowsWhenDisconnected() {
        val backend = SharedAcpBackend()

        val error = assertThrows(IllegalStateException::class.java) { backend.requireConnection() }

        assertTrue(error.message!!.contains("not connected"))
    }

    @Test
    fun closeSessionThrowsWhenDisconnected() {
        val backend = SharedAcpBackend()

        assertThrows(IllegalStateException::class.java) { backend.closeSession("sess-1") }
    }

    @Test
    fun closeSessionIfLiveAndCancelPromptIfLiveTolerateMissingConnection() {
        val backend = SharedAcpBackend()

        backend.closeSessionIfLive("sess-1")
        backend.cancelPromptIfLive("sess-1")

        assertEquals(SharedAcpBackend.ConnectionState.STOPPED, backend.connectionState())
    }

    @Test
    fun reconnectWithoutAttachmentsReturnsFalseAndStaysStopped() {
        val backend = SharedAcpBackend()

        assertFalse(backend.reconnect())

        assertEquals(SharedAcpBackend.ConnectionState.STOPPED, backend.connectionState())
        assertEquals("Not connected", backend.statusText())
    }

    @Test
    fun ensureConnectionWithoutSpawnableCliFailsAndMarksBackendFailed() {
        val backend = SharedAcpBackend()

        assertFalse(backend.ensureConnection())

        assertEquals(SharedAcpBackend.ConnectionState.FAILED, backend.connectionState())
        assertFalse(backend.isConnected())
        assertNull(backend.httpApi())
        assertTrue(backend.statusText().contains("unavailable"))
    }

    @Test
    fun disposeIsIdempotentAndResetsState() {
        val backend = SharedAcpBackend()

        backend.dispose()
        backend.dispose()

        assertEquals(SharedAcpBackend.ConnectionState.STOPPED, backend.connectionState())
        assertFalse(backend.isConnected())
    }
}
