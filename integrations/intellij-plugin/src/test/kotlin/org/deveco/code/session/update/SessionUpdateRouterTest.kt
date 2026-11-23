package org.deveco.code.session.update

import com.agentclientprotocol.model.ContentBlock
import com.agentclientprotocol.model.MessageId
import com.agentclientprotocol.model.SessionId
import com.agentclientprotocol.model.SessionModeId
import com.agentclientprotocol.model.SessionUpdate
import com.agentclientprotocol.model.ToolCallId
import com.agentclientprotocol.model.ToolCallStatus
import com.agentclientprotocol.model.ToolKind
import com.intellij.openapi.diagnostic.Logger
import org.deveco.code.acp.AcpSessionUpdate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

internal class SessionUpdateRouterTest {
    @Test
    fun `session id mismatch is filtered before queueing`() {
        val fixture = Fixture()

        fixture.accept("other-session", agentUpdate("agent-1", "ignored"))

        assertTrue(fixture.scheduled.isEmpty())
        assertTrue(fixture.routes.isEmpty())
    }

    @Test
    fun `live callback runs before every routed update`() {
        val fixture = Fixture(prompting = true)
        fixture.accept(userUpdate("hello"))
        fixture.accept(agentUpdate("agent-1", "world"))

        fixture.drain()

        assertEquals(
            listOf(
                "live",
                "finish-thought",
                "user:hello",
                "live",
                "finish-thought",
                "agent:world",
            ),
            fixture.events,
        )
    }

    @Test
    fun `loading applies config state inline and falls through messages`() {
        val fixture = Fixture(loading = true)
        fixture.accept(update(SessionUpdate.CurrentModeUpdate(SessionModeId("mode-1"))))
        fixture.accept(update(SessionUpdate.ConfigOptionUpdate(emptyList())))
        fixture.accept(update(SessionUpdate.AvailableCommandsUpdate(emptyList())))
        fixture.accept(update(SessionUpdate.UsageUpdate(used = 75L, size = 100L)))
        fixture.accept(agentUpdate("agent-1", "historical"))

        fixture.drain()

        assertEquals(
            listOf(
                "live",
                "mode:mode-1",
                "live",
                "config:0",
                "live",
                "commands:0",
                "live",
                "usage:75:100",
                "live",
                "finish-thought",
                "agent:historical",
            ),
            fixture.events,
        )
    }

    @Test
    fun `loading ignores updates that cannot affect restored state`() {
        val fixture = Fixture(loading = true)
        fixture.accept(update(SessionUpdate.PlanUpdate(emptyList())))

        fixture.drain()

        assertEquals(listOf("live"), fixture.events)
    }

    @Test
    fun `stopped drops message updates but still accepts usage`() {
        val fixture = Fixture(stopped = true)
        fixture.accept(agentUpdate("agent-1", "late"))
        fixture.accept(update(SessionUpdate.UsageUpdate(used = 20L, size = 100L)))

        fixture.drain()

        assertEquals(listOf("live", "live", "usage:20:100"), fixture.events)
    }

    @Test
    fun `agent user and tool call finish thought before routing`() {
        val fixture = Fixture(prompting = true)
        fixture.accept(agentUpdate("agent-1", "answer"))
        fixture.accept(userUpdate("prompt"))
        fixture.accept(toolCall("tool-1"))

        fixture.drain()

        assertEquals(
            listOf(
                "live",
                "finish-thought",
                "agent:answer",
                "live",
                "finish-thought",
                "user:prompt",
                "live",
                "finish-thought",
                "tool:tool-1",
            ),
            fixture.events,
        )
    }

    @Test
    fun `thought and tool updates route without finishing thought first`() {
        val fixture = Fixture(prompting = true)
        fixture.accept(thoughtUpdate("thought-1", "reason"))
        fixture.accept(
            update(
                SessionUpdate.ToolCallUpdate(
                    toolCallId = ToolCallId("tool-1"),
                    status = ToolCallStatus.COMPLETED,
                ),
            ),
        )

        fixture.drain()

        assertEquals(
            listOf("live", "thought:reason", "live", "tool-update:tool-1"),
            fixture.events,
        )
    }

    @Test
    fun `ordering warning fires only outside active turns`() {
        val fixture = Fixture()
        fixture.accept(agentUpdate("agent-1", "orphan"))
        fixture.drain()

        assertEquals(1, fixture.warnings.size)
        assertTrue(fixture.warnings.single().contains("AgentMessageChunk"))
        assertTrue(fixture.warnings.single().contains("session-1"))

        fixture.prompting = true
        fixture.accept(agentUpdate("agent-3", "live"))
        fixture.drain()
        assertEquals(1, fixture.warnings.size)
    }

    @Test
    fun `compaction counts as an active turn for ordering`() {
        val fixture = Fixture(compacting = true)
        fixture.accept(toolCall("tool-1"))

        fixture.drain()

        assertTrue(fixture.warnings.isEmpty())
        assertEquals(listOf("live", "finish-thought", "tool:tool-1"), fixture.events)
    }

    private class Fixture(
        var loading: Boolean = false,
        var prompting: Boolean = false,
        var stopped: Boolean = false,
        var compacting: Boolean = false,
    ) {
        val events = mutableListOf<String>()
        val routes = events
        val warnings = mutableListOf<String>()
        val scheduled = mutableListOf<() -> Unit>()
        private val queue = SessionUpdateQueue(
            isDisposed = { false },
            schedule = { scheduled.add(it) },
            reportFailure = { _, _ -> },
        )
        private val router = SessionUpdateRouter(
            sessionId = { "session-1" },
            queue = queue,
            onLiveTurnEvent = { events.add("live") },
            isSessionLoading = { loading },
            isPrompting = { prompting },
            isStopped = { stopped },
            isCompacting = { compacting },
            finishThought = { events.add("finish-thought") },
            onAgentMessage = {
                events.add("agent:${(it.content as ContentBlock.Text).text}")
            },
            onUserMessage = {
                events.add("user:${(it.content as ContentBlock.Text).text}")
            },
            onThought = {
                events.add("thought:${(it.content as ContentBlock.Text).text}")
            },
            onToolCall = {
                val id = when (it) {
                    is SessionUpdate.ToolCall -> it.toolCallId.value
                    is SessionUpdate.ToolCallUpdate -> it.toolCallId.value
                    else -> error("unexpected update")
                }
                events.add(
                    if (it is SessionUpdate.ToolCall) "tool:$id" else "tool-update:$id",
                )
            },
            applyCurrentMode = { events.add("mode:$it") },
            updateConfigOptions = { events.add("config:${it.size}") },
            acceptAvailableCommands = { events.add("commands:${it.availableCommands.size}") },
            handleUsageUpdate = { used, size -> events.add("usage:$used:$size") },
            reportOrderingWarning = { warnings.add(it) },
            log = Logger.getInstance(SessionUpdateRouterTest::class.java),
        )

        fun accept(sessionId: String, update: SessionUpdate) {
            router.accept(AcpSessionUpdate(SessionId(sessionId), update))
        }

        fun accept(update: SessionUpdate) {
            accept("session-1", update)
        }

        fun drain() {
            while (scheduled.isNotEmpty()) scheduled.removeAt(0)()
        }
    }

    private fun update(update: SessionUpdate) = update

    private fun agentUpdate(id: String, text: String) = SessionUpdate.AgentMessageChunk(
        content = ContentBlock.Text(text),
        messageId = MessageId(id),
    )

    private fun thoughtUpdate(id: String, text: String) = SessionUpdate.AgentThoughtChunk(
        content = ContentBlock.Text(text),
        messageId = MessageId(id),
    )

    private fun userUpdate(text: String) = SessionUpdate.UserMessageChunk(ContentBlock.Text(text))

    private fun toolCall(id: String) = SessionUpdate.ToolCall(
        toolCallId = ToolCallId(id),
        title = "read",
        kind = ToolKind.READ,
        status = ToolCallStatus.IN_PROGRESS,
    )
}
