package org.deveco.code.acp

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

internal class AcpToolInputParserTest {

    @Test
    fun `parses a completed task_result wrapper`() {
        val wrapper = AcpToolInputParser.parseTaskWrapper(
            "<task id=\"ses_123\" state=\"completed\"><task_result>all done</task_result></task>",
        )

        assertEquals(TaskWrapper("ses_123", "completed", "all done"), wrapper)
    }

    @Test
    fun `parses a running wrapper with summary`() {
        val wrapper = AcpToolInputParser.parseTaskWrapper(
            "<task id=\"ses_123\" state=\"running\"><summary>started</summary><task_result>partial</task_result></task>",
        )

        assertEquals(TaskWrapper("ses_123", "running", "partial"), wrapper)
    }

    @Test
    fun `parses an error wrapper and tolerates surrounding whitespace`() {
        val wrapper = AcpToolInputParser.parseTaskWrapper(
            "  <task id=\"ses_123\" state=\"failed\"><task_error>boom</task_error></task>\n",
        )

        assertEquals(TaskWrapper("ses_123", "failed", "boom"), wrapper)
    }

    @Test
    fun `rejects mismatched open and close tags`() {
        assertNull(
            AcpToolInputParser.parseTaskWrapper(
                "<task id=\"ses_123\" state=\"completed\"><task_result>all done</task_error></task>",
            ),
        )
    }

    @Test
    fun `rejects prose around the wrapper`() {
        assertNull(
            AcpToolInputParser.parseTaskWrapper(
                "Background task finished:\n<task id=\"ses_123\" state=\"completed\"><task_result>done</task_result></task>",
            ),
        )
    }

    @Test
    fun `backgroundJobId reads jobId from background metadata`() {
        val rawOutput = JsonObject(
            mapOf(
                "metadata" to JsonObject(
                    mapOf(
                        "background" to JsonPrimitive(true),
                        "jobId" to JsonPrimitive("ses_123"),
                    ),
                ),
            ),
        )

        assertEquals("ses_123", AcpToolInputParser.backgroundJobId(rawOutput))
    }

    @Test
    fun `backgroundJobId falls back to sessionId`() {
        val rawOutput = JsonObject(
            mapOf(
                "metadata" to JsonObject(
                    mapOf(
                        "background" to JsonPrimitive(true),
                        "sessionId" to JsonPrimitive("ses_456"),
                    ),
                ),
            ),
        )

        assertEquals("ses_456", AcpToolInputParser.backgroundJobId(rawOutput))
    }

    @Test
    fun `backgroundJobId ignores non-background metadata`() {
        val rawOutput = JsonObject(
            mapOf(
                "metadata" to JsonObject(
                    mapOf(
                        "background" to JsonPrimitive(false),
                        "jobId" to JsonPrimitive("ses_123"),
                    ),
                ),
            ),
        )

        assertNull(AcpToolInputParser.backgroundJobId(rawOutput))
        assertNull(AcpToolInputParser.backgroundJobId(null))
    }
}
