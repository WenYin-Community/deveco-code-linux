package org.deveco.code.session.model.conversation

import com.agentclientprotocol.model.ContentBlock
import com.agentclientprotocol.model.SessionUpdate
import com.agentclientprotocol.model.ToolCallContent
import com.agentclientprotocol.model.ToolCallId
import com.agentclientprotocol.model.ToolCallStatus
import com.agentclientprotocol.model.ToolKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

internal class ConversationItemTest {
    @Test
    fun `streaming assistant content is incomplete`() {
        val text = ConversationItem.agent("agent-1", "partial", AssistantContentState.Streaming)
        val thought = ConversationItem.thought("thought-1", "reasoning", AssistantContentState.Streaming)

        assertFalse(text.isComplete)
        assertFalse(thought.isComplete)
        assertNull(text.errorText)
        assertNull(thought.errorText)
    }

    @Test
    fun `interrupted and failed assistant content expose terminal details`() {
        val interrupted = ConversationItem.thought(
            "thought-1",
            "stopped",
            AssistantContentState.Interrupted("connection closed"),
        )
        val failed = ConversationItem.agent(
            "agent-1",
            "failed",
            AssistantContentState.Failed("request failed"),
        )

        assertTrue(interrupted.isComplete)
        assertTrue(interrupted.interrupted)
        assertEquals("connection closed", interrupted.errorText)
        assertTrue(failed.isComplete)
        assertFalse(failed.interrupted)
        assertEquals("request failed", failed.errorText)
    }

    @Test
    fun `tool update routes only to a matching tool item`() {
        val tool = ConversationItem.Assistant.ToolItem.Generic(
            native = SessionUpdate.ToolCall(
                toolCallId = ToolCallId("call-1"),
                title = "grep",
                kind = ToolKind.SEARCH,
                status = ToolCallStatus.IN_PROGRESS,
                _meta = kotlinx.serialization.json.JsonObject(
                    mapOf("tool_name" to kotlinx.serialization.json.JsonPrimitive("grep")),
                ),
            ),
        )
        val item = ConversationItem.tool(tool)
        val update = SessionUpdate.ToolCallUpdate(
            toolCallId = ToolCallId("call-1"),
            status = ToolCallStatus.COMPLETED,
        )

        val updated = item.reduceToolUpdate(update)

        assertEquals(ToolCallStatus.COMPLETED, updated.toolCall()?.status())
    }

    @Test
    fun `tool update ignores a different tool call id`() {
        val tool = ConversationItem.Assistant.ToolItem.Generic(
            native = SessionUpdate.ToolCall(
                toolCallId = ToolCallId("call-1"),
                title = "grep",
                kind = ToolKind.SEARCH,
                status = ToolCallStatus.IN_PROGRESS,
            ),
        )
        val item = ConversationItem.tool(tool)
        val update = SessionUpdate.ToolCallUpdate(
            toolCallId = ToolCallId("call-2"),
            status = ToolCallStatus.COMPLETED,
        )

        assertSame(item, item.reduceToolUpdate(update))
    }

    @Test
    fun `tool update leaves non-tool content unchanged`() {
        val item = ConversationItem.user("user-1", "hello")
        val update = SessionUpdate.ToolCallUpdate(
            toolCallId = ToolCallId("call-1"),
            status = ToolCallStatus.COMPLETED,
        )

        assertSame(item, item.reduceToolUpdate(update))
    }

    @Test
    fun `merged background tool call retains its terminal marker`() {
        val first = ConversationItem.Assistant.ToolItem.Subagent(
            native = SessionUpdate.ToolCall(
                toolCallId = ToolCallId("call-1"),
                title = "task",
                kind = ToolKind.THINK,
                status = ToolCallStatus.COMPLETED,
            ),
            description = "Inspect code",
        )
        val terminal = ConversationItem.Assistant.ToolItem.Subagent(
            native = first.native.copy(
                content = listOf(ToolCallContent.Content(ContentBlock.Text("done"))),
            ),
            description = "Inspect code",
        )

        val item = mergeConversationToolItem(first, terminal, backgroundMerged = true)

        assertEquals(true, item.toolCall()?.backgroundMerged)
        assertEquals("done", item.text)
    }
}
