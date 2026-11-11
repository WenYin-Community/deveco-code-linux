package org.deveco.code.acp

import com.agentclientprotocol.model.McpServer
import kotlinx.coroutines.Job
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for the pure data-mapping surface of the IDE MCP integration:
 * [IdeMcpEndpoint.sseUrl], [IdeMcpHandle.toMcpServer] and [IdeMcpHandle.stop].
 * [IdeMcpSession.acquire] needs the platform McpServerService and is covered
 * by the platform-fixture batch.
 */
class IdeMcpSessionTest {

    @Test
    fun endpointBuildsLoopbackSseUrl() {
        val endpoint = IdeMcpEndpoint(port = 8541, tokenName = "X-Auth", token = "secret")

        assertEquals("http://127.0.0.1:8541/sse", endpoint.sseUrl)
    }

    @Test
    fun handleMapsEndpointToSseMcpServer() {
        val handle = IdeMcpHandle(IdeMcpEndpoint(9000, "X-Auth", "secret"), Job())

        val server = handle.toMcpServer()
        when (server) {
            is McpServer.Sse -> {
                assertEquals("ide", server.name)
                assertEquals("http://127.0.0.1:9000/sse", server.url)
                assertEquals(1, server.headers.size)
                assertEquals("X-Auth", server.headers.single().name)
                assertEquals("secret", server.headers.single().value)
            }

            else -> throw AssertionError("Expected McpServer.Sse but got ${server::class.simpleName}")
        }
    }

    @Test
    fun stopCancelsTheHandleJob() {
        val job = Job()
        val handle = IdeMcpHandle(IdeMcpEndpoint(1, "token-name", "token"), job)

        handle.stop()

        assertTrue(job.isCancelled)
    }
}
