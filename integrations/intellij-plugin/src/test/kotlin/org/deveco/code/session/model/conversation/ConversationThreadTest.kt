package org.deveco.code.session.model.conversation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.AbstractApplier
import androidx.compose.runtime.BroadcastFrameClock
import androidx.compose.runtime.ExperimentalComposeApi
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import com.agentclientprotocol.model.SessionUpdate
import com.agentclientprotocol.model.ToolCallId
import com.agentclientprotocol.model.ToolCallStatus
import com.agentclientprotocol.model.ToolKind
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.deveco.code.session.model.interaction.InteractionState
import org.deveco.code.session.model.interaction.PermissionInteraction
import org.deveco.code.session.model.interaction.QuestionInteraction
import org.deveco.code.session.ui.messages.tool.ToolItemTestFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

@OptIn(ExperimentalComposeApi::class)
internal class ConversationThreadTest {
    @Test
    fun `visible user prompts start separate activities`() {
        val thread = ConversationThread("session-1")

        thread.append(user("u1", "first"))
        thread.append(agent("a1", "answer"))
        thread.append(user("u2", "second"))
        thread.append(agent("a2", "answer", AssistantContentState.Streaming))

        assertEquals(2, thread.activities.size)
        assertEquals(listOf("u1"), thread.activities[0].inputs.map { it.id })
        assertEquals(listOf("u2"), thread.activities[1].inputs.map { it.id })
        assertEquals(ActivityState.Finished(ActivityResult.Completed), thread.activities[0].state)
        assertEquals(ActivityState.Running, thread.activities[1].state)
        assertEquals(thread.activities[1].id, thread.activeActivityId)
    }

    @Test
    fun `interaction activity follows the latest activity outside a prompted turn`() {
        val thread = ConversationThread("session-1")

        assertNull(thread.interactionActivityId())

        thread.append(user("u1", "question"))
        assertEquals(thread.activities.single().id, thread.interactionActivityId())
    }

    @Test
    fun `interaction activity is owned by the admitted prompted turn`() {
        val thread = ConversationThread("session-1")
        val admitted = thread.admitTurn(
            ConversationInput.text(id = "USER-1", text = "question", createdAt = 1),
            ready = true,
            memoryLimitReached = false,
        ) as TurnAdmissionResult.Accepted

        assertTrue(thread.isPrompting)
        assertEquals(admitted.activityId, thread.interactionActivityId())
    }

    @Test
    fun `streaming chunks preserve activity and row identity`() {
        val thread = ConversationThread("session-1")
        thread.append(user("u1", "question"))
        thread.append(agent("a1", "hel", AssistantContentState.Streaming))
        val activityBefore = thread.activities.single()
        val itemsBefore = activityBefore.items.toList()
        val groupsBefore = groupMessages(itemsBefore)
        val agentBefore = activityBefore.items.first { it.id == "a1" }

        thread.mutateMessage("a1") {
            (it as? ConversationItem.Assistant.Text)?.appendText("lo")
        }

        val activityAfter = thread.activities.single()
        assertSame(activityBefore, activityAfter)
        assertSame(agentBefore, activityAfter.items.first { it.id == "a1" })
        assertEquals(itemsBefore, activityAfter.items.toList())
        assertEquals(groupsBefore, groupMessages(activityAfter.items.toList()))
        assertEquals("hello", agentBefore.text)
        assertEquals(ActivityState.Running, activityAfter.state)
        assertEquals(1, thread.activities.size)
    }

    @Test
    fun `activity tracks independent response and user interaction liveness`() {
        val thread = ConversationThread("session-1")
        thread.append(user("u1", "question"))
        val activity = thread.activities.single()

        activity.beginResponseWait(100)
        activity.beginUserInteraction(110)
        activity.beginUserInteraction(120)

        assertEquals(120, activity.lastActivityAt)
        assertEquals(2, activity.pendingUserInteractions.get())

        activity.endUserInteraction(130)
        activity.markActivity(140)

        assertEquals(1, activity.pendingUserInteractions.get())
        assertEquals(140, activity.lastActivityAt)

        activity.finish(ActivityResult.Completed, completedAt = 150)

        assertEquals(0, activity.pendingUserInteractions.get())
        assertTrue(activity.completedAt != null)
    }

    @Test
    fun `agent identity cannot be changed by content mutation`() {
        val thread = ConversationThread("session-1")
        val agent = ConversationItem.agent("agent-1", "start", AssistantContentState.Streaming)
        thread.append(agent)

        thread.mutateMessage("agent-1") {
            (it as ConversationItem.Assistant.Text).appendText("-more")
        }

        assertEquals("agent-1", agent.id)
        assertEquals("start-more", agent.text)
        assertEquals("agent-1", thread.activities.single().items.single().id)
    }

    @Test
    fun `read tool conversion replaces only the target item position`() {
        val thread = ConversationThread("session-1")
        val generic = ConversationItem.tool(
            ToolItemTestFactory.create(
                id = "call-1",
                title = "Inspect",
                kind = ToolKind.SEARCH,
                status = ToolCallStatus.IN_PROGRESS,
            ),
        )
        thread.append(generic)
        val activityBefore = thread.activities.single()

        thread.reduceToolUpdate(
            generic.id,
            SessionUpdate.ToolCallUpdate(
                toolCallId = ToolCallId("call-1"),
                kind = ToolKind.READ,
                status = ToolCallStatus.COMPLETED,
                locations = listOf(
                    com.agentclientprotocol.model.ToolCallLocation(path = "/project/Main.kt"),
                ),
                _meta = JsonObject(mapOf("tool_name" to JsonPrimitive("read"))),
            ),
        )

        assertSame(activityBefore, thread.activities.single())
        assertEquals(1, activityBefore.items.size)
        assertTrue(activityBefore.items.single() is ConversationItem.Assistant.ToolItem.Read)
        assertEquals(generic.id, activityBefore.items.single().id)
    }

    @Test
    fun `tool output update does not replace the containing activity or row structure`() {
        val thread = ConversationThread("session-1")
        thread.append(user("u1", "run"))
        thread.append(
            ConversationItem.tool(
                ToolItemTestFactory.create(
                    id = "call-1",
                    title = "Run tests",
                    kind = ToolKind.EXECUTE,
                    status = ToolCallStatus.IN_PROGRESS,
                ),
            ),
        )
        val activityBefore = thread.activities.single()
        val itemsBefore = activityBefore.items.toList()
        val groupsBefore = groupMessages(itemsBefore)
        val toolBefore = activityBefore.items.first { it.id == "tool-call-1" }
        val activitiesBefore = thread.activities.toList()

        thread.reduceToolUpdate(
            "tool-call-1",
            SessionUpdate.ToolCallUpdate(
                toolCallId = ToolCallId("call-1"),
                status = ToolCallStatus.COMPLETED,
            ),
        )

        assertSame(activityBefore, thread.activities.single())
        assertEquals(activitiesBefore, thread.activities.toList())
        assertEquals(itemsBefore, activityBefore.items.toList())
        assertEquals(groupsBefore, groupMessages(activityBefore.items.toList()))
        assertSame(toolBefore, activityBefore.items.first { it.id == "tool-call-1" })
        assertEquals(ToolCallStatus.COMPLETED, toolBefore.toolCall()?.status())
    }

    @Test
    fun `tool output update recomposes only the target item boundary`() = runBlocking {
        val thread = ConversationThread("session-1")
        thread.append(user("u1", "run"))
        thread.append(
            ConversationItem.tool(
                ToolItemTestFactory.create(
                    id = "call-1",
                    title = "First",
                    kind = ToolKind.EXECUTE,
                    status = ToolCallStatus.IN_PROGRESS,
                ),
            ),
        )
        thread.append(
            ConversationItem.tool(
                ToolItemTestFactory.create(
                    id = "call-2",
                    title = "Second",
                    kind = ToolKind.EXECUTE,
                    status = ToolCallStatus.IN_PROGRESS,
                ),
            ),
        )
        val counts = RecompositionCounts()
        val clock = BroadcastFrameClock()
        val recomposer = Recomposer(coroutineContext + clock)
        val pump = launch(coroutineContext + clock, start = CoroutineStart.UNDISPATCHED) {
            recomposer.runRecomposeAndApplyChanges()
        }
        val frames = launch {
            while (isActive) {
                delay(10)
                clock.sendFrame(System.nanoTime())
            }
        }
        val composition = androidx.compose.runtime.Composition(TestApplier(), recomposer, coroutineContext)
        composition.setContent { RecompositionHarness(thread, counts) }
        awaitCount { counts.itemCounts["tool-call-1"] == 1 && counts.itemCounts["tool-call-2"] == 1 }
        val rootBefore = counts.root
        val activityBefore = counts.activity
        val groupBefore = counts.group
        val adjacentBefore = counts.itemCounts.getValue("tool-call-2")

        thread.reduceToolUpdate(
            "tool-call-1",
            SessionUpdate.ToolCallUpdate(
                toolCallId = ToolCallId("call-1"),
                status = ToolCallStatus.COMPLETED,
            ),
        )
        awaitCount { counts.itemCounts["tool-call-1"] == 2 }
        delay(50)

        assertEquals(rootBefore, counts.root)
        assertEquals(activityBefore, counts.activity)
        assertEquals(groupBefore, counts.group)
        assertEquals(adjacentBefore, counts.itemCounts["tool-call-2"])
        composition.dispose()
        pump.cancel()
        frames.cancel()
        recomposer.close()
    }

    @Test
    fun `file edits update only the target edit boundary`() = runBlocking {
        val thread = ConversationThread("session-1")
        thread.append(user("u1", "edit"))
        thread.append(
            ConversationItem.tool(
                ToolItemTestFactory.create(
                    id = "call-1",
                    title = "Edit",
                    kind = ToolKind.EDIT,
                    status = ToolCallStatus.IN_PROGRESS,
                ),
            ),
        )
        val counts = RecompositionCounts()
        val clock = BroadcastFrameClock()
        val recomposer = Recomposer(coroutineContext + clock)
        val pump = launch(coroutineContext + clock, start = CoroutineStart.UNDISPATCHED) {
            recomposer.runRecomposeAndApplyChanges()
        }
        val frames = launch {
            while (isActive) {
                delay(10)
                clock.sendFrame(System.nanoTime())
            }
        }
        val composition = androidx.compose.runtime.Composition(TestApplier(), recomposer, coroutineContext)
        composition.setContent { RecompositionHarness(thread, counts) }
        awaitCount { counts.fileEditCounts["tool-call-1"] == 1 }
        val rootBefore = counts.root
        val activityBefore = counts.activity
        val groupBefore = counts.group
        val contentBefore = counts.itemCounts.getValue("tool-call-1")

        thread.setFileEdits(
            "tool-call-1",
            listOf(org.deveco.code.session.tool.ToolEditTracker.FileEdit("/Main.kt", 2, 1)),
        )
        awaitCount { counts.fileEditCounts["tool-call-1"] == 2 }
        delay(50)

        assertEquals(rootBefore, counts.root)
        assertEquals(activityBefore, counts.activity)
        assertEquals(groupBefore, counts.group)
        assertEquals(contentBefore, counts.itemCounts["tool-call-1"])
        composition.dispose()
        pump.cancel()
        frames.cancel()
        recomposer.close()
    }

    @Test
    fun `assistant updates follow the newly active prompt`() {
        val thread = ConversationThread("session-1")
        thread.append(user("u1", "first"))
        thread.append(agent("a1", "first answer"))
        thread.append(user("u2", "second"))

        thread.append(agent("a2", "second answer", AssistantContentState.Streaming))

        assertEquals(
            listOf("a1"),
            thread.activities[0].items.filterIsInstance<ConversationItem.Assistant.Text>().map { it.id },
        )
        assertEquals(
            listOf("a2"),
            thread.activities[1].items.filterIsInstance<ConversationItem.Assistant.Text>().map { it.id },
        )
    }

    @Test
    fun `steer input joins the active activity`() {
        val thread = ConversationThread("session-1")
        thread.append(user("u1", "first"))

        thread.append(user("u2", "steer"), PromptDelivery.STEER)
        thread.append(agent("a1", "continued"))

        assertEquals(1, thread.activities.size)
        assertEquals(listOf("u1", "u2"), thread.activities.single().inputs.map { it.id })
        assertEquals(PromptDelivery.STEER, thread.activities.single().inputs.last().delivery)
    }

    @Test
    fun `queued input waits in the thread and starts a later activity when promoted`() {
        val thread = ConversationThread("session-1")
        thread.append(user("u1", "first"))
        thread.append(agent("a1", "first answer"))
        val queued = input("u2", "next", delivery = PromptDelivery.QUEUE)
        thread.queueInput(queued)

        assertEquals(listOf("u2"), thread.pendingPrompts.map { it.id })
        assertTrue(thread.promoteQueuedInput("u2", user("u2", "next")))

        assertTrue(thread.pendingPrompts.isEmpty())
        assertEquals(2, thread.activities.size)
        assertEquals(PromptDelivery.QUEUE, thread.activities.last().inputs.single().delivery)
    }

    @Test
    fun `internal user message does not start a new activity`() {
        val thread = ConversationThread("session-1")

        thread.append(user("u1", "visible"))
        thread.append(user("u2", "background notification", internalOnly = true))
        thread.append(agent("a1", "answer"))

        assertEquals(1, thread.activities.size)
        assertEquals(listOf("u1"), thread.activities.single().inputs.map { it.id })
        assertEquals(3, thread.activities.single().items.size)
    }

    @Test
    fun `interruption and failure map to terminal activity results`() {
        val interrupted = ConversationThread("interrupted")
        interrupted.append(user("u1", "question"))
        interrupted.append(agent("a1", "partial", AssistantContentState.Streaming))
        interrupted.mutateMessage("a1") {
            (it as? ConversationItem.Assistant.Text)
                ?.setState(AssistantContentState.Interrupted("cancelled"))
        }

        val failed = ConversationThread("failed")
        failed.append(user("u1", "question"))
        failed.append(agent("a1", "failed", AssistantContentState.Failed("request failed")))

        val cancelledResult =
            (interrupted.activities.single().state as ActivityState.Finished).result as ActivityResult.Cancelled
        assertEquals("cancelled", cancelledResult.error?.message)
        val failedResult =
            (failed.activities.single().state as ActivityState.Finished).result as ActivityResult.Failed
        assertEquals("request failed", failedResult.error.message)
    }

    @Test
    fun `thought and tool items can be the final activity state`() {
        val thought = ConversationThread("thought").apply {
            append(user("u1", "question"))
            append(ConversationItem.thought("t1", "reasoning", AssistantContentState.Streaming))
            mutateMessage("t1") {
                (it as ConversationItem.Assistant.Thought).setState(AssistantContentState.Completed)
            }
        }
        assertEquals(ActivityState.Finished(ActivityResult.Completed), thought.activities.single().state)

        val tool = ConversationThread("tool").apply {
            append(user("u1", "question"))
            append(
                ConversationItem.tool(
                    ToolItemTestFactory.create(status = ToolCallStatus.IN_PROGRESS),
                ),
            )
        }
        assertEquals(ActivityState.Running, tool.activities.single().state)
        tool.finishActivity(tool.activities.single().id, ActivityResult.Cancelled())
        assertEquals(ActivityState.Finished(ActivityResult.Cancelled()), tool.activities.single().state)
    }

    @Test
    fun `failed tool does not fail activity and model can continue successfully`() {
        val thread = ConversationThread("session-1").apply {
            append(user("u1", "question"))
            append(
                ConversationItem.tool(
                    ToolItemTestFactory.create(status = ToolCallStatus.FAILED),
                ),
            )
        }
        assertEquals(ActivityState.Running, thread.activities.single().state)

        thread.append(agent("a1", "recovered"))

        assertEquals(ActivityState.Finished(ActivityResult.Completed), thread.activities.single().state)
    }

    @Test
    fun `display status matches develop turn footer semantics`() {
        assertEquals(null, ActivityState.Running.displayStatusCode())
        assertEquals(null, ActivityState.Stopping.displayStatusCode())
        assertEquals(null, ActivityState.Finished(ActivityResult.Completed).displayStatusCode())
        assertEquals("stopped", ActivityState.Finished(ActivityResult.Cancelled()).displayStatusCode())
        assertEquals(
            "failed",
            ActivityState.Finished(ActivityResult.Failed(ActivityError(message = "failed"))).displayStatusCode(),
        )
        IncompleteReason.entries.forEach { reason ->
            assertEquals(
                "failed",
                ActivityState.Finished(ActivityResult.Incomplete(reason)).displayStatusCode(),
            )
        }
        assertEquals(null, ActivityState.Finished(ActivityResult.Unknown).displayStatusCode())
    }

    @Test
    fun `released stop returns activity to running before terminal callback`() {
        val thread = ConversationThread("session-1").apply {
            append(user("u1", "question"))
            append(agent("a1", "partial", AssistantContentState.Streaming))
        }
        thread.markActiveActivityStopping()
        assertEquals(ActivityState.Stopping, thread.activities.single().state)

        thread.releaseActiveActivityStopping()

        assertEquals(ActivityState.Running, thread.activities.single().state)
    }

    @Test
    fun `later terminal item state replaces a prior finished result`() {
        val thread = ConversationThread("session-1")
        thread.append(user("u1", "question"))
        thread.append(agent("a1", "partial", AssistantContentState.Streaming))
        val activityId = thread.activities.single().id
        thread.finishActivity(activityId, ActivityResult.Incomplete(IncompleteReason.MAX_TOKENS))

        thread.mutateMessage("a1") {
            (it as? ConversationItem.Assistant.Text)?.setState(AssistantContentState.Interrupted("cancelled"))
        }

        assertEquals(
            ActivityState.Finished(ActivityResult.Cancelled(ActivityError(message = "cancelled"))),
            thread.activities.single().state,
        )
    }

    @Test
    fun `replay rebuilds boundaries and terminal results`() {
        val thread = ConversationThread("session-1")
        thread.restore(
            listOf(
                user("u1", "visible"),
                user("u2", "background", internalOnly = true),
                agent("a1", "answer"),
                newTurnBoundary("TURN-u3"),
                agent("a2", "subtask answer"),
            ),
        )
        thread.finalizeRestoredActivities()

        assertEquals(2, thread.activities.size)
        assertEquals(listOf("u1"), thread.activities[0].inputs.map { it.id })
        assertTrue(thread.activities[0].items[1] is ConversationItem.User)
        assertTrue(
            thread.activities[1].items.first().let {
                (it as ConversationItem.System).turnBoundary
            },
        )
        assertEquals(ActivityState.Finished(ActivityResult.Completed), thread.activities[1].state)
        assertEquals(thread.activities[1].id, thread.activeActivityId)
    }

    @Test
    fun `clear resets all conversation-owned state`() {
        val thread = ConversationThread("session-1")
        thread.append(user("u1", "question"))
        thread.queueInput(input("u2", "queued", delivery = PromptDelivery.QUEUE))
        thread.addPermissionInteraction(
            PermissionInteraction(
                id = "permission-1",
                state = InteractionState.PENDING,
                title = "Permission",
                message = "Allow",
                options = emptyList(),
            ),
        )
        thread.addQuestionInteraction(
            QuestionInteraction(
                id = "question-2",
                state = InteractionState.PENDING,
                title = "Question",
                message = "Choose",
                fields = emptyList(),
                selections = mutableStateMapOf(),
            ),
        )
        thread.addSubagent(
            SubagentLink(
                id = "subagent-1",
                parentActivityId = thread.activities.single().id,
                anchorItemId = "tool-task-1",
                childThreadId = "child-session",
                mode = SubagentMode.BACKGROUND,
            ),
        )

        thread.clear()

        assertTrue(thread.activities.isEmpty())
        assertTrue(thread.pendingPrompts.isEmpty())
        assertTrue(thread.permissionInteractions.isEmpty())
        assertTrue(thread.questionInteractions.isEmpty())
        assertTrue(thread.subagents.isEmpty())
        assertNull(thread.activeActivityId)
    }

    @Test
    fun `subagent and interaction state remain independently observable`() {
        val thread = ConversationThread("session-1")
        thread.append(user("u1", "delegate"))
        val link = SubagentLink(
            id = "subagent-1",
            parentActivityId = thread.activities.single().id,
            anchorItemId = "tool-task-1",
            childThreadId = "child-session",
            mode = SubagentMode.BACKGROUND,
        )
        thread.addSubagent(link)
        thread.addPermissionInteraction(
            PermissionInteraction(
                id = "permission-1",
                state = InteractionState.PENDING,
                title = "Permission",
                message = "Allow",
                options = emptyList(),
                activityId = link.parentActivityId,
            ),
        )

        thread.updatePermissionInteraction("permission-1") { it.copy(state = InteractionState.ACCEPTED) }

        assertEquals("child-session", thread.subagents.values.single().childThreadId)
        assertEquals(InteractionState.ACCEPTED, thread.permissionInteractions.values.single().state)
        assertTrue(thread.questionInteractions.isEmpty())
        assertFalse(thread.items().isEmpty())
    }

    @Test
    fun `item index follows move removal replacement and restore`() {
        val thread = ConversationThread("session-1")
        thread.append(user("u1", "first"))
        thread.append(agent("a1", "answer"))
        thread.append(agent("a2", "later"))

        assertTrue(thread.moveMessageToEnd("a1"))
        assertEquals("a2", thread.items()[1].id)
        assertEquals("a1", thread.items()[2].id)
        assertEquals("a1", thread.message("a1")?.id)

        thread.replaceMessageAt("a2", agent("a2", "replaced"))
        assertEquals("replaced", thread.message("a2")?.text)

        thread.removeMessage("a1")
        assertNull(thread.message("a1"))
        assertEquals("a2", thread.message("a2")?.id)

        thread.restore(listOf(user("u2", "restored"), agent("a3", "answer")))
        assertEquals("restored", thread.message("u2")?.text)
        assertEquals("answer", thread.message("a3")?.text)
        assertNull(thread.message("a2"))
    }

    @Test
    fun `user upsert reuses the replay message identity`() {
        val thread = ConversationThread("session-1")
        val first = ConversationInput.text(id = "USER-1", text = "first", createdAt = 1)
        val second = ConversationInput.text(id = "USER-1", text = "first second", createdAt = 2)

        thread.upsertUser(first)
        thread.upsertUser(second)

        assertEquals(1, thread.activities.size)
        assertEquals("first second", thread.message("USER-1")?.text)
        assertEquals(2L, thread.message("USER-1")?.createdAt)
    }

    @Test
    fun `turn admission is owned by the thread`() {
        val thread = ConversationThread("session-1")
        val input = ConversationInput.text(id = "USER-1", text = "hello", createdAt = 1)

        assertEquals(
            TurnRejectionReason.SESSION_NOT_READY,
            (thread.admitTurn(
                input,
                ready = false,
                memoryLimitReached = false,
            ) as TurnAdmissionResult.Rejected)
                .reason,
        )
        assertEquals(
            TurnRejectionReason.CONTEXT_LIMIT_REACHED,
            (thread.admitTurn(
                input,
                ready = true,
                memoryLimitReached = true,
            ) as TurnAdmissionResult.Rejected)
                .reason,
        )
        assertEquals(0, thread.sendTick)

        val admitted = thread.admitTurn(input, ready = true, memoryLimitReached = false)
            as TurnAdmissionResult.Accepted
        assertEquals(0, admitted.visibleUserTurnOrdinal)
        assertEquals("USER-1", thread.activity(admitted.activityId)?.userAnchorId)
        assertEquals(admitted.activityId, thread.activeActivityId)
        assertTrue(thread.isFirstUserActivity(admitted.activityId))
        assertTrue(thread.isPrompting)
        assertEquals(1, thread.sendTick)
        assertEquals(
            TurnRejectionReason.TURN_IN_PROGRESS,
            (thread.admitTurn(
                ConversationInput.text(id = "USER-2", text = "later", createdAt = 2),
                ready = true,
                memoryLimitReached = false,
            ) as TurnAdmissionResult.Rejected).reason,
        )
        assertEquals(1, thread.sendTick)
    }

    @Test
    fun `internal-only admission keeps an anchor without visible user content`() {
        val thread = ConversationThread("session-1")
        val firstVisible = thread.admitTurn(
            ConversationInput.text(id = "USER-visible", text = "hello", createdAt = 1),
            ready = true,
            memoryLimitReached = false,
        ) as TurnAdmissionResult.Accepted
        assertEquals(0, firstVisible.visibleUserTurnOrdinal)
        thread.settleTurn(firstVisible.activityId, ActivityResult.Completed, stopped = false)

        val admitted = thread.admitTurn(
            ConversationInput.text(id = "USER-hidden", text = "/review", createdAt = 1),
            ready = true,
            memoryLimitReached = false,
            internalOnly = true,
        ) as TurnAdmissionResult.Accepted
        val activity = requireNotNull(thread.activity(admitted.activityId))

        assertEquals("USER-hidden", activity.userAnchorId)
        assertTrue(activity.inputs.isEmpty())
        assertTrue((activity.items.single() as ConversationItem.User).internalOnly)
        assertEquals(null, admitted.visibleUserTurnOrdinal)
        assertEquals(null, thread.visibleUserTurnOrdinal(admitted.activityId))
        assertFalse(thread.isFirstUserActivity(admitted.activityId))
        assertTrue(thread.isPrompting)
        thread.settleTurn(admitted.activityId, ActivityResult.Cancelled(), stopped = true)

        val nextVisible = thread.admitTurn(
            ConversationInput.text(id = "USER-next", text = "next", createdAt = 2),
            ready = true,
            memoryLimitReached = false,
        ) as TurnAdmissionResult.Accepted
        assertEquals(1, nextVisible.visibleUserTurnOrdinal)
    }

    @Test
    fun `successful admission completes a lingering streaming thought`() {
        val thread = ConversationThread("session-1")
        thread.append(user("u1", "first"))
        val thought = thread.appendThoughtChunk(messageId = null, chunk = "thinking").first
        assertTrue(thought.state is AssistantContentState.Streaming)

        thread.admitTurn(
            ConversationInput.text(id = "USER-2", text = "next", createdAt = 2),
            ready = true,
            memoryLimitReached = false,
        )

        assertTrue(thought.state is AssistantContentState.Completed)
    }

    @Test
    fun `rejected admission leaves a streaming thought unchanged`() {
        val thread = ConversationThread("session-1")
        thread.append(user("u1", "first"))
        val thought = thread.appendThoughtChunk(messageId = null, chunk = "thinking").first

        val result = thread.admitTurn(
            ConversationInput.text(id = "USER-2", text = "next", createdAt = 2),
            ready = false,
            memoryLimitReached = false,
        )

        assertTrue(result is TurnAdmissionResult.Rejected)
        assertTrue(thought.state is AssistantContentState.Streaming)
    }

    @Test
    fun `only the active turn generation can settle`() {
        val thread = ConversationThread("session-1")
        val first = thread.admitTurn(
            ConversationInput.text(id = "USER-1", text = "first", createdAt = 1),
            ready = true,
            memoryLimitReached = false,
        ) as TurnAdmissionResult.Accepted

        assertTrue(thread.settleTurn(first.activityId, ActivityResult.Completed, stopped = false))
        assertFalse(thread.isPrompting)
        assertFalse(thread.settleTurn(first.activityId, ActivityResult.Failed(ActivityError("late")), stopped = false))
        assertTrue(thread.isCurrentTurnRecovery(first.activityId))

        thread.invalidateTurn()
        assertFalse(thread.isCurrentTurnRecovery(first.activityId))
        val second = thread.admitTurn(
            ConversationInput.text(id = "USER-2", text = "second", createdAt = 2),
            ready = true,
            memoryLimitReached = false,
        ) as TurnAdmissionResult.Accepted
        assertEquals(1, second.visibleUserTurnOrdinal)
        assertFalse(thread.isCurrentTurn(first.activityId))
        assertTrue(thread.isCurrentTurn(second.activityId))
    }

    private fun user(id: String, text: String, internalOnly: Boolean = false) = ConversationItem.user(
        id = id,
        text = text,
        internalOnly = internalOnly,
    )

    private fun input(id: String, text: String, delivery: PromptDelivery) = ConversationInput.fromPrompt(
        id = id,
        prompt = org.deveco.code.session.model.prompt.Prompt(
            listOf(org.deveco.code.session.model.prompt.PromptPart.Text(text)),
        ),
        delivery = delivery,
        createdAt = 1,
    )

    private fun agent(id: String, text: String, state: AssistantContentState = AssistantContentState.Completed) =
        ConversationItem.agent(id = id, text = text, state = state)
}

private class RecompositionCounts {
    var root: Int = 0
    var activity: Int = 0
    var group: Int = 0
    val itemCounts = mutableMapOf<String, Int>()
    val fileEditCounts = mutableMapOf<String, Int>()
}

private class TestApplier : AbstractApplier<Unit>(Unit) {
    override fun insertTopDown(index: Int, instance: Unit) = Unit

    override fun insertBottomUp(index: Int, instance: Unit) = Unit

    override fun remove(index: Int, count: Int) = Unit

    override fun move(from: Int, to: Int, count: Int) = Unit

    override fun onClear() = Unit
}

@Composable
private fun RecompositionHarness(thread: ConversationThread, counts: RecompositionCounts) {
    SideEffect { counts.root++ }
    thread.activities.toList().forEach { activity ->
        key(activity.id) {
            SideEffect { counts.activity++ }
            val groups by remember(activity) {
                derivedStateOf {
                    groupMessages(activity.items.toList())
                        .filterNot { (it.parent as? ConversationItem.System)?.turnBoundary == true }
                }
            }
            groups.forEach { group ->
                key(group.parent.id) {
                    SideEffect { counts.group++ }
                    ItemContentBoundary(group.parent, counts)
                    group.children.forEach { child ->
                        ItemContentBoundary(child, counts)
                    }
                }
            }
        }
    }
}

@Composable
private fun ItemContentBoundary(item: ConversationItem, counts: RecompositionCounts) {
    SideEffect { counts.itemCounts[item.id] = counts.itemCounts.getOrDefault(item.id, 0) + 1 }
    item.text
    FileEditBoundary(item, counts)
}

@Composable
private fun FileEditBoundary(item: ConversationItem, counts: RecompositionCounts) {
    SideEffect { counts.fileEditCounts[item.id] = counts.fileEditCounts.getOrDefault(item.id, 0) + 1 }
    (item as? ConversationItem.Assistant.ToolItem.FileMutation)?.fileEdits?.size
}

private suspend fun awaitCount(predicate: () -> Boolean) {
    withTimeout(2_000) {
        while (!predicate()) delay(10)
    }
}
