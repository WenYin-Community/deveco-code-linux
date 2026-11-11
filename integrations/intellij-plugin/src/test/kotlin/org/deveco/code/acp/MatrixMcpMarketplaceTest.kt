package org.deveco.code.acp

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/**
 * Unit tests for [MatrixMcpMarketplace.configuration]: converting raw
 * marketplace `mcpServers` payloads into the installed-MCP config shape
 * (remote vs local normalization, name fallback, disabled/timeout flags).
 *
 * [MatrixMcpMarketplace.list] and [details] hit the live registry endpoint
 * and are left to integration testing.
 */
class MatrixMcpMarketplaceTest {

    @Test
    fun configurationNormalizesRemoteHttpServer() {
        val raw =
            """{"mcpServers":{"foo":{"type":"http","url":"https://example.com/sse",""" +
                """"headers":{"X-Token":"abc"},"oauth":{"enabled":true},"timeout":5000}}}"""

        val installed = MatrixMcpMarketplace.configuration(item(raw))

        assertEquals("foo", installed.name)
        assertEquals("remote", installed.config.str("type"))
        assertEquals("https://example.com/sse", installed.config.str("url"))
        assertEquals("abc", installed.config.obj("headers")?.str("X-Token"))
        assertEquals("true", installed.config.obj("oauth")?.str("enabled"))
        assertEquals(5000, installed.config["timeout"]?.jsonPrimitive?.intOrNull)
        assertEquals("true", installed.config.str("enabled"))
    }

    @Test
    fun configurationTreatsSseTypeAsRemote() {
        val raw = """{"mcpServers":{"sse-server":{"type":"sse","url":"https://example.com/sse"}}}"""

        val installed = MatrixMcpMarketplace.configuration(item(raw))

        assertEquals("remote", installed.config.str("type"))
        assertEquals("https://example.com/sse", installed.config.str("url"))
    }

    @Test
    fun configurationNormalizesLocalCommandServer() {
        val raw =
            """{"mcpServers":{"bar":{"command":"npx","args":["-y","server"],""" +
                """"cwd":"/work","env":{"K":"V"},"timeout":1000}}}"""

        val installed = MatrixMcpMarketplace.configuration(item(raw))

        assertEquals("bar", installed.name)
        assertEquals("local", installed.config.str("type"))
        val command = installed.config["command"]!!.jsonArray
        assertEquals(listOf("npx", "-y", "server"), command.map { it.jsonPrimitive.content })
        assertEquals("/work", installed.config.str("cwd"))
        assertEquals("V", installed.config.obj("environment")?.str("K"))
        assertEquals(1000, installed.config["timeout"]?.jsonPrimitive?.intOrNull)
    }

    @Test
    fun configurationFallsBackToItemNameForBlankServerKey() {
        val raw = """{"mcpServers":{"":{"command":"run"}}}"""

        val installed = MatrixMcpMarketplace.configuration(item(raw))

        assertEquals("Display Name", installed.name)
    }

    @Test
    fun configurationHonorsDisabledFlag() {
        val raw = """{"mcpServers":{"x":{"command":"run","disabled":true}}}"""

        val installed = MatrixMcpMarketplace.configuration(item(raw))

        assertEquals("false", installed.config.str("enabled"))
    }

    @Test
    fun configurationRejectsBlankConfiguration() {
        assertThrows(IllegalArgumentException::class.java) {
            MatrixMcpMarketplace.configuration(item("  "))
        }
    }

    @Test
    fun configurationRejectsInvalidJson() {
        val error = assertThrows(IOException::class.java) {
            MatrixMcpMarketplace.configuration(item("{not json"))
        }
        assertTrue(error.message!!.contains("not valid JSON"))
    }

    @Test
    fun configurationRejectsNonObjectConfiguration() {
        assertThrows(IllegalArgumentException::class.java) {
            MatrixMcpMarketplace.configuration(item("[1,2]"))
        }
    }

    @Test
    fun configurationRejectsMissingMcpServersSection() {
        val error = assertThrows(IOException::class.java) {
            MatrixMcpMarketplace.configuration(item("""{"other":{}}"""))
        }
        assertTrue(error.message!!.contains("mcpServers"))
    }

    @Test
    fun configurationRejectsRemoteWithoutValidUrl() {
        assertThrows(IllegalArgumentException::class.java) {
            MatrixMcpMarketplace.configuration(item("""{"mcpServers":{"r":{"type":"http","url":"ftp://nope"}}}"""))
        }
    }

    @Test
    fun configurationRejectsLocalWithoutCommand() {
        val error = assertThrows(IOException::class.java) {
            MatrixMcpMarketplace.configuration(item("""{"mcpServers":{"l":{"args":["x"]}}}"""))
        }
        assertTrue(error.message!!.contains("no command"))
    }

    @Test
    fun configurationRejectsInvalidServerEntry() {
        assertThrows(IOException::class.java) {
            MatrixMcpMarketplace.configuration(item("""{"mcpServers":{"bad":"just-a-string"}}"""))
        }
    }

    private fun item(configuration: String): MatrixMcpMarketplace.Item = MatrixMcpMarketplace.Item(
        id = "mcp-1",
        name = "Display Name",
        configuredName = "Display Name",
        description = "A marketplace MCP",
        deployType = "remote",
        repository = "https://example.com/repo",
        configuration = configuration,
    )

    private fun JsonObject.str(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull

    private fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
}
