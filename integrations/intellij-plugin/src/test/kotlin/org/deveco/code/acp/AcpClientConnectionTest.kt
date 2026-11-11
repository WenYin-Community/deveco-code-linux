package org.deveco.code.acp

import com.agentclientprotocol.model.ContentBlock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Unit tests for [AcpClientConnection]'s local session bookkeeping — the
 * behavior that must hold before (or without) a spawned agent process:
 * unknown-session errors are funneled to the prompt callback instead of
 * thrown at callers, cleanup paths tolerate unknown ids, and teardown is
 * idempotent. The stdio/ACP handshake itself needs the bundled CLI
 * subprocess and is covered by integration testing.
 */
class AcpClientConnectionTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun newConnection(): AcpClientConnection = AcpClientConnection(
        tmp.newFolder().absolutePath,
        sessionUpdateConsumer = {},
        permissionHandler = { null },
    )

    @Test
    fun isAliveIsFalseBeforeConnect() {
        assertFalse(newConnection().isAlive())
    }

    @Test
    fun promptOnUnloadedSessionReportsErrorViaCallback() {
        val errors = mutableListOf<Throwable?>()

        newConnection().prompt("sess-1", "hello") { errors.add(it) }

        assertEquals(1, errors.size)
        val error = errors.single()
        assertTrue(error is IllegalStateException)
        assertTrue(error!!.message!!.contains("ACP session is not loaded: sess-1"))
    }

    @Test
    fun promptWithBlocksOnUnloadedSessionReportsErrorViaCallback() {
        val errors = mutableListOf<Throwable?>()

        newConnection().prompt("sess-1", listOf(ContentBlock.Text("hello"))) { errors.add(it) }

        assertEquals(1, errors.size)
        val error = errors.single()
        assertTrue(error is IllegalStateException)
        assertTrue(error!!.message!!.contains("ACP session is not loaded: sess-1"))
    }

    @Test
    fun cancelPromptOnUnknownSessionIsANoop() {
        newConnection().cancelPrompt("unknown-session")
    }

    @Test
    fun closeSessionOnUnknownSessionIsANoop() {
        newConnection().closeSession("unknown-session")
    }

    @Test
    fun invalidateSessionCacheToleratesEmptySessions() {
        newConnection().invalidateSessionCache()
    }

    @Test
    fun setConfigOptionOnMissingSessionThrows() {
        val error = assertThrows(IllegalStateException::class.java) {
            newConnection().setConfigOption("sess-1", "config-id", "value")
        }
        assertTrue(error.message!!.contains("ACP session is not loaded: sess-1"))
    }

    @Test
    fun setModeOnMissingSessionThrows() {
        val error = assertThrows(IllegalStateException::class.java) {
            newConnection().setMode("sess-1", "mode-id")
        }
        assertTrue(error.message!!.contains("ACP session is not loaded: sess-1"))
    }

    @Test
    fun listSessionsWithoutClientThrows() {
        val error = assertThrows(IllegalStateException::class.java) {
            newConnection().listSessions("/work/dir")
        }
        assertTrue(error.message!!.contains("not connected"))
    }

    @Test
    fun getAvailableCommandsForUnknownSessionIsEmpty() {
        assertTrue(newConnection().getAvailableCommands("unknown-session").isEmpty())
    }

    @Test
    fun getCachedUsageForUnknownSessionIsNull() {
        assertEquals(null, newConnection().getCachedUsage("unknown-session"))
    }

    @Test
    fun disposeIsIdempotentAndKeepsConnectionDown() {
        val connection = newConnection()

        connection.dispose()
        connection.dispose()

        assertFalse(connection.isAlive())
    }
}
