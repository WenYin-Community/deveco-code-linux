package org.deveco.code.session.replay

import org.deveco.code.acp.DevEcoHttpApi
import org.deveco.code.session.model.conversation.ConversationItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReplayMessageTimesTest {

    private fun serverMessage(
        id: String,
        role: String,
        createdAt: Long = 0L,
        parentID: String? = null,
        errorName: String? = null,
        errorMessage: String? = null,
        hasSubtaskPart: Boolean = false,
    ) = DevEcoHttpApi.SessionMessageTime(
        id = id,
        role = role,
        createdAt = createdAt,
        completedAt = null,
        errorName = errorName,
        errorMessage = errorMessage,
        parentID = parentID,
        hasSubtaskPart = hasSubtaskPart,
    )

    @Test
    fun `visible user ordinals skip subtask messages`() {
        val items = listOf(
            ConversationItem.user("local-1", "one"),
            ConversationItem.user("local-2", "two"),
        )
        val server = listOf(
            serverMessage("server-1", "user", createdAt = 10),
            serverMessage("subtask", "user", createdAt = 20, hasSubtaskPart = true),
            serverMessage("server-2", "user", createdAt = 30),
        )

        assertEquals(listOf("server-1", "server-2"), visibleServerUserMessages(server).map { it.id })
        assertEquals(
            mapOf("local-1" to 10L, "local-2" to 30L),
            borrowedUserCreatedAt(items, visibleServerUserMessages(server)),
        )
    }

    @Test
    fun `agent ids missing from server times are detected`() {
        val items = listOf(
            ConversationItem.agent("agent-1", "one"),
            ConversationItem.agent("agent-2", "two"),
            ConversationItem.user("user-1", "prompt"),
        )

        assertEquals(setOf("agent-2"), agentIdsMissingServerTimes(items, setOf("agent-1")))
    }

    @Test
    fun `only the final complete agent followed by metadata is moved`() {
        val followed = listOf(
            ConversationItem.user("user-1", "prompt"),
            ConversationItem.agent("agent-1", "answer"),
            ConversationItem.thought("thought-1", "reasoning"),
        )
        val noLongerFinal = listOf(
            ConversationItem.agent("agent-1", "first"),
            ConversationItem.thought("thought-1", "reasoning"),
            ConversationItem.agent("agent-2", "second"),
        )

        assertEquals("agent-1", lastCompleteAgentToMove(followed))
        assertNull(lastCompleteAgentToMove(noLongerFinal))
        assertTrue(lastCompleteAgentToMove(emptyList()) == null)
    }
}
