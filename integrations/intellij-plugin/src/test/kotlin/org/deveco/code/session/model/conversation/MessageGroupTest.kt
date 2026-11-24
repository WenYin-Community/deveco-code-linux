package org.deveco.code.session.model.conversation

import com.agentclientprotocol.model.ToolCallLocation
import com.agentclientprotocol.model.ToolKind
import org.deveco.code.session.ui.messages.tool.ToolItemTestFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

internal class MessageGroupTest {

    private fun thought(id: String) = ConversationItem.thought(id, "thinking $id")

    private fun tool(id: String, kind: ToolKind = ToolKind.READ, name: String? = null) = ConversationItem.tool(
        tool = ToolItemTestFactory.create(
            id = id,
            title = id,
            text = "output",
            kind = kind,
            name = name,
        ),
    )

    private fun fileTool(id: String, path: String, kind: ToolKind = ToolKind.READ, name: String? = null) =
        ConversationItem.tool(
            tool = ToolItemTestFactory.create(
                id = id,
                title = id,
                text = "output",
                kind = kind,
                locations = listOf(ToolCallLocation(path = path)),
                name = name,
            ),
        )

    private fun agent(id: String, text: String = "text") = ConversationItem.agent(id = id, text = text)

    private fun turnBoundary(id: String) = newTurnBoundary(id)

    private fun displayId(item: ConversationItem): String = item.id.removePrefix("tool-")

    private fun roles(groups: List<MessageGroup>) = groups.joinToString { group ->
        "${kindOf(group.parent)}:${displayId(group.parent)}" +
            group.children.joinToString(prefix = "[", postfix = "]") { "${kindOf(it)}:${displayId(it)}" }
    }

    private fun kindOf(item: ConversationItem): String = when (item) {
        is ConversationItem.User -> "USER"
        is ConversationItem.Assistant.Text -> "AGENT"
        is ConversationItem.Assistant.Thought -> "THOUGHT"
        is ConversationItem.Assistant.ToolItem -> "TOOL"
        is ConversationItem.System -> "SYSTEM"
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

        assertEquals("AGENT:a1[], THOUGHT:t1[THOUGHT:t2], AGENT:a2[]", roles(groups))
        assertEquals("thinking t1thinking t2", groups[1].displayText)
        assertEquals("thinking t1", groups[1].parent.text)
    }

    @Test
    fun `thought grouping does not mutate source nodes or accumulate text`() {
        val first = ConversationItem.thought("thought-1", "a")
        val second = ConversationItem.thought("thought-2", "b")
        val messages = listOf<ConversationItem>(first, second)

        val firstPass = groupMessages(messages)
        val secondPass = groupMessages(messages)

        assertSame(first, firstPass.single().parent)
        assertEquals(listOf<ConversationItem>(second), firstPass.single().children)
        assertEquals("ab", firstPass.single().displayText)
        assertEquals("ab", secondPass.single().displayText)
        assertEquals("a", first.text)
        assertEquals("b", second.text)
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
    fun `file-list runs with paths still merge into one group`() {
        val groups = groupMessages(
            listOf(
                fileTool("read-1", "entry/src/main/ets/pages/Index.ets", name = "read"),
                fileTool("read-2", "entry/src/main/ets/model/CrudItem.ets", name = "read"),
            ),
        )

        assertEquals("TOOL:read-1[TOOL:read-2]", roles(groups))
    }

    @Test
    fun `merging is per exact tool name, not per kind`() {
        val groups = groupMessages(
            listOf(
                fileTool("edit-1", "entry/src/main/ets/pages/Index.ets", ToolKind.EDIT, name = "edit"),
                fileTool("write-1", "entry/src/main/ets/model/Crud.ets", ToolKind.EDIT, name = "write"),
                fileTool("write-2", "entry/src/main/ets/model/Todo.ets", ToolKind.EDIT, name = "write"),
            ),
        )

        assertEquals("TOOL:edit-1[], TOOL:write-1[TOOL:write-2]", roles(groups))
    }

    @Test
    fun `only file-list tool names have a merge key`() {
        assertEquals("edit", mergeableToolName(" EDIT "))
        assertEquals("write", mergeableToolName("write"))
        assertNull(mergeableToolName("grep"))
        assertNull(mergeableToolName("apply_patch"))
    }

    @Test
    fun `text outputs never merge even with a path`() {
        val groups = groupMessages(
            listOf(
                fileTool("grep-1", "entry/src/main", ToolKind.SEARCH, name = "grep"),
                fileTool("grep-2", "entry/src/main", ToolKind.SEARCH, name = "grep"),
                fileTool("bash-1", "/project", ToolKind.EXECUTE, name = "bash"),
                fileTool("task-1", "/project", ToolKind.THINK, name = "task"),
            ),
        )

        assertEquals("TOOL:grep-1[], TOOL:grep-2[], TOOL:bash-1[], TOOL:task-1[]", roles(groups))
    }

    @Test
    fun `glob merges because its output lines are a file list`() {
        fun glob(id: String, path: String) = ConversationItem.tool(
            ToolItemTestFactory.create(
                id = id,
                title = id,
                text = path,
                kind = ToolKind.SEARCH,
                name = "glob",
            ),
        )

        val groups = groupMessages(
            listOf(
                glob("glob-1", "entry/src/Index.ets"),
                glob("glob-2", "entry/src/App.ets"),
            ),
        )

        assertEquals("TOOL:glob-1[TOOL:glob-2]", roles(groups))
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
    fun `other tools keep their own card even when they carry a file path`() {
        val groups = groupMessages(
            listOf(
                agent("a1"),
                tool("ide-search-symbol", ToolKind.OTHER),
                fileTool("ide-open-file", "entry/src/main/ets/components/TodoCrud.ets", ToolKind.OTHER),
                fileTool("ide-read-file", "entry/src/main/ets/pages/Index.ets", ToolKind.OTHER),
            ),
        )

        assertEquals(
            "AGENT:a1[], TOOL:ide-search-symbol[], TOOL:ide-open-file[], TOOL:ide-read-file[]",
            roles(groups),
        )
    }

    @Test
    fun `other tools without a narration parent keep their own card`() {
        val groups = groupMessages(
            listOf(
                tool("ide-list-tree", ToolKind.OTHER),
                fileTool("ide-open-file", "entry/src/main/ets/components/TodoCrud.ets", ToolKind.OTHER),
            ),
        )

        assertEquals("TOOL:ide-list-tree[], TOOL:ide-open-file[]", roles(groups))
    }

    @Test
    fun `internal user notification is not a turn boundary`() {
        val internal = ConversationItem.user(
            id = "background",
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
        assertTrue((messages[1] as ConversationItem.System).turnBoundary)
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
                "tool-subtask-call" to "user-subtask",
            ),
            subtaskUserIds = setOf("user-subtask"),
        )

        assertEquals("TURN-user-subtask", messages[1].id)
        assertTrue((messages[1] as ConversationItem.System).turnBoundary)
    }
}
