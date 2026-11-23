/*
 * Conversation model design
 * -------------------------
 * ConversationThread is one independent conversation (main or subagent) and the only stateful
 * holder for that conversation. Activities have stable identity; item content is stateful one
 * level below them, so streaming and tool output updates do not replace the activity hierarchy.
 * ACP remains the live transport. Protocol adapters map ACP terminal reasons into domain
 * ActivityResult values, and protocol-specific values must not leak into these model types.
 */

package org.deveco.code.session.model.conversation

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.snapshots.SnapshotStateMap
import com.agentclientprotocol.model.SessionUpdate
import com.agentclientprotocol.model.ToolCallStatus
import org.deveco.code.acp.DevEcoHttpApi
import org.deveco.code.session.model.FileReference
import org.deveco.code.session.model.configuration.SessionConfiguration
import org.deveco.code.session.model.interaction.PermissionInteraction
import org.deveco.code.session.model.interaction.QuestionInteraction
import org.deveco.code.session.model.prompt.Prompt
import org.deveco.code.session.model.prompt.PromptPart
import org.deveco.code.session.model.prompt.toFileReferences
import org.deveco.code.session.replay.afterCanonicalResult
import org.deveco.code.session.replay.agentIdsMissingServerTimes
import org.deveco.code.session.replay.borrowedUserCreatedAt
import org.deveco.code.session.replay.canonicalActivityResult
import org.deveco.code.session.replay.lastCompleteAgentToMove
import org.deveco.code.session.replay.latestAssistantMessage
import org.deveco.code.session.replay.parentIdsByLocalItem
import org.deveco.code.session.replay.terminalAssistantMessage
import org.deveco.code.session.replay.visibleServerUserMessages
import org.deveco.code.session.tool.ToolEditTracker
import org.deveco.code.session.usage.TokenUsage
import java.util.concurrent.atomic.AtomicInteger

@Stable
internal class ConversationThread(
    val id: String,
    configuration: SessionConfiguration,
    val parentThreadId: String? = null,
) {
    constructor(id: String, parentThreadId: String? = null) : this(
        id = id,
        configuration = SessionConfiguration(),
        parentThreadId = parentThreadId,
    )

    val activities: SnapshotStateList<ConversationActivity> = mutableStateListOf()
    val pendingPrompts: SnapshotStateList<ConversationInput> = mutableStateListOf()
    val permissionInteractions: SnapshotStateMap<String, PermissionInteraction> = mutableStateMapOf()
    val questionInteractions: SnapshotStateMap<String, QuestionInteraction> = mutableStateMapOf()
    val subagents: SnapshotStateMap<String, SubagentLink> = mutableStateMapOf()
    val tokenUsage = TokenUsage(configuration)

    var sendTick by mutableIntStateOf(0)
        private set

    var activeActivityId: String? by mutableStateOf(null)
        private set

    private val itemLocations = mutableMapOf<String, MessageLocation>()

    @Volatile
    private var terminalErrorHandled = false

    var activeTurnId: String? by mutableStateOf(null)
        private set

    @Volatile
    private var lastTurnId: String? = null

    @Volatile
    var stopRequested: Boolean = false
        private set

    @Volatile
    var isStopped: Boolean = false
        private set

    val isPrompting: Boolean get() = activeTurnId != null

    fun items(): List<ConversationItem> = activities.flatMap { it.items.toList() }

    fun activityForItem(itemId: String): ConversationActivity? = locate(itemId)?.activity

    fun activity(activityId: String): ConversationActivity? = activities.firstOrNull { it.id == activityId }

    fun interactionActivityId(): String? {
        val latest = activities.lastOrNull()?.id
        return if (isPrompting) activeActivityId ?: latest else latest
    }

    fun isFirstUserActivity(activityId: String): Boolean {
        val firstUserActivity = activities.firstOrNull { activity ->
            activity.items.any { it is ConversationItem.User && !it.internalOnly }
        } ?: return false
        return firstUserActivity.id == activityId
    }

    fun visibleUserTurnOrdinal(activityId: String): Int? {
        val userActivities = activities.filter { it.inputs.isNotEmpty() }
        val index = userActivities.indexOfFirst { it.id == activityId }
        return index.takeIf { it >= 0 }
    }

    fun message(itemId: String): ConversationItem? = locate(itemId)?.let { location ->
        location.activity.items.getOrNull(location.itemIndex)
    }

    fun append(message: ConversationItem, delivery: PromptDelivery? = null): ConversationItem = inTransaction {
        appendInternal(message, delivery)
        message
    }

    fun appendUser(
        input: ConversationInput,
        internalOnly: Boolean = false,
        delivery: PromptDelivery? = null,
    ): ConversationItem.User = append(
        ConversationItem.user(input = input, internalOnly = internalOnly),
        delivery,
    ) as ConversationItem.User

    fun appendSystem(title: String, text: String): ConversationItem.System = append(
        ConversationItem.system(
            id = "SYSTEM-${System.nanoTime()}",
            title = title,
            text = text,
        ),
    ) as ConversationItem.System

    fun appendTurnBoundary(id: String = "TURN-${System.nanoTime()}"): ConversationItem.System =
        append(newTurnBoundary(id)) as ConversationItem.System

    fun upsertUser(input: ConversationInput, internalOnly: Boolean = false): ConversationItem.User = inTransaction {
        val existing = message(input.id)
        if (existing is ConversationItem.User) {
            val replacement = ConversationItem.user(input = input, internalOnly = internalOnly)
            replaceMessageAt(input.id, replacement)
            return@inTransaction replacement
        }
        val user = ConversationItem.user(input = input, internalOnly = internalOnly)
        appendInternal(user)
        user
    }

    fun removeTurnAnchor(activityId: String): Boolean = inTransaction {
        val anchorId = activity(activityId)?.userAnchorId ?: return@inTransaction false
        removeMessage(anchorId) != null
    }

    fun queueInput(input: ConversationInput) {
        inTransaction {
            pendingPrompts.removeAll { it.id == input.id }
            pendingPrompts += input
        }
    }

    fun removePendingInput(inputId: String): ConversationInput? = inTransaction {
        val index = pendingPrompts.indexOfFirst { it.id == inputId }
        if (index < 0) null else pendingPrompts.removeAt(index)
    }

    fun promoteQueuedInput(inputId: String, message: ConversationItem.User): Boolean = inTransaction {
        val index = pendingPrompts.indexOfFirst { it.id == inputId }
        if (index < 0) return@inTransaction false
        val input = pendingPrompts.removeAt(index)
        appendInternal(message, input.delivery)
        true
    }

    fun replaceMessage(message: ConversationItem): ConversationItem = inTransaction {
        val location = locate(message.id)
        if (location == null) {
            appendInternal(message)
        } else {
            location.activity.replaceItem(location.itemIndex, message)
            itemLocations[message.id] = location
        }
        message
    }

    fun replaceMessageAt(itemId: String, replacement: ConversationItem): ConversationItem? = inTransaction {
        val location = locate(itemId) ?: return@inTransaction null
        location.activity.replaceItem(location.itemIndex, replacement)
        itemLocations.remove(itemId)
        itemLocations[replacement.id] = location
        replacement
    }

    fun mutateMessage(itemId: String, mutation: (ConversationItem) -> Unit): Boolean = inTransaction {
        val location = locate(itemId) ?: return@inTransaction false
        mutation(location.activity.items[location.itemIndex])
        location.activity.itemMutated(location.itemIndex)
        true
    }

    fun reduceToolUpdate(itemId: String, update: SessionUpdate.ToolCallUpdate): ConversationItem? = inTransaction {
        val location = locate(itemId) ?: return@inTransaction null
        val current = location.activity.items[location.itemIndex]
        val reduced = current.reduceToolUpdate(update)
        location.activity.replaceItem(location.itemIndex, reduced)
        reduced
    }

    fun mergeToolSnapshot(
        itemId: String,
        replacement: ConversationItem.Assistant.ToolItem,
        backgroundMerged: Boolean = replacement.backgroundMerged,
    ): ConversationItem.Assistant.ToolItem? = inTransaction {
        val location = locate(itemId) ?: return@inTransaction null
        val current = location.activity.items[location.itemIndex].toolCall() ?: return@inTransaction null
        val merged = mergeConversationToolItem(current, replacement, backgroundMerged)
        location.activity.replaceItem(location.itemIndex, merged)
        merged
    }

    fun setFileEdits(itemId: String, edits: List<ToolEditTracker.FileEdit>) {
        inTransaction {
            (message(itemId) as? ConversationItem.Assistant.ToolItem.FileMutation)?.setFileEdits(edits)
        }
    }

    fun removeMessage(itemId: String): ConversationItem? = inTransaction {
        val location = locate(itemId) ?: return@inTransaction null
        val activity = location.activity
        val removed = activity.removeItemAt(location.itemIndex)
        itemLocations.remove(itemId)
        reindex(activity)
        if (activity.items.isEmpty()) {
            val activityIndex = activities.indexOfFirst { it === activity }
            activities.removeAt(activityIndex)
            if (activeActivityId == activity.id) {
                activeActivityId = activities.lastOrNull()?.id
            }
        }
        removed
    }

    fun moveMessageToEnd(itemId: String): Boolean = inTransaction {
        val location = locate(itemId) ?: return@inTransaction false
        location.activity.moveItemToEnd(location.itemIndex)
        reindex(location.activity)
        true
    }

    fun admitTurn(
        input: ConversationInput,
        ready: Boolean,
        memoryLimitReached: Boolean,
        internalOnly: Boolean = false,
    ): TurnAdmissionResult = inTransaction {
        if (!ready) {
            return@inTransaction TurnAdmissionResult.Rejected(TurnRejectionReason.SESSION_NOT_READY)
        }
        if (memoryLimitReached) {
            return@inTransaction TurnAdmissionResult.Rejected(TurnRejectionReason.CONTEXT_LIMIT_REACHED)
        }
        if (activeTurnId != null) {
            return@inTransaction TurnAdmissionResult.Rejected(TurnRejectionReason.TURN_IN_PROGRESS)
        }

        finishThought()
        appendInternal(ConversationItem.user(input, internalOnly), forceNewActivity = true)
        val activityId = activeActivityId ?: error("Admitted turn has no activity")
        activeTurnId = activityId
        sendTick++
        lastTurnId = activityId
        stopRequested = false
        isStopped = false
        terminalErrorHandled = false
        TurnAdmissionResult.Accepted(
            activityId = activityId,
            visibleUserTurnOrdinal = visibleUserTurnOrdinal(activityId),
        )
    }

    fun isCurrentTurn(activityId: String): Boolean = activeTurnId == activityId

    fun isCurrentTurnRecovery(activityId: String): Boolean = lastTurnId == activityId

    fun requestStop(): String? = inTransaction {
        val activityId = activeTurnId ?: return@inTransaction null
        stopRequested = true
        activity(activityId)?.markStopping()
        activityId
    }

    fun releaseStop() {
        inTransaction {
            activeTurnId?.let(::activity)?.releaseStopping()
        }
    }

    fun settleTurn(
        activityId: String,
        result: ActivityResult,
        stopped: Boolean,
        completedAt: Long = System.currentTimeMillis(),
    ): Boolean = inTransaction {
        if (!isCurrentTurn(activityId)) return@inTransaction false
        activity(activityId)?.finish(result, completedAt)
        activeTurnId = null
        stopRequested = false
        isStopped = stopped
        true
    }

    fun resetTurnState() {
        activeTurnId = null
        lastTurnId = null
        stopRequested = false
        isStopped = false
        terminalErrorHandled = false
    }

    fun invalidateTurn() {
        activeTurnId = null
        lastTurnId = null
        stopRequested = false
    }

    fun appendAgentChunk(
        id: String,
        chunk: String,
        replayComplete: Boolean,
        isPrompting: Boolean,
        isLoading: Boolean,
    ): Boolean = inTransaction {
        val existing = message(id)
        if (existing == null) {
            if (replayComplete && !isPrompting) {
                val last = items().lastOrNull()
                if (last is ConversationItem.Assistant.Text &&
                    last.text.isEmpty() &&
                    last.errorText == null
                ) {
                    replaceMessageAt(
                        last.id,
                        ConversationItem.agent(
                            id = id,
                            text = chunk,
                            state = AssistantContentState.Completed,
                            createdAt = last.createdAt,
                            completedAt = last.completedAt,
                        ),
                    )
                    return@inTransaction true
                }
                appendInternal(ConversationItem.agent(id = id, text = chunk, state = AssistantContentState.Completed))
                return@inTransaction true
            }
            val lastAgent = items()
                .lastOrNull { it is ConversationItem.Assistant.Text } as? ConversationItem.Assistant.Text
            if (lastAgent?.isComplete == true && !isPrompting && !isLoading) {
                return@inTransaction false
            }
            appendInternal(ConversationItem.agent(id = id, text = chunk, state = AssistantContentState.Streaming))
            return@inTransaction true
        }
        if (existing is ConversationItem.Assistant.Text &&
            existing.isComplete &&
            !replayComplete &&
            !isLoading
        ) {
            return@inTransaction false
        }
        if (existing !is ConversationItem.Assistant.Text) return@inTransaction false
        mutateMessage(existing.id) { (it as ConversationItem.Assistant.Text).appendText(chunk) }
        true
    }

    fun appendThoughtChunk(messageId: String?, chunk: String): Pair<ConversationItem.Assistant.Thought, Boolean> =
        inTransaction {
            val id = messageId?.let { "thought-$it" }
                ?: items().lastOrNull {
                    it is ConversationItem.Assistant.Thought &&
                        it.state is AssistantContentState.Streaming
                }?.id
                ?: "thought-${System.nanoTime()}"
            val existing = message(id)
            if (existing is ConversationItem.Assistant.Thought) {
                mutateMessage(id) {
                    (it as ConversationItem.Assistant.Thought).apply {
                        appendText(chunk)
                        setState(AssistantContentState.Streaming)
                    }
                }
                return@inTransaction existing to false
            }
            val thought = ConversationItem.thought(id, chunk).apply { setExpanded(true) }
            appendInternal(thought)
            thought to true
        }

    fun finishThought(
        state: AssistantContentState = AssistantContentState.Completed,
    ): ConversationItem.Assistant.Thought? = inTransaction {
        val thought = items().lastOrNull {
            it is ConversationItem.Assistant.Thought &&
                it.state is AssistantContentState.Streaming
        } as? ConversationItem.Assistant.Thought ?: return@inTransaction null
        mutateMessage(thought.id) {
            (it as ConversationItem.Assistant.Thought).apply {
                setState(state)
                setExpanded(false)
            }
        }
        thought
    }

    fun completeLastAgentMessage(): Boolean = inTransaction {
        finishThought()
        val agent = items().lastOrNull {
            it is ConversationItem.Assistant.Text && !it.isComplete
        } as? ConversationItem.Assistant.Text ?: return@inTransaction false
        mutateMessage(agent.id) { (it as ConversationItem.Assistant.Text).setState(AssistantContentState.Completed) }
        moveMessageToEnd(agent.id)
        true
    }

    fun markLastAgentInterrupted(): ConversationItem.Assistant.Text? {
        if (terminalErrorHandled) return null
        return inTransaction {
            finishThought(AssistantContentState.Interrupted())
            val agent = items().lastOrNull {
                it is ConversationItem.Assistant.Text && !it.isComplete
            } as? ConversationItem.Assistant.Text ?: return@inTransaction null
            mutateMessage(agent.id) {
                (it as ConversationItem.Assistant.Text).apply {
                    setState(AssistantContentState.Interrupted(this.errorText))
                    updateCompletedAt(System.currentTimeMillis())
                }
            }
            moveMessageToEnd(agent.id)
            agent
        }
    }

    fun markLastAgentWithError(errorText: String): ConversationItem.Assistant.Text? {
        terminalErrorHandled = true
        return inTransaction {
            finishThought(AssistantContentState.Failed(errorText))
            val agent = items().lastOrNull {
                it is ConversationItem.Assistant.Text && !it.isComplete
            } as? ConversationItem.Assistant.Text ?: return@inTransaction null
            mutateMessage(agent.id) {
                (it as ConversationItem.Assistant.Text).apply {
                    setState(AssistantContentState.Failed(errorText))
                    updateCompletedAt(System.currentTimeMillis())
                }
            }
            moveMessageToEnd(agent.id)
            agent
        }
    }

    fun markAgentError(id: String, errorText: String): Boolean {
        terminalErrorHandled = true
        return inTransaction {
            val agent = message(id) as? ConversationItem.Assistant.Text
            if (agent != null) {
                mutateMessage(id) {
                    (it as ConversationItem.Assistant.Text).apply {
                        setState(AssistantContentState.Failed(errorText))
                        updateCompletedAt(System.currentTimeMillis())
                    }
                }
                return@inTransaction true
            }
            activeActivityId?.let { activityId ->
                finishActivity(
                    activityId,
                    ActivityResult.Failed(ActivityError(message = errorText)),
                    completedAt = System.currentTimeMillis(),
                )
            }
            false
        }
    }

    fun turnAgentText(item: ConversationItem): String = collectTurnAgentText(items(), item)

    fun applyToolCall(update: SessionUpdate): ToolChange? = inTransaction {
        val toolCallId = when (update) {
            is SessionUpdate.ToolCall -> update.toolCallId.value
            is SessionUpdate.ToolCallUpdate -> update.toolCallId.value
            else -> error("Expected a tool call update")
        }
        val itemId = "tool-$toolCallId"
        val previous = message(itemId)
        if (previous?.toolCall()?.backgroundMerged == true) return@inTransaction null
        val item = when (update) {
            is SessionUpdate.ToolCall -> ConversationItem.tool(toolItemFrom(update))

            is SessionUpdate.ToolCallUpdate -> previous?.reduceToolUpdate(update)
                ?: ConversationItem.tool(toolItemFrom(update))
        }
        replaceMessage(item)
        val after = item.toolCall() ?: return@inTransaction null
        ToolChange(previous = previous?.toolCall(), current = after)
    }

    fun settleBackgroundTask(
        childSessionId: String,
        completed: Boolean,
        finalText: String?,
    ): ConversationItem.Assistant.ToolItem.Subagent? = inTransaction {
        val itemId = subagents[childSessionId]?.anchorItemId
            ?: items().firstOrNull {
                val subagent = it.toolCall() as? ConversationItem.Assistant.ToolItem.Subagent
                subagent?.backgroundJobId() == childSessionId
            }?.id
            ?: return@inTransaction null
        val subagent = message(itemId)?.toolCall() as? ConversationItem.Assistant.ToolItem.Subagent
            ?: return@inTransaction null
        mutateMessage(itemId) { item ->
            (item as ConversationItem.Assistant.ToolItem.Subagent).apply {
                setBackgroundResult(
                    status = if (completed) ToolCallStatus.COMPLETED else ToolCallStatus.FAILED,
                    body = finalText?.takeIf { fragment -> fragment.isNotBlank() } ?: text,
                )
                setEnvelope(
                    completedAt = System.currentTimeMillis(),
                    backgroundMerged = true,
                )
            }
        }
        subagent
    }

    fun applyReplayMetadata(messages: List<DevEcoHttpApi.SessionMessageTime>): ReplayMetadataResult = inTransaction {
        if (messages.isEmpty()) {
            var completed = 0
            items().forEach { item ->
                if (item is ConversationItem.Assistant.Text && !item.isComplete) {
                    completed++
                    item.setState(AssistantContentState.Completed)
                }
            }
            return@inTransaction ReplayMetadataResult(completed = completed)
        }

        val subtaskUserIds = messages
            .asSequence()
            .filter { it.role == "user" && it.hasSubtaskPart }
            .map { it.id }
            .toSet()
        if (subtaskUserIds.isNotEmpty()) {
            restore(
                insertSubtaskTurnBoundaries(
                    items(),
                    parentIdsByLocalItem(messages),
                    subtaskUserIds,
                ),
                clearMetadata = true,
            )
        }

        val byId = messages.associateBy { it.id }
        val serverUsers = visibleServerUserMessages(messages)
        val userCreatedAtById = borrowedUserCreatedAt(items(), serverUsers)
        val missingAgentIds = agentIdsMissingServerTimes(items(), byId.keys)
        val localUserCount = items().count { it is ConversationItem.User }
        val currentItems = items()
        currentItems.forEach { message ->
            when (message) {
                is ConversationItem.Assistant.Text -> {
                    val server = message.id
                        .takeUnless { it in missingAgentIds }
                        ?.let(byId::getValue)
                    if (server != null) {
                        message.updateCreatedAt(server.createdAt)
                        message.updateCompletedAt(server.completedAt ?: 0L)
                    }
                }

                is ConversationItem.User -> {
                    userCreatedAtById[message.id]?.let { createdAt ->
                        replaceMessageAt(message.id, message.withCreatedAt(createdAt))
                    }
                }

                else -> Unit
            }
        }
        ReplayMetadataResult(
            localUserCount = localUserCount,
            serverUserCount = serverUsers.size,
            missingAgentIds = missingAgentIds,
        )
    }

    fun finishReplay(messages: List<DevEcoHttpApi.SessionMessageTime>): ReplayFinishResult = inTransaction {
        var completed = 0
        items().forEach { item ->
            if (item is ConversationItem.Assistant.Content && !item.isComplete) {
                completed++
            }
            if (item is ConversationItem.Assistant.Thought && item.state is AssistantContentState.Streaming) {
                item.setState(AssistantContentState.Completed)
                item.setExpanded(false)
            }
        }

        var errors = 0
        if (messages.isNotEmpty()) {
            val serverUsers = visibleServerUserMessages(messages)
            var serverUserOrdinal = 0
            activities.toList().forEach { activity ->
                val serverUser = serverUsers.firstOrNull { user ->
                    activity.inputs.any { it.id == user.id }
                } ?: serverUsers.getOrNull(serverUserOrdinal).takeIf { activity.inputs.isNotEmpty() }
                if (activity.inputs.isNotEmpty()) serverUserOrdinal++

                val latest = latestAssistantMessage(messages, serverUser?.id)
                val terminal = terminalAssistantMessage(messages, serverUser?.id)
                val legacy = inferredResult(
                    activity.items.toList(),
                    ActivityResult.Incomplete(IncompleteReason.UNKNOWN),
                )
                val result = when {
                    terminal != null -> canonicalActivityResult(terminal, legacyFallback = legacy)
                    latest != null -> ActivityResult.Incomplete(IncompleteReason.UNKNOWN)
                    else -> canonicalActivityResult(null, legacyFallback = legacy)
                }
                if (result is ActivityResult.Failed) errors++
                val serverMessage = terminal ?: latest
                applyCanonicalTurnResult(
                    activityId = activity.id,
                    result = result,
                    completedAt = serverMessage?.completedAt,
                    serverMessageId = serverMessage?.id,
                )
            }
        }

        items().filterIsInstance<ConversationItem.Assistant.Text>()
            .filterNot { it.isComplete }
            .forEach { it.setState(AssistantContentState.Completed) }
        lastCompleteAgentToMove(items())?.let(::moveMessageToEnd)
        finalizeRestoredActivities()
        ReplayFinishResult(completed = completed, errors = errors)
    }

    fun finishActivity(activityId: String, result: ActivityResult, completedAt: Long? = null) {
        inTransaction {
            activities.firstOrNull { it.id == activityId }?.finish(result, completedAt)
        }
    }

    fun applyCanonicalTurnResult(
        activityId: String,
        result: ActivityResult,
        completedAt: Long?,
        serverMessageId: String? = null,
    ): Boolean = inTransaction {
        if (result is ActivityResult.Unknown || result is ActivityResult.Running) return@inTransaction false
        val activity = activities.firstOrNull { it.id == activityId } ?: return@inTransaction false
        val agent = serverMessageId
            ?.let { id -> activity.items.firstOrNull { it is ConversationItem.Assistant.Text && it.id == id } }
            .let { it as? ConversationItem.Assistant.Text }
            ?: activity.items.asReversed()
                .filterIsInstance<ConversationItem.Assistant.Text>()
                .firstOrNull()
        if (agent != null) {
            agent.setState(agent.state.afterCanonicalResult(result))
            if (completedAt != null) agent.updateCompletedAt(completedAt)
        }
        if (result is ActivityResult.Failed) terminalErrorHandled = true
        activity.finish(result, completedAt)
        true
    }

    fun markActiveActivityStopping() {
        inTransaction {
            activities.firstOrNull { it.id == activeActivityId }?.markStopping()
        }
    }

    fun releaseActiveActivityStopping() {
        inTransaction {
            activities.firstOrNull { it.id == activeActivityId }?.releaseStopping()
        }
    }

    fun finalizeRestoredActivities() {
        inTransaction {
            activities.forEach { activity ->
                if (activity.state !is ActivityState.Finished) {
                    activity.finish(
                        inferredResult(activity.items.toList(), ActivityResult.Incomplete(IncompleteReason.UNKNOWN)),
                    )
                }
            }
        }
    }

    fun permissionInteraction(id: String): PermissionInteraction? = permissionInteractions[id]

    fun addPermissionInteraction(interaction: PermissionInteraction) {
        permissionInteractions[interaction.id] = interaction
    }

    fun updatePermissionInteraction(
        interactionId: String,
        transform: (PermissionInteraction) -> PermissionInteraction,
    ): PermissionInteraction? {
        val current = permissionInteractions[interactionId] ?: return null
        val updated = transform(current)
        permissionInteractions[interactionId] = updated
        return updated
    }

    fun questionInteraction(id: String): QuestionInteraction? = questionInteractions[id]

    fun addQuestionInteraction(interaction: QuestionInteraction) {
        questionInteractions[interaction.id] = interaction
    }

    fun updateQuestionInteraction(
        interactionId: String,
        transform: (QuestionInteraction) -> QuestionInteraction,
    ): QuestionInteraction? {
        val current = questionInteractions[interactionId] ?: return null
        val updated = transform(current)
        questionInteractions[interactionId] = updated
        return updated
    }

    fun addSubagent(subagent: SubagentLink) {
        subagents[subagent.id] = subagent
    }

    fun restore(messages: List<ConversationItem>, clearMetadata: Boolean = false) {
        val restored = groupActivities(messages)
        inTransaction {
            activities.clear()
            activities.addAll(restored)
            rebuildIndexes()
            activeActivityId = restored.lastOrNull()?.id
            activeTurnId = null
            lastTurnId = null
            stopRequested = false
            isStopped = false
            if (clearMetadata) {
                pendingPrompts.clear()
                permissionInteractions.clear()
                questionInteractions.clear()
                subagents.clear()
            }
        }
    }

    fun clear() {
        inTransaction {
            activities.clear()
            pendingPrompts.clear()
            permissionInteractions.clear()
            questionInteractions.clear()
            subagents.clear()
            itemLocations.clear()
            activeActivityId = null
            activeTurnId = null
            lastTurnId = null
            stopRequested = false
            isStopped = false
            terminalErrorHandled = false
        }
    }

    private fun appendInternal(
        message: ConversationItem,
        delivery: PromptDelivery? = null,
        forceNewActivity: Boolean = false,
    ) {
        val active = activities.firstOrNull { it.id == activeActivityId }
        val startsActivity = forceNewActivity || when (message) {
            is ConversationItem.User ->
                !message.internalOnly &&
                    delivery != PromptDelivery.STEER &&
                    active?.isTurnBoundaryOnly() != true

            is ConversationItem.System -> message.turnBoundary

            is ConversationItem.Assistant -> false
        }
        val activityId = when {
            startsActivity -> "activity-${message.id}"
            active != null -> active.id
            else -> "activity-${message.id}"
        }
        val activity = activities.firstOrNull { it.id == activityId } ?: ConversationActivity(activityId).also {
            activities += it
        }
        activity.append(
            message = message,
            input = (message as? ConversationItem.User)
                ?.takeUnless { it.internalOnly }
                ?.input
                ?.let { input -> delivery?.let { input.copy(delivery = it) } ?: input },
        )
        activeActivityId = activityId
        itemLocations[message.id] = MessageLocation(activity, activity.items.lastIndex)
    }

    private fun locate(itemId: String): MessageLocation? {
        val location = itemLocations[itemId] ?: return null
        if (location.activity.items.getOrNull(location.itemIndex)?.id == itemId) return location
        return activities.firstNotNullOfOrNull { activity ->
            activity.items.indexOfFirst { it.id == itemId }
                .takeIf { it >= 0 }
                ?.let { index -> MessageLocation(activity, index).also { itemLocations[itemId] = it } }
        }
    }

    private fun reindex(activity: ConversationActivity) {
        activity.items.forEachIndexed { index, item ->
            itemLocations[item.id] = MessageLocation(activity, index)
        }
    }

    private fun rebuildIndexes() {
        itemLocations.clear()
        activities.forEach(::reindex)
    }

    private inline fun <T> inTransaction(block: () -> T): T = Snapshot.withMutableSnapshot { block() }

    private data class MessageLocation(val activity: ConversationActivity, val itemIndex: Int)

    private fun groupActivities(messages: List<ConversationItem>): List<ConversationActivity> {
        val builders = mutableListOf<ActivityBuilder>()
        var current: ActivityBuilder? = null

        fun startActivity(id: String): ActivityBuilder = ActivityBuilder(id).also {
            builders += it
            current = it
        }

        fun activityFor(message: ConversationItem): ActivityBuilder = current ?: startActivity("activity-${message.id}")

        messages.forEach { message ->
            val target = when (message) {
                is ConversationItem.User -> {
                    if (message.internalOnly) {
                        activityFor(message)
                    } else if (current?.isTurnBoundaryOnly() == true) {
                        current
                    } else {
                        startActivity("activity-${message.id}")
                    }
                }

                is ConversationItem.System -> {
                    if (message.turnBoundary) startActivity("activity-${message.id}") else activityFor(message)
                }

                is ConversationItem.Assistant -> activityFor(message)
            }
            target.add(message)
        }

        return builders.map { it.build() }
    }
}

internal data class ToolChange(
    val previous: ConversationItem.Assistant.ToolItem?,
    val current: ConversationItem.Assistant.ToolItem,
)

internal sealed interface TurnAdmissionResult {
    data class Accepted(val activityId: String, val visibleUserTurnOrdinal: Int?) : TurnAdmissionResult

    data class Rejected(val reason: TurnRejectionReason) : TurnAdmissionResult
}

internal enum class TurnRejectionReason {
    SESSION_NOT_READY,
    CONTEXT_LIMIT_REACHED,
    TURN_IN_PROGRESS,
}

internal data class ReplayMetadataResult(
    val completed: Int = 0,
    val localUserCount: Int = 0,
    val serverUserCount: Int = 0,
    val missingAgentIds: Set<String> = emptySet(),
)

internal data class ReplayFinishResult(val completed: Int, val errors: Int)

@Stable
internal class ConversationActivity(val id: String) {
    val inputs: SnapshotStateList<ConversationInput> = mutableStateListOf()
    val items: SnapshotStateList<ConversationItem> = mutableStateListOf()

    val userAnchorId: String
        get() = items.firstOrNull { it is ConversationItem.User && !it.internalOnly }?.id
            ?: items.firstOrNull { it is ConversationItem.User }?.id
            ?: items.firstOrNull {
                it is ConversationItem.System && it.turnBoundary
            }?.id
            ?: items.firstOrNull()?.id
            ?: id

    var state: ActivityState by mutableStateOf(ActivityState.Running)
        private set

    var startedAt: Long by mutableStateOf(0)
        private set

    var completedAt: Long? by mutableStateOf(null)
        private set

    // Runtime-only watchdog data. Keep these outside Compose state so streaming
    // activity does not schedule an extra recomposition for every update.
    @Volatile
    var lastActivityAt: Long = 0
        private set

    val pendingUserInteractions = AtomicInteger()

    fun isTurnBoundaryOnly(): Boolean =
        inputs.isEmpty() && items.all { it is ConversationItem.System && it.turnBoundary }

    fun containsItem(itemId: String): Boolean = items.any { it.id == itemId }

    internal fun append(message: ConversationItem, input: ConversationInput?) {
        if (input != null) inputs += input
        items += message
        refreshContent()
    }

    internal fun replaceItem(index: Int, message: ConversationItem) {
        val previous = items[index]
        if (previous === message) {
            refreshContent()
            return
        }
        items[index] = message
        if (previous is ConversationItem.User && message is ConversationItem.User) {
            val inputIndex = inputs.indexOfFirst { it.id == previous.id }
            if (inputIndex >= 0) {
                inputs[inputIndex] = message.input.copy(delivery = inputs[inputIndex].delivery)
            }
        }
        refreshContent()
    }

    internal fun itemMutated(index: Int) {
        val message = items[index]
        if (message is ConversationItem.User) {
            val inputIndex = inputs.indexOfFirst { it.id == message.id }
            if (inputIndex >= 0) {
                inputs[inputIndex] = message.input.copy(delivery = inputs[inputIndex].delivery)
            }
        }
        refreshContent()
    }

    internal fun removeItemAt(index: Int): ConversationItem {
        val removed = items.removeAt(index)
        inputs.removeAll { it.id == removed.id }
        refreshContent()
        return removed
    }

    internal fun moveItemToEnd(index: Int) {
        val item = items.removeAt(index)
        items += item
        refreshContent()
    }

    internal fun markStopping() {
        if (state !is ActivityState.Finished) state = ActivityState.Stopping
    }

    internal fun releaseStopping() {
        if (state is ActivityState.Stopping) {
            state = ActivityState.Running
            refreshContent()
        }
    }

    internal fun beginResponseWait(at: Long) {
        lastActivityAt = at
        pendingUserInteractions.set(0)
    }

    internal fun markActivity(at: Long) {
        lastActivityAt = at
    }

    internal fun beginUserInteraction(at: Long) {
        pendingUserInteractions.incrementAndGet()
        lastActivityAt = at
    }

    internal fun endUserInteraction(at: Long) {
        pendingUserInteractions.updateAndGet { maxOf(0, it - 1) }
        lastActivityAt = at
    }

    internal fun finish(result: ActivityResult, completedAt: Long? = null) {
        state = ActivityState.Finished(result)
        pendingUserInteractions.set(0)
        this.completedAt = maxOf(
            this.completedAt ?: 0,
            completedAt ?: 0,
            items.maxOfOrNull { it.completedAt } ?: 0,
            startedAt,
        ).takeIf { it > 0 }
    }

    internal fun restoreContent(inputs: List<ConversationInput>, messages: List<ConversationItem>) {
        this.inputs.clear()
        this.inputs.addAll(inputs)
        this.items.clear()
        this.items.addAll(messages)
        refreshContent()
    }

    private fun refreshContent() {
        val messages = items.toList()
        refreshState(messages)
        startedAt = messages.firstOrNull()?.createdAt
            ?: inputs.firstOrNull()?.createdAt
            ?: startedAt
        completedAt = messages.maxOfOrNull { it.completedAt }?.takeIf { it > 0 } ?: completedAt
    }

    private fun refreshState(messages: List<ConversationItem>) {
        if (state is ActivityState.Stopping) return
        val hasRunningTool = messages.any { item ->
            item is ConversationItem.Assistant.ToolItem &&
                item.status() in setOf(ToolCallStatus.PENDING, ToolCallStatus.IN_PROGRESS)
        }
        val latestContent = messages.asReversed()
            .firstOrNull { it is ConversationItem.Assistant.Content }
            as? ConversationItem.Assistant.Content
        val latestState = latestContent?.state
        state = when {
            hasRunningTool || latestState is AssistantContentState.Streaming -> ActivityState.Running

            latestState is AssistantContentState.Interrupted -> ActivityState.Finished(
                ActivityResult.Cancelled(
                    error = latestState.errorText?.let { ActivityError(message = it) },
                ),
            )

            latestState is AssistantContentState.Failed -> ActivityState.Finished(
                ActivityResult.Failed(ActivityError(message = latestState.errorText)),
            )

            latestState is AssistantContentState.Completed ->
                ActivityState.Finished(ActivityResult.Completed)

            else -> state
        }
    }
}

private fun inferredResult(
    items: List<ConversationItem>,
    emptyResult: ActivityResult = ActivityResult.Running,
): ActivityResult {
    val hasRunningTool = items.any { item ->
        item is ConversationItem.Assistant.ToolItem &&
            item.status() in setOf(ToolCallStatus.PENDING, ToolCallStatus.IN_PROGRESS)
    }
    if (hasRunningTool) return ActivityResult.Running
    val output = items.asReversed()
        .filterIsInstance<ConversationItem.Assistant.Content>()
        .firstOrNull()
        ?: return if (items.any { it is ConversationItem.Assistant.ToolItem }) {
            ActivityResult.Completed
        } else {
            emptyResult
        }
    return when (val state = output.state) {
        AssistantContentState.Streaming -> ActivityResult.Running

        AssistantContentState.Completed -> ActivityResult.Completed

        is AssistantContentState.Interrupted -> ActivityResult.Cancelled(
            error = state.errorText?.let { ActivityError(message = it) },
        )

        is AssistantContentState.Failed -> ActivityResult.Failed(
            ActivityError(message = state.errorText),
        )
    }
}

private class ActivityBuilder(private val id: String) {
    private val messages = mutableListOf<ConversationItem>()

    fun add(message: ConversationItem) {
        messages += message
    }

    fun isTurnBoundaryOnly(): Boolean = messages.all { (it as? ConversationItem.System)?.turnBoundary == true }

    fun build(): ConversationActivity = ConversationActivity(id).also { activity ->
        activity.restoreContent(
            inputs = messages
                .filterIsInstance<ConversationItem.User>()
                .filterNot { it.internalOnly }
                .map { it.input },
            messages = messages,
        )
    }
}

internal data class ConversationInput(
    val id: String,
    val prompt: Prompt,
    val delivery: PromptDelivery? = null,
    val createdAt: Long,
    val admittedSeq: Long? = null,
    val promotedSeq: Long? = null,
) {
    val text: String get() = prompt.text
    val fileReferences: List<FileReference> get() = prompt.toFileReferences()

    companion object {
        fun fromPrompt(
            id: String,
            prompt: Prompt,
            createdAt: Long = System.currentTimeMillis(),
            delivery: PromptDelivery? = null,
            admittedSeq: Long? = null,
            promotedSeq: Long? = null,
        ): ConversationInput = ConversationInput(
            id = id,
            prompt = prompt,
            delivery = delivery,
            createdAt = createdAt,
            admittedSeq = admittedSeq,
            promotedSeq = promotedSeq,
        )

        fun text(
            id: String,
            text: String,
            createdAt: Long = System.currentTimeMillis(),
            delivery: PromptDelivery? = null,
        ): ConversationInput = fromPrompt(
            id = id,
            prompt = Prompt(listOf(PromptPart.Text(text))),
            createdAt = createdAt,
            delivery = delivery,
        )
    }
}

internal enum class PromptDelivery {
    STEER,
    QUEUE,
}

internal sealed interface ActivityState {
    data object Running : ActivityState
    data object Stopping : ActivityState
    data class Finished(val result: ActivityResult) : ActivityState
}

internal fun ActivityState.displayStatusCode(): String? = when (this) {
    ActivityState.Running -> null

    ActivityState.Stopping -> null

    is ActivityState.Finished -> when (result) {
        ActivityResult.Completed -> null

        is ActivityResult.Cancelled -> "stopped"

        is ActivityResult.Failed,
        is ActivityResult.Incomplete,
        -> "failed"

        ActivityResult.Unknown -> null

        ActivityResult.Running -> null
    }
}

internal sealed interface ActivityResult {
    data object Running : ActivityResult

    data object Completed : ActivityResult

    data class Incomplete(val reason: IncompleteReason) : ActivityResult

    data class Cancelled(val error: ActivityError? = null) : ActivityResult

    data class Failed(val error: ActivityError) : ActivityResult

    data object Unknown : ActivityResult
}

internal enum class IncompleteReason {
    MAX_TOKENS,
    MAX_TURN_REQUESTS,
    OUTPUT_LENGTH,
    REFUSED,
    UNKNOWN,
}

internal data class ActivityError(
    val name: String? = null,
    val message: String? = null,
    val type: String? = null,
    val statusCode: Int? = null,
)

internal enum class SubagentMode {
    FOREGROUND,
    BACKGROUND,
}

/**
 * A link between the parent task card and the subagent's independent conversation.
 * The child thread owns its own activities and results; this object must not duplicate them.
 */
internal data class SubagentLink(
    val id: String,
    val parentActivityId: String,
    val anchorItemId: String,
    val childThreadId: String,
    val mode: SubagentMode,
)
