package org.deveco.code.session.model.conversation

import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.snapshots.Snapshot
import com.agentclientprotocol.model.ContentBlock
import com.agentclientprotocol.model.SessionUpdate
import com.agentclientprotocol.model.ToolCallContent
import com.agentclientprotocol.model.ToolCallId
import com.agentclientprotocol.model.ToolCallLocation
import com.agentclientprotocol.model.ToolCallStatus
import com.agentclientprotocol.model.ToolKind
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.deveco.code.session.tool.ToolEditTracker
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

internal class ToolItemTest {
    @Test
    fun `created tool retains its native ACP object`() {
        val native = SessionUpdate.ToolCall(
            toolCallId = ToolCallId("call-1"),
            title = "read",
            kind = ToolKind.READ,
            status = ToolCallStatus.PENDING,
            rawInput = JsonObject(mapOf("filePath" to JsonPrimitive("/project/Main.kt"))),
        )
        val item = toolItemFrom(native)

        assertSame(native, item.native)
        assertEquals("call-1", item.callId())
        assertEquals("read", item.native.title)
        assertEquals(ToolKind.READ, item.kind())
        assertEquals(ToolCallStatus.PENDING, item.status())
        assertEquals("/project/Main.kt", ((item.rawInput() as JsonObject)["filePath"] as JsonPrimitive).content)
    }

    @Test
    fun `read tool name classifies as read without ACP kind`() {
        val item = toolItemFrom(
            SessionUpdate.ToolCall(
                toolCallId = ToolCallId("call-1"),
                title = "read",
                status = ToolCallStatus.COMPLETED,
                locations = listOf(ToolCallLocation(path = "/project/Main.kt")),
                _meta = JsonObject(mapOf("tool_name" to JsonPrimitive("read"))),
            ),
        )

        assertTrue(item is ConversationItem.Assistant.ToolItem.Read)
        assertEquals(
            "/project/Main.kt",
            (item as ConversationItem.Assistant.ToolItem.Read).primaryPath,
        )
    }

    @Test
    fun `other tool with read kind stays generic`() {
        val item = toolItemFrom(
            SessionUpdate.ToolCall(
                toolCallId = ToolCallId("call-1"),
                title = "glob",
                kind = ToolKind.READ,
                status = ToolCallStatus.COMPLETED,
                locations = listOf(ToolCallLocation(path = "/project/Main.kt")),
                _meta = JsonObject(mapOf("tool_name" to JsonPrimitive("glob"))),
            ),
        )

        assertTrue(item is ConversationItem.Assistant.ToolItem.Generic)
    }

    @Test
    fun `task title prefers model authored description over synthetic kind`() {
        val item = ConversationItem.Assistant.ToolItem.Subagent(
            native = SessionUpdate.ToolCall(
                toolCallId = ToolCallId("call-1"),
                title = "think",
                kind = ToolKind.THINK,
                status = ToolCallStatus.IN_PROGRESS,
                rawInput = JsonObject(
                    mapOf("description" to JsonPrimitive("Analyze crash logs")),
                ),
                _meta = JsonObject(mapOf("tool_name" to JsonPrimitive("task"))),
            ),
            description = "Analyze crash logs",
        )

        assertEquals("Analyze crash logs", item.displayTitle())
    }

    @Test
    fun `partial update preserves the previous human title`() {
        val previous = ConversationItem.Assistant.ToolItem.Generic(
            native = SessionUpdate.ToolCall(
                toolCallId = ToolCallId("call-1"),
                title = "Search project",
                kind = ToolKind.SEARCH,
                status = ToolCallStatus.IN_PROGRESS,
                _meta = JsonObject(mapOf("tool_name" to JsonPrimitive("grep"))),
            ),
        )
        previous.toggleExpanded()
        val update = SessionUpdate.ToolCallUpdate(
            toolCallId = ToolCallId("call-1"),
            status = ToolCallStatus.COMPLETED,
        )

        val merged = reduceConversationToolItem(previous, update)

        assertSame(previous, merged)
        assertTrue(merged.expanded)
        assertEquals("Search project", merged.displayTitle())
        assertEquals(ToolCallStatus.COMPLETED, merged.status())
    }

    @Test
    fun `synthetic update title does not replace the previous human title`() {
        val previous = ConversationItem.Assistant.ToolItem.Generic(
            native = SessionUpdate.ToolCall(
                toolCallId = ToolCallId("call-1"),
                title = "Search project",
                kind = ToolKind.SEARCH,
                status = ToolCallStatus.IN_PROGRESS,
                _meta = JsonObject(mapOf("tool_name" to JsonPrimitive("grep"))),
            ),
        )
        val update = SessionUpdate.ToolCallUpdate(
            toolCallId = ToolCallId("call-1"),
            title = "search",
            kind = ToolKind.SEARCH,
            status = ToolCallStatus.IN_PROGRESS,
        )

        val merged = reduceConversationToolItem(previous, update)

        assertEquals("Search project", merged.displayTitle())
    }

    @Test
    fun `tool kind is never used as a display title`() {
        val item = ConversationItem.Assistant.ToolItem.Subagent(
            native = SessionUpdate.ToolCall(
                toolCallId = ToolCallId("call-1"),
                title = "think",
                kind = ToolKind.THINK,
                status = ToolCallStatus.IN_PROGRESS,
                _meta = JsonObject(mapOf("tool_name" to JsonPrimitive("task"))),
            ),
            description = null,
        )

        assertEquals("task", item.displayTitle())
    }

    @Test
    fun `partial ACP update replaces present fields and preserves omitted fields`() {
        val previous = ConversationItem.Assistant.ToolItem.Generic(
            native = SessionUpdate.ToolCall(
                toolCallId = ToolCallId("call-1"),
                title = "Search project",
                kind = ToolKind.SEARCH,
                status = ToolCallStatus.IN_PROGRESS,
                rawInput = JsonObject(mapOf("query" to JsonPrimitive("needle"))),
                _meta = JsonObject(mapOf("tool_name" to JsonPrimitive("grep"))),
            ),
        )
        val update = SessionUpdate.ToolCallUpdate(
            toolCallId = ToolCallId("call-1"),
            status = ToolCallStatus.COMPLETED,
            content = listOf(ToolCallContent.Content(ContentBlock.Text("result"))),
            rawOutput = JsonObject(mapOf("matches" to JsonPrimitive(2))),
            locations = listOf(ToolCallLocation(path = "/project/Main.kt", line = 4u)),
        )

        val merged = reduceConversationToolItem(previous, update)

        assertEquals("Search project", merged.native.title)
        assertEquals(ToolKind.SEARCH, merged.kind())
        assertEquals(ToolCallStatus.COMPLETED, merged.status())
        assertEquals("result", merged.outputText)
        assertEquals("needle", ((merged.rawInput() as JsonObject)["query"] as JsonPrimitive).content)
        assertEquals("grep", merged.name())
        assertEquals("/project/Main.kt", merged.locations().single().path)
    }

    @Test
    fun `subagent keeps running while the dispatch receipt is running`() {
        val previous = ConversationItem.Assistant.ToolItem.Subagent(
            native = SessionUpdate.ToolCall(
                toolCallId = ToolCallId("call-1"),
                title = "think",
                kind = ToolKind.THINK,
                status = ToolCallStatus.IN_PROGRESS,
                rawInput = JsonObject(mapOf("description" to JsonPrimitive("Inspect tests"))),
                _meta = JsonObject(mapOf("tool_name" to JsonPrimitive("task"))),
            ),
            description = "Inspect tests",
        )
        val receipt = """
            <task id="child-1" state="running"><task_result>started</task_result></task>
        """.trimIndent()
        val update = SessionUpdate.ToolCallUpdate(
            toolCallId = ToolCallId("call-1"),
            status = ToolCallStatus.COMPLETED,
            content = listOf(ToolCallContent.Content(ContentBlock.Text(receipt))),
            rawOutput = JsonObject(
                mapOf(
                    "metadata" to JsonObject(
                        mapOf(
                            "background" to JsonPrimitive(true),
                            "jobId" to JsonPrimitive("child-1"),
                            "parentSessionId" to JsonPrimitive("parent-1"),
                        ),
                    ),
                ),
            ),
        )

        val merged = reduceConversationToolItem(previous, update) as ConversationItem.Assistant.ToolItem.Subagent

        assertEquals("Inspect tests", merged.displayTitle())
        assertEquals(ToolCallStatus.IN_PROGRESS, merged.status())
        assertEquals("child-1", merged.backgroundJobId())
        assertEquals("parent-1", merged.backgroundParentId())
    }

    @Test
    fun `same subtype mutates in place and retains tracked file edits`() {
        val tracked = listOf(ToolEditTracker.FileEdit("/project/Main.kt", 3, 1))
        val previous = ConversationItem.Assistant.ToolItem.FileMutation(
            native = SessionUpdate.ToolCall(
                toolCallId = ToolCallId("call-1"),
                title = "edit",
                kind = ToolKind.EDIT,
                status = ToolCallStatus.IN_PROGRESS,
            ),
        )
        val update = SessionUpdate.ToolCallUpdate(
            toolCallId = ToolCallId("call-1"),
            status = ToolCallStatus.COMPLETED,
        )

        val merged = reduceConversationToolItem(previous, update) as ConversationItem.Assistant.ToolItem.FileMutation

        assertSame(previous, merged)
        assertEquals(ToolCallStatus.COMPLETED, merged.status())
        val replacement = listOf(ToolEditTracker.FileEdit("/project/Main.kt", 4, 2))
        val observed = derivedStateOf { merged.fileEdits }
        assertEquals(emptyList<ToolEditTracker.FileEdit>(), observed.value)

        merged.setFileEdits(tracked)
        Snapshot.sendApplyNotifications()

        assertEquals(tracked, observed.value)
        merged.setFileEdits(replacement)
        assertEquals(replacement, merged.fileEdits)
        assertEquals(ToolCallStatus.COMPLETED, merged.status())
    }

    @Test
    fun `tool reducer replaces subtype when tool name changes to read`() {
        val previous = ConversationItem.Assistant.ToolItem.Generic(
            native = SessionUpdate.ToolCall(
                toolCallId = ToolCallId("call-1"),
                title = "Inspect",
                kind = ToolKind.SEARCH,
                status = ToolCallStatus.IN_PROGRESS,
            ),
        )
        previous.toggleExpanded()
        val update = SessionUpdate.ToolCallUpdate(
            toolCallId = ToolCallId("call-1"),
            title = "Read file",
            kind = ToolKind.READ,
            status = ToolCallStatus.COMPLETED,
            locations = listOf(ToolCallLocation(path = "/project/Main.kt")),
            _meta = JsonObject(mapOf("tool_name" to JsonPrimitive("read"))),
        )

        val reduced = reduceConversationToolItem(previous, update)

        assertNotSame(previous, reduced)
        assertTrue(reduced is ConversationItem.Assistant.ToolItem.Read)
        assertEquals(previous.id, reduced.id)
        assertTrue(reduced.expanded)
        assertEquals("/project/Main.kt", (reduced as ConversationItem.Assistant.ToolItem.Read).primaryPath)
    }
}
