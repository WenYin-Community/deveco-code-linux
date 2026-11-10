package org.deveco.code.session.model

import com.agentclientprotocol.model.ToolKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

internal class MessageGroupTest {

    private fun thought(id: String, sourceMessageId: String? = null) =
        ChatItem(id, ChatRole.THOUGHT, "Thought", "thinking $id", sourceMessageId = sourceMessageId)

    private fun tool(id: String, kind: ToolKind = ToolKind.READ, sourceMessageId: String? = null) =
        ChatItem(id, ChatRole.TOOL, id, "output", toolKind = kind, sourceMessageId = sourceMessageId)

    private fun fileTool(id: String, path: String, kind: ToolKind = ToolKind.READ) =
        ChatItem(id, ChatRole.TOOL, id, "output", toolKind = kind, toolPath = path)

    private fun agent(
        id: String,
        text: String = "text",
        interrupted: Boolean = false,
        errorText: String? = null,
        completedAt: Long = 0,
        sourceMessageId: String? = null,
    ) = ChatItem(
        id = id,
        role = ChatRole.AGENT,
        title = "Agent",
        text = text,
        interrupted = interrupted,
        errorText = errorText,
        completedAt = completedAt,
        sourceMessageId = sourceMessageId,
    )

    private fun turnBoundary(id: String) = newTurnBoundary(id)

    private fun roles(groups: List<MessageGroup>) = groups.joinToString { group ->
        "${group.parent.role}:${group.parent.id}" +
            group.children.joinToString(prefix = "[", postfix = "]") { "${it.role}:${it.id}" }
    }

    @Test
    fun `thought after narration and tools keeps its own group`() {
        val groups = groupMessages(
            listOf(
                agent("a1"),
                thought("t1"),
                tool("read-1"),
                thought("t2"),
                tool("read-2"),
                thought("t3"),
            ),
        )

        assertEquals(
            "AGENT:a1[], THOUGHT:t1[], TOOL:read-1[], THOUGHT:t2[], TOOL:read-2[], THOUGHT:t3[]",
            roles(groups),
        )
    }

    @Test
    fun `thought between tool calls is not swallowed as tool child`() {
        val groups = groupMessages(
            listOf(
                thought("t1"),
                tool("read-1"),
                thought("t2"),
                tool("read-2"),
            ),
        )

        assertEquals(
            "THOUGHT:t1[], TOOL:read-1[], THOUGHT:t2[], TOOL:read-2[]",
            roles(groups),
        )
    }

    @Test
    fun `consecutive thoughts merge into one standalone group`() {
        val groups = groupMessages(
            listOf(
                agent("a1"),
                thought("t1"),
                thought("t2"),
                agent("a2"),
            ),
        )

        assertEquals("AGENT:a1[], THOUGHT:t1[], AGENT:a2[]", roles(groups))
        assertEquals("thinking t1thinking t2", groups[1].parent.text)
    }

    @Test
    fun `parallel subagent calls are separate groups and keep stream order`() {
        val groups = groupMessages(
            listOf(
                thought("t1"),
                tool("read-1"),
                tool("task-1", ToolKind.THINK),
                tool("task-2", ToolKind.THINK),
            ),
        )

        assertEquals("THOUGHT:t1[], TOOL:read-1[], TOOL:task-1[], TOOL:task-2[]", roles(groups))
    }

    @Test
    fun `interleaved subagent and read calls keep stream order`() {
        val groups = groupMessages(
            listOf(
                tool("task-1", ToolKind.THINK),
                tool("read-1"),
                tool("task-2", ToolKind.THINK),
            ),
        )

        assertEquals("TOOL:task-1[], TOOL:read-1[], TOOL:task-2[]", roles(groups))
    }

    @Test
    fun `consecutive command calls keep their own output`() {
        val groups = groupMessages(
            listOf(
                agent("a1"),
                tool("cmd-1", ToolKind.EXECUTE),
                tool("cmd-2", ToolKind.EXECUTE),
            ),
        )

        assertEquals("AGENT:a1[], TOOL:cmd-1[], TOOL:cmd-2[]", roles(groups))
        assertEquals("output", groups[2].parent.text)
    }

    @Test
    fun `same-kind runs separated by another kind do not merge`() {
        val groups = groupMessages(
            listOf(
                tool("read-1"),
                tool("edit-1", ToolKind.EDIT),
                tool("read-2"),
            ),
        )

        assertEquals("TOOL:read-1[], TOOL:edit-1[], TOOL:read-2[]", roles(groups))
    }

    @Test
    fun `same-kind runs with file paths still merge into one group`() {
        val groups = groupMessages(
            listOf(
                fileTool("read-1", "entry/src/main/ets/pages/Index.ets"),
                fileTool("read-2", "entry/src/main/ets/model/CrudItem.ets"),
            ),
        )

        assertEquals("TOOL:read-1[TOOL:read-2]", roles(groups))
    }

    @Test
    fun `pathless tools of one kind keep their own card instead of merging`() {
        val groups = groupMessages(
            listOf(
                agent("a1"),
                tool("question-1", ToolKind.OTHER),
                tool("plan-exit-1", ToolKind.OTHER),
            ),
        )

        assertEquals("AGENT:a1[], TOOL:question-1[], TOOL:plan-exit-1[]", roles(groups))
    }

    @Test
    fun `invisible turn boundary separates footer anchors`() {
        val groups = groupMessages(
            listOf(
                agent("normal"),
                turnBoundary("turn-2"),
                agent("subtask"),
            ),
        )

        val anchors = turnFooterAnchors(groups)

        assertTrue("normal" in anchors.agentByAnchorId.values)
        assertTrue("subtask" in anchors.agentByAnchorId.values)
    }

    @Test
    fun `terminal status follows thinking after the final agent segment`() {
        val groups = groupMessages(
            listOf(
                agent("a1", interrupted = true, completedAt = 20, sourceMessageId = "m1"),
                thought("t1", sourceMessageId = "m1"),
            ),
        )

        val anchors = turnFooterAnchors(groups)
        val status = anchors.terminalStatusByAnchorId.getValue("t1")

        assertEquals("stopped", status.status)
        assertEquals(20L, status.timestamp)
        assertEquals("a1", anchors.agentByAnchorId["t1"])
    }

    @Test
    fun `terminal status follows tools after the final agent segment`() {
        val groups = groupMessages(
            listOf(
                agent("a1", errorText = "model failed", completedAt = 30, sourceMessageId = "m1"),
                tool("read-1", sourceMessageId = "m1"),
            ),
        )

        val anchors = turnFooterAnchors(groups)
        val status = anchors.terminalStatusByAnchorId.getValue("read-1")

        assertEquals("failed", status.status)
        assertEquals("model failed", status.errorText)
        assertEquals(30L, status.timestamp)
        assertEquals("a1", anchors.agentByAnchorId["read-1"])
    }

    @Test
    fun `thinking-only stop keeps terminal status after thinking`() {
        val groups = groupMessages(
            listOf(
                thought("t1", sourceMessageId = "m1"),
                agent("placeholder", text = "", interrupted = true, completedAt = 40, sourceMessageId = "m1"),
            ),
        )

        val anchors = turnFooterAnchors(groups)
        val status = anchors.terminalStatusByAnchorId.getValue("t1")

        assertEquals("stopped", status.status)
        assertFalse(anchors.agentByAnchorId.containsValue("placeholder"))
    }

    @Test
    fun `failed turn without body anchors its error for the footer copy button`() {
        val groups = groupMessages(
            listOf(
                agent("placeholder", text = "", errorText = "APIError: 429 rate limit", completedAt = 40, sourceMessageId = "m1"),
            ),
        )

        val anchors = turnFooterAnchors(groups)
        val status = anchors.terminalStatusByAnchorId.getValue("placeholder")

        assertEquals("failed", status.status)
        assertEquals("APIError: 429 rate limit", status.errorText)
        // No body to copy: the footer offers the error text instead of turn text.
        assertTrue(anchors.agentByAnchorId.isEmpty())
    }

    @Test
    fun `normal turn keeps its agent footer without terminal status`() {
        val groups = groupMessages(
            listOf(
                agent("a1", "answer", sourceMessageId = "m1"),
                thought("t1", sourceMessageId = "m1"),
            ),
        )

        val anchors = turnFooterAnchors(groups)

        assertEquals("a1", anchors.agentByAnchorId["t1"])
        assertTrue(anchors.terminalStatusByAnchorId.isEmpty())
    }

    @Test
    fun `terminal status stays with the aborted assistant message before later messages`() {
        val groups = groupMessages(
            listOf(
                agent("a1", interrupted = true, completedAt = 20, sourceMessageId = "m1"),
                thought("t1", sourceMessageId = "m1"),
                agent("a2", "later assistant message", sourceMessageId = "m2"),
                thought("t2", sourceMessageId = "m2"),
            ),
        )

        val anchors = turnFooterAnchors(groups)

        assertEquals("stopped", anchors.terminalStatusByAnchorId.getValue("t1").status)
        assertFalse("t2" in anchors.terminalStatusByAnchorId)
        assertEquals("a2", anchors.agentByAnchorId["t2"])
    }

    @Test
    fun `internal user notification is not a turn boundary`() {
        val internal = ChatItem(
            id = "background",
            role = ChatRole.USER,
            title = "You",
            text = "model-facing",
            internalOnly = true,
        )

        assertFalse(isTurnBoundary(internal))
    }

    @Test
    fun `subtask copy never crosses the preceding normal turn`() {
        val messages = listOf(
            agent("normal", "previous answer"),
            turnBoundary("turn-2"),
            agent("subtask-1", "first segment"),
            tool("read-1"),
            agent("subtask-2", "second segment"),
        )

        assertEquals("first segment\n\nsecond segment", collectTurnAgentText(messages, messages.last()))
    }

    @Test
    fun `replayed subtask turn inserts one boundary before its first agent segment`() {
        val messages = insertSubtaskTurnBoundaries(
            messages = listOf(
                agent("normal"),
                agent("subtask-1"),
                tool("read-1"),
                agent("subtask-2"),
                agent("next-normal"),
            ),
            parentByLocalItemId = mapOf(
                "normal" to "user-normal-1",
                "subtask-1" to "user-subtask",
                "subtask-2" to "user-subtask",
                "next-normal" to "user-normal-2",
            ),
            subtaskUserIds = setOf("user-subtask"),
        )

        assertEquals(6, messages.size)
        assertEquals("TURN-user-subtask", messages[1].id)
        assertTrue(messages[1].turnBoundary)
    }

    @Test
    fun `replayed tool-only subtask also gets a turn boundary`() {
        val messages = insertSubtaskTurnBoundaries(
            messages = listOf(
                agent("normal"),
                tool("subtask-call"),
            ),
            parentByLocalItemId = mapOf(
                "normal" to "user-normal",
                "subtask-call" to "user-subtask",
            ),
            subtaskUserIds = setOf("user-subtask"),
        )

        assertEquals("TURN-user-subtask", messages[1].id)
        assertTrue(messages[1].turnBoundary)
    }
}
