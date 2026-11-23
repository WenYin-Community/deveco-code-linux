package org.deveco.code.session.replay

import org.deveco.code.acp.DevEcoHttpApi
import org.deveco.code.session.model.conversation.ActivityError
import org.deveco.code.session.model.conversation.ActivityResult
import org.deveco.code.session.model.conversation.IncompleteReason
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class SessionMessageOutcomeTest {
    @Test
    fun `content filter persists refusal over acp completion`() {
        val message = assistant(
            id = "agent",
            finish = "content-filter",
            errorName = "ContentFilterError",
        )

        assertEquals(
            ActivityResult.Incomplete(IncompleteReason.REFUSED),
            canonicalActivityResult(message, acpFallback = ActivityResult.Completed),
        )
    }

    @Test
    fun `output length maps to incomplete output length`() {
        assertEquals(
            ActivityResult.Incomplete(IncompleteReason.OUTPUT_LENGTH),
            canonicalActivityResult(assistant(id = "length", finish = "length")),
        )
        assertEquals(
            ActivityResult.Incomplete(IncompleteReason.OUTPUT_LENGTH),
            canonicalActivityResult(assistant(id = "error", errorName = "MessageOutputLengthError")),
        )
    }

    @Test
    fun `aborted message maps to cancelled`() {
        assertEquals(
            ActivityResult.Cancelled(),
            canonicalActivityResult(assistant(id = "agent", errorName = "MessageAbortedError")),
        )
    }

    @Test
    fun `other errors map to failed message`() {
        assertEquals(
            ActivityResult.Failed(ActivityError(name = "APIError", message = "rate limited")),
            canonicalActivityResult(
                assistant(id = "agent", errorName = "APIError", errorMessage = "rate limited"),
            ),
        )
    }

    @Test
    fun `stop with completed time maps to completed`() {
        assertEquals(
            ActivityResult.Completed,
            canonicalActivityResult(assistant(id = "agent", finish = "stop")),
        )
    }

    @Test
    fun `acp refusal is used only when persistent outcome is unavailable`() {
        assertEquals(
            ActivityResult.Incomplete(IncompleteReason.REFUSED),
            canonicalActivityResult(
                message = null,
                acpFallback = ActivityResult.Incomplete(IncompleteReason.REFUSED),
                legacyFallback = ActivityResult.Completed,
            ),
        )
    }

    @Test
    fun `tool calls are not terminal and do not hide a later assistant message`() {
        val messages = listOf(
            assistant(id = "tool-calls", finish = "tool-calls"),
            assistant(id = "final", finish = "stop"),
        )

        assertEquals("final", terminalAssistantMessage(messages, "user")?.id)
        assertEquals(
            ActivityResult.Completed,
            canonicalActivityResult(terminalAssistantMessage(messages, "user")),
        )
    }

    @Test
    fun `incomplete assistant messages are not terminal`() {
        val messages = listOf(
            assistant(id = "streaming", finish = "stop", completedAt = null),
            assistant(id = "missing-finish", finish = null),
        )

        assertNull(terminalAssistantMessage(messages, "user"))
    }

    @Test
    fun `null user id never searches all historical assistants`() {
        val old = assistant(id = "old", finish = "stop", parentID = "old-user")

        assertTrue(assistantMessagesForUser(listOf(old), null).isEmpty())
        assertNull(terminalAssistantMessage(listOf(old), null))
    }

    @Test
    fun `turn ordinal selects the current user and ignores later turns`() {
        val messages = listOf(
            user("old-user"),
            assistant(id = "old-agent", finish = "stop", parentID = "old-user"),
            user("current-user"),
            assistant(
                id = "current-agent",
                finish = "content-filter",
                errorName = "ContentFilterError",
                parentID = "current-user",
            ),
            user("next-user"),
            assistant(id = "next-agent", finish = "stop", parentID = "next-user"),
        )

        assertEquals("current-agent", terminalAssistantMessage(messages, null, userTurnOrdinal = 1)?.id)
    }

    private fun assistant(
        id: String,
        finish: String? = "stop",
        completedAt: Long? = 20,
        errorName: String? = null,
        errorMessage: String? = null,
        parentID: String = "user",
    ) = DevEcoHttpApi.SessionMessageTime(
        id = id,
        role = "assistant",
        createdAt = 10,
        completedAt = completedAt,
        finish = finish,
        errorName = errorName,
        errorMessage = errorMessage,
        parentID = parentID,
    )

    private fun user(id: String) = DevEcoHttpApi.SessionMessageTime(
        id = id,
        role = "user",
        createdAt = 1,
        completedAt = null,
    )
}
