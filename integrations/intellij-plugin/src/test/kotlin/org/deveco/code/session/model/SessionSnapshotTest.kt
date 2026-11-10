package org.deveco.code.session.model

import com.agentclientprotocol.model.ToolCallStatus
import com.agentclientprotocol.model.ToolKind
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.deveco.code.acp.DevEcoHttpApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

internal class SessionSnapshotTest {

    @Test
    fun `aborted assistant without parts still renders an interrupted turn`() {
        val rendered = renderSessionSnapshot(
            listOf(
                user("u1", 10),
                assistant(
                    id = "a1",
                    parentID = "u1",
                    created = 20,
                    completed = 30,
                    errorName = "MessageAbortedError",
                    errorMessage = "aborted",
                ),
            ),
        )

        val agent = rendered.single { it.role == ChatRole.AGENT }
        assertEquals("a1", agent.id)
        assertTrue(agent.interrupted)
        assertEquals(null, agent.errorText)
        assertEquals(30L, agent.completedAt)
    }

    @Test
    fun `terminal failure without parts restores failed footer reason`() {
        val rendered = renderSessionSnapshot(
            listOf(
                user("u1", 10),
                assistant(
                    id = "a1",
                    parentID = "u1",
                    created = 20,
                    completed = 30,
                    errorName = "APIError",
                ),
            ),
        )

        val agent = rendered.single { it.role == ChatRole.AGENT }
        assertEquals("APIError", agent.errorText)
        assertTrue(agent.isComplete)
    }

    @Test
    fun `assistant message is ordered by parent rather than delayed creation time`() {
        val rendered = renderSessionSnapshot(
            listOf(
                user("u1", 10),
                user("u2", 20),
                assistant("a1", "u1", 30, 40, parts = listOf(text("p1", "a1", "answer one"))),
                assistant("a2", "u2", 25, 35, parts = listOf(text("p2", "a2", "answer two"))),
            ),
        )

        assertEquals(listOf("USER-u1", "a1", "USER-u2", "a2"), rendered.map { it.id })
    }

    @Test
    fun `assistant parts keep their durable reasoning text and tool order`() {
        val rendered = renderSessionSnapshot(
            listOf(
                user("u1", 10),
                assistant(
                    "a1",
                    "u1",
                    20,
                    40,
                    parts = listOf(
                        reasoning("reason-1", "a1", "first thought"),
                        text("text-1", "a1", "first answer"),
                        reasoning("reason-2", "a1", "second thought"),
                        text("text-2", "a1", "second answer"),
                    ),
                ),
            ),
        )

        assertEquals(
            listOf(
                ChatRole.THOUGHT to "thought-a1",
                ChatRole.AGENT to "a1",
                ChatRole.THOUGHT to "thought-a1-reason-2",
                ChatRole.AGENT to "agent-a1-text-2",
            ),
            rendered.drop(1).map { it.role to it.id },
        )
    }

    @Test
    fun `synthetic user rows do not shift visible prompt decorations`() {
        val attachment = AttachmentItem("diagram.png", "/tmp/diagram.png", "image/png", true)
        val rendered = renderSessionSnapshot(
            snapshot = listOf(
                user("u1", 10, "first"),
                user(
                    "internal",
                    20,
                    parts = listOf(
                        text("internal-part", "internal", "background notification", synthetic = true),
                    ),
                ),
                user("u2", 30, "second"),
            ),
            originalTexts = mapOf(0 to "original first", 1 to "original second"),
            attachments = mapOf(0 to listOf(attachment)),
        )

        val visibleUsers = rendered.filter { it.role == ChatRole.USER && !it.internalOnly }
        assertEquals(listOf("original first", "original second"), visibleUsers.map { it.text })
        assertEquals(listOf(attachment), visibleUsers.first().attachments)
        val internal = rendered.single { it.id == "USER-internal" }
        assertTrue(internal.internalOnly)
        assertEquals("background notification", internal.text)
    }

    @Test
    fun `snapshot reuses live ids for user and first reasoning segment`() {
        val localUser = ChatItem(
            id = "USER-live",
            role = ChatRole.USER,
            title = "You",
            text = "prompt",
        )
        val rendered = renderSessionSnapshot(
            snapshot = listOf(
                user("u1", 10),
                assistant(
                    "a1",
                    "u1",
                    20,
                    30,
                    parts = listOf(
                        reasoning("reason-1", "a1", "thinking"),
                        text("text-1", "a1", "answer"),
                    ),
                ),
            ),
            localUsers = listOf(localUser),
        )

        assertEquals(listOf("USER-live", "thought-a1", "a1"), rendered.map { it.id })
    }

    @Test
    fun `local system rows are reinserted at their previous timeline position`() {
        val previous = listOf(
            ChatItem("USER-1", ChatRole.USER, "You", "prompt"),
            ChatItem("LOCAL-ERROR", ChatRole.SYSTEM, "System", "send failed"),
            ChatItem("a1", ChatRole.AGENT, "Agent", "answer"),
        )
        val rendered = listOf(
            previous[0].copy(text = "authoritative prompt"),
            previous[2].copy(text = "authoritative answer"),
        )

        val merged = mergeSnapshotItems(rendered, previous, listOf(previous[1]))

        assertEquals(listOf("USER-1", "LOCAL-ERROR", "a1"), merged.map { it.id })
    }

    @Test
    fun `failed tool keeps status error text and path from durable state`() {
        val state = buildJsonObject {
            put("status", "error")
            putJsonObject("input") {
                put("filePath", "/workspace/Main.ets")
            }
            put("error", "compile failed")
            putJsonObject("time") {
                put("start", 12)
                put("end", 34)
            }
        }
        val rendered = renderSessionSnapshot(
            listOf(
                user("u1", 10),
                assistant(
                    "a1",
                    "u1",
                    20,
                    40,
                    parts = listOf(
                        DevEcoHttpApi.SessionPart(
                            "p1",
                            "a1",
                            "tool",
                            buildJsonObject {
                                put("callID", "call-1")
                                put("tool", "edit")
                                put("state", state)
                            },
                        ),
                    ),
                ),
            ),
        )

        val tool = rendered.single { it.role == ChatRole.TOOL }
        assertEquals("tool-call-1", tool.id)
        assertEquals(ToolCallStatus.FAILED, tool.toolStatus)
        assertEquals(ToolKind.EDIT, tool.toolKind)
        assertEquals("compile failed", tool.text)
        assertEquals("/workspace/Main.ets", tool.toolPath)
    }

    @Test
    fun `user rendering keeps restored display text attachments and file references`() {
        val attachment = AttachmentItem("diagram.png", "/tmp/diagram.png", "image/png", true)
        val reference = FileReference("src/Main.ets", 1, 1)
        val rendered = renderSessionSnapshot(
            snapshot = listOf(user("u1", 10, "expanded prompt body")),
            originalTexts = mapOf(0 to "original prompt"),
            attachments = mapOf(0 to listOf(attachment)),
            fileReferences = mapOf(0 to listOf(reference)),
        )

        val message = rendered.single()
        assertEquals("original prompt", message.text)
        assertEquals(listOf(attachment), message.attachments)
        assertEquals(listOf(reference), message.fileReferences)
    }

    @Test
    fun `user-only snapshot keeps an early stopped prompt visible`() {
        val rendered = renderSessionSnapshot(
            snapshot = listOf(user("u1", 10, "stopped before the model answered")),
        )

        val message = rendered.single()
        assertEquals(ChatRole.USER, message.role)
        assertEquals("stopped before the model answered", message.text)
    }

    @Test
    fun `compaction part is restored as the turn divider`() {
        val rendered = renderSessionSnapshot(
            listOf(
                user("u1", 10, parts = listOf(compaction("compact-1", "u1"))),
                assistant("a1", "u1", 20, 30, parts = listOf(text("p1", "a1", "summary"))),
            ),
        )

        val divider = rendered.first()
        assertEquals("TURN-u1", divider.id)
        assertEquals(ChatRole.SYSTEM, divider.role)
        assertTrue(divider.turnBoundary)
        assertTrue(divider.compactionDivider)
        // The summary answer belongs to the NEW turn after the divider.
        assertEquals(listOf("TURN-u1", "a1"), rendered.map { it.id })
    }

    @Test
    fun `subtask turn copies only its own answer`() {
        val rendered = renderSessionSnapshot(
            listOf(
                user("u1", 10, "do something"),
                assistant("a1", "u1", 20, 30, parts = listOf(text("p1", "a1", "first answer"))),
                user("u2", 40, parts = listOf(subtask("subtask-1", "u2"))),
                assistant("a2", "u2", 50, 60, parts = listOf(text("p2", "a2", "second answer"))),
            ),
        )

        val boundary = rendered.single { it.turnBoundary }
        assertEquals("TURN-u2", boundary.id)
        assertTrue(boundary.internalOnly)
        assertEquals("second answer", collectTurnAgentText(rendered, rendered.single { it.id == "a2" }))
        assertEquals("first answer", collectTurnAgentText(rendered, rendered.single { it.id == "a1" }))
    }

    @Test
    fun `marker-only debug turn renders an invisible boundary`() {
        val rendered = renderSessionSnapshot(
            listOf(user("u1", 10, parts = listOf(debugState("debug-1", "u1")))),
        )

        val boundary = rendered.single()
        assertEquals("TURN-u1", boundary.id)
        assertTrue(boundary.turnBoundary)
        assertTrue(boundary.internalOnly)
    }

    @Test
    fun `sticky debug enter keeps its internal row behind the boundary`() {
        val rendered = renderSessionSnapshot(
            listOf(
                user(
                    "u1",
                    10,
                    parts = listOf(
                        text("t1", "u1", "/debug agent", synthetic = true),
                        debugState("debug-1", "u1"),
                    ),
                ),
            ),
        )

        assertEquals(listOf("TURN-u1", "USER-u1"), rendered.map { it.id })
        assertTrue(rendered.last().internalOnly)
    }

    @Test
    fun `local turn markers are dropped in favor of snapshot projections`() {
        val messages = listOf(
            ChatItem(
                id = "TURN-COMPACT-1",
                role = ChatRole.SYSTEM,
                title = "",
                text = "",
                turnBoundary = true,
                compactionDivider = true,
            ),
            newTurnBoundary("TURN-2"),
            ChatItem("LOCAL-ERROR", ChatRole.SYSTEM, "System", "send failed"),
            ChatItem("${SNAPSHOT_SYSTEM_ID_PREFIX}retry-1", ChatRole.SYSTEM, "System", "retry"),
            ChatItem("${PROVISIONAL_ERROR_ID_PREFIX}1", ChatRole.SYSTEM, "System", "provisional"),
            ChatItem("AGENT-1", ChatRole.AGENT, "Agent", "text"),
        )

        assertEquals(listOf("LOCAL-ERROR"), snapshotLocalSystemRows(messages).map { it.id })
    }

    private fun user(
        id: String,
        created: Long,
        text: String = "prompt",
        parts: List<DevEcoHttpApi.SessionPart> = listOf(text("$id-part", id, text)),
    ) = DevEcoHttpApi.SessionMessageTime(
        id = id,
        role = "user",
        createdAt = created,
        completedAt = created,
        parts = parts,
    )

    private fun assistant(
        id: String,
        parentID: String,
        created: Long,
        completed: Long,
        errorName: String? = null,
        errorMessage: String? = null,
        parts: List<DevEcoHttpApi.SessionPart> = emptyList(),
    ) = DevEcoHttpApi.SessionMessageTime(
        id = id,
        role = "assistant",
        createdAt = created,
        completedAt = completed,
        errorName = errorName,
        errorMessage = errorMessage,
        parentID = parentID,
        parts = parts,
    )

    private fun text(id: String, messageID: String, value: String, synthetic: Boolean = false) =
        DevEcoHttpApi.SessionPart(
            id = id,
            messageID = messageID,
            type = "text",
            data = buildJsonObject {
                put("type", "text")
                put("text", value)
                if (synthetic) put("synthetic", true)
            },
        )

    private fun reasoning(id: String, messageID: String, value: String) = DevEcoHttpApi.SessionPart(
        id = id,
        messageID = messageID,
        type = "reasoning",
        data = buildJsonObject {
            put("type", "reasoning")
            put("text", value)
        },
    )

    private fun compaction(id: String, messageID: String) = DevEcoHttpApi.SessionPart(
        id = id,
        messageID = messageID,
        type = "compaction",
        data = buildJsonObject {
            put("type", "compaction")
            put("auto", true)
        },
    )

    private fun subtask(id: String, messageID: String) = DevEcoHttpApi.SessionPart(
        id = id,
        messageID = messageID,
        type = "subtask",
        data = buildJsonObject { put("type", "subtask") },
    )

    private fun debugState(id: String, messageID: String) = DevEcoHttpApi.SessionPart(
        id = id,
        messageID = messageID,
        type = "debug-state",
        data = buildJsonObject {
            put("type", "debug-state")
            put("state", "status")
        },
    )
}
