package org.deveco.code.session.model

import com.agentclientprotocol.model.ToolCallStatus
import com.agentclientprotocol.model.ToolKind
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import org.deveco.code.MyMessageBundle
import org.deveco.code.acp.AcpToolInputParser
import org.deveco.code.acp.DevEcoHttpApi

internal const val SNAPSHOT_SYSTEM_ID_PREFIX = "SNAPSHOT-SYSTEM-"
internal const val PROVISIONAL_ERROR_ID_PREFIX = "PROVISIONAL-ERROR-"

/**
 * Projects the backend's durable message snapshot into the same [ChatItem] model used by the
 * ACP live stream. The snapshot owns final text, tool status, errors and completion times;
 * loaders may provide already-restored user-attachment metadata by ordinal.
 */
internal fun renderSessionSnapshot(
    snapshot: List<DevEcoHttpApi.SessionMessageTime>,
    localUsers: List<ChatItem> = emptyList(),
    originalTexts: Map<Int, String> = emptyMap(),
    fileReferences: Map<Int, List<FileReference>> = emptyMap(),
    attachments: Map<Int, List<AttachmentItem>> = emptyMap(),
    previousItems: List<ChatItem> = emptyList(),
): List<ChatItem> {
    val ordered = orderSnapshotMessages(snapshot)
    val serverVisibleUserCount = ordered.count { it.hasVisibleUserParts() }
    val alignedLocalUsers = localUsers
        .filterNot { it.internalOnly }
        .take(serverVisibleUserCount)
    val previousById = previousItems.associateBy { it.id }
    var visibleUserOrdinal = -1

    return ordered.flatMap { message ->
        when (message.role) {
            "user" -> {
                val ordinal = if (message.hasVisibleUserParts()) ++visibleUserOrdinal else null
                // Subtask and /debug turns own no visible USER bubble live or on
                // replay, yet their turns still delimit copy/footer attribution;
                // without this boundary a subtask answer copies together with the
                // preceding normal turn. Replay keys the same invisible boundary as
                // TURN-<server user id> (insertSubtaskTurnBoundaries), so ids dedupe
                // across the live→snapshot handover.
                val marker = if (message.isTurnMarkerUser()) {
                    listOf(newTurnBoundary("TURN-${message.id}"))
                } else {
                    emptyList()
                }
                marker + renderUserSnapshot(
                    message,
                    ordinal,
                    ordinal?.let(alignedLocalUsers::getOrNull),
                    originalTexts,
                    fileReferences,
                    attachments,
                )
            }

            "assistant" -> renderAssistantSnapshot(message, previousById)

            else -> renderSystemSnapshot(message)
        }
    }
}

/**
 * True for the user-message shapes that render as an invisible turn marker instead
 * of a bubble: subtask-part-only commands and /debug turns (both the marker-only
 * status|clear shape and sticky enter, whose synthetic text replays internal-only).
 * Mirrors [hasVisibleUserParts] semantics: derived from parts, not parser flags, so
 * the projection stays self-contained. Compaction-part-only messages are excluded —
 * their marker is the visible divider rendered by [renderSystemParts].
 */
private fun DevEcoHttpApi.SessionMessageTime.isTurnMarkerUser(): Boolean {
    val hasSubtask = parts.any { it.type == "subtask" } && !hasVisibleUserParts()
    val hasDebugState = parts.any { it.type == "debug-state" }
    return hasSubtask || hasDebugState
}

/**
 * Assistant messages are attached to the user message in [parentID]. The backend can persist
 * an assistant after later user prompts, so rendered turn order must follow parentID rather than
 * raw creation order.
 */
private fun orderSnapshotMessages(
    messages: List<DevEcoHttpApi.SessionMessageTime>,
): List<DevEcoHttpApi.SessionMessageTime> {
    val byTime = compareBy<DevEcoHttpApi.SessionMessageTime>({ it.createdAt }, { it.id })
    val users = messages.filter { it.role == "user" }.sortedWith(byTime)
    val children = messages.filter { it.role != "user" && it.parentID != null }.groupBy { it.parentID!! }
    val emitted = mutableSetOf<String>()

    val result = buildList {
        for (user in users) {
            add(user)
            emitted += user.id
            children[user.id].orEmpty().sortedWith(byTime).forEach { child ->
                add(child)
                emitted += child.id
            }
        }
        addAll(messages.filter { it.id !in emitted }.sortedWith(byTime))
    }
    return result
}

private fun renderUserSnapshot(
    message: DevEcoHttpApi.SessionMessageTime,
    ordinal: Int?,
    localUser: ChatItem?,
    originalTexts: Map<Int, String>,
    fileReferences: Map<Int, List<FileReference>>,
    attachments: Map<Int, List<AttachmentItem>>,
): List<ChatItem> {
    val visibleText = message.parts
        .filter { it.type == "text" && !it.data.bool("ignored") && !it.data.bool("synthetic") }
        .mapNotNull { it.data.str("text") }
        .filter { it.isNotBlank() }
        .joinToString("\n\n")
    val internalText = if (ordinal == null) {
        message.parts
            .filter { it.type == "text" && !it.data.bool("ignored") }
            .mapNotNull { it.data.str("text") }
            .filter { it.isNotBlank() }
            .joinToString("\n\n")
    } else {
        ""
    }
    val displayText = ordinal?.let {
        originalTexts[it] ?: localUser?.text ?: visibleText
    } ?: internalText
    val userAttachments = ordinal?.let { attachments[it] } ?: localUser?.attachments.orEmpty()
    val userFileReferences = ordinal?.let { fileReferences[it] } ?: localUser?.fileReferences.orEmpty()
    val user = if (displayText.isNotBlank() || userAttachments.isNotEmpty() || userFileReferences.isNotEmpty()) {
        listOf(
            ChatItem(
                id = if (ordinal != null && localUser != null) localUser.id else "USER-${message.id}",
                role = ChatRole.USER,
                title = MyMessageBundle.message("session.message.you"),
                text = displayText,
                attachments = userAttachments,
                fileReferences = userFileReferences,
                internalOnly = ordinal == null,
                createdAt = message.createdAt,
                completedAt = message.completedAt ?: 0L,
                sourceMessageId = message.id,
            ),
        )
    } else {
        emptyList()
    }
    return user + renderSystemParts(message.parts, message.id, message.createdAt)
}

private fun renderAssistantSnapshot(
    message: DevEcoHttpApi.SessionMessageTime,
    previousById: Map<String, ChatItem>,
): List<ChatItem> {
    val aborted = message.errorName == "MessageAbortedError"
    val errorText = when {
        aborted -> null
        message.errorMessage != null -> message.errorMessage
        message.errorName != null -> message.errorName
        else -> null
    }
    val primaryTextPartId = message.parts.firstOrNull {
        it.type == "text" && !it.data.bool("ignored") && !it.data.str("text").isNullOrBlank()
    }?.id
    val primaryReasoningPartId = message.parts.firstOrNull {
        it.type == "reasoning" && !it.data.str("text").isNullOrBlank()
    }?.id
    val duration = message.completedAt?.let { (it - message.createdAt).coerceAtLeast(0L) } ?: 0L
    val items = message.parts.flatMap { part ->
        when (part.type) {
            "text" -> part.data.str("text")
                ?.takeIf { it.isNotBlank() && !part.data.bool("ignored") }
                ?.let { text ->
                    listOf(
                        ChatItem(
                            id = if (part.id == primaryTextPartId) {
                                message.id
                            } else {
                                "agent-${message.id}-${part.id}"
                            },
                            role = ChatRole.AGENT,
                            title = MyMessageBundle.message("session.message.agent"),
                            text = text,
                            isComplete = message.completedAt != null,
                            createdAt = message.createdAt,
                            completedAt = message.completedAt ?: 0L,
                            sourceMessageId = message.id,
                        ),
                    )
                }
                .orEmpty()

            "reasoning" -> part.data.str("text")
                ?.takeIf { it.isNotBlank() }
                ?.let { text ->
                    listOf(
                        ChatItem(
                            id = if (part.id == primaryReasoningPartId) {
                                "thought-${message.id}"
                            } else {
                                "thought-${message.id}-${part.id}"
                            },
                            role = ChatRole.THOUGHT,
                            title = "Thought",
                            text = text,
                            createdAt = message.createdAt,
                            completedAt = message.completedAt ?: 0L,
                            sourceMessageId = message.id,
                        ),
                    )
                }
                .orEmpty()

            "tool" -> listOfNotNull(renderToolPart(part, previousById, message.id))
            else -> renderSystemParts(listOf(part), message.id, message.createdAt)
        }
    }
    val lastAgentIndex = items.indexOfLast { it.role == ChatRole.AGENT }
    val terminalItems = if (lastAgentIndex < 0) {
        items
    } else {
        items.mapIndexed { index, item ->
            if (index != lastAgentIndex) return@mapIndexed item
            item.copy(
                interrupted = aborted,
                errorText = errorText,
                duration = duration,
            )
        }
    }
    if (lastAgentIndex >= 0 || (!aborted && errorText == null)) {
        return terminalItems
    }
    return terminalItems + ChatItem(
        id = message.id,
        role = ChatRole.AGENT,
        title = MyMessageBundle.message("session.message.agent"),
        text = "",
        isComplete = message.completedAt != null,
        interrupted = aborted,
        errorText = errorText,
        duration = duration,
        createdAt = message.createdAt,
        completedAt = message.completedAt ?: 0L,
        sourceMessageId = message.id,
    )
}

internal fun DevEcoHttpApi.SessionMessageTime.hasVisibleUserParts(): Boolean =
    role == "user" && parts.any { part ->
        (part.type == "text" || part.type == "file") &&
            !part.data.bool("synthetic") &&
            !part.data.bool("ignored")
    }

/**
 * Reinserts local-only rows at the position they occupied before a snapshot replaced
 * the server-backed portion of the timeline.
 */
internal fun mergeSnapshotItems(
    rendered: List<ChatItem>,
    previousItems: List<ChatItem>,
    localItems: List<ChatItem>,
): List<ChatItem> {
    if (localItems.isEmpty()) return rendered
    val originalIndexById = previousItems.mapIndexed { index, item -> item.id to index }.toMap()
    val merged = rendered.toMutableList()
    localItems
        .filter { item -> merged.none { it.id == item.id } }
        .sortedByDescending { originalIndexById[it.id] ?: Int.MAX_VALUE }
        .forEach { item ->
            val originalIndex = originalIndexById[item.id]
            val anchorAfter = originalIndex?.let { index ->
                previousItems.drop(index + 1).firstOrNull { candidate ->
                    merged.any { it.id == candidate.id }
                }
            }
            val anchorBefore = originalIndex?.let { index ->
                previousItems.take(index).asReversed().firstOrNull { candidate ->
                    merged.any { it.id == candidate.id }
                }
            }
            val insertAt = anchorAfter?.let { anchor ->
                merged.indexOfFirst { it.id == anchor.id }
            } ?: anchorBefore?.let { anchor ->
                merged.indexOfFirst { it.id == anchor.id } + 1
            } ?: merged.size
            merged.add(insertAt, item)
        }
    return merged
}

private fun renderToolPart(
    part: DevEcoHttpApi.SessionPart,
    previousById: Map<String, ChatItem>,
    sourceMessageId: String,
): ChatItem? {
    val callID = part.data.str("callID") ?: return null
    val toolName = part.data.str("tool").orEmpty()
    val state = part.data.obj("state") ?: return null
    val status = when (state.str("status")) {
        "pending" -> ToolCallStatus.PENDING
        "running" -> ToolCallStatus.IN_PROGRESS
        "completed" -> ToolCallStatus.COMPLETED
        "error" -> ToolCallStatus.FAILED
        else -> null
    }
    val input = state.obj("input")
    val output = if (toolName.equals("read", ignoreCase = true)) {
        state.obj("metadata")?.obj("display")?.str("text")
            ?: state.str("output")
            ?: state.str("error")
            ?: state.str("raw").orEmpty()
    } else {
        state.str("output") ?: state.str("error") ?: state.str("raw").orEmpty()
    }
    val id = "tool-$callID"
    val previous = previousById[id]
    val title = state.str("title")
        ?: toolName.takeIf { it.isNotBlank() }
        ?: MyMessageBundle.message("session.tool.call")
    val kind = toolKind(toolName)
    val path = AcpToolInputParser.readOutputPath(state)
        ?: AcpToolInputParser.readPath(input)
        ?: previous?.toolPath
    return ChatItem(
        id = id,
        role = ChatRole.TOOL,
        title = title,
        text = output,
        toolKind = kind,
        toolPath = path,
        toolStatus = status,
        toolRawInput = input,
        toolRawOutput = state,
        toolFileEdits = previous?.toolFileEdits.orEmpty(),
        backgroundMerged = previous?.backgroundMerged == true,
        createdAt = state.long("time", "start") ?: 0L,
        completedAt = state.long("time", "end") ?: 0L,
        sourceMessageId = sourceMessageId,
    )
}

private fun renderSystemSnapshot(message: DevEcoHttpApi.SessionMessageTime): List<ChatItem> {
    val text = message.parts
        .filter { it.type == "text" }
        .mapNotNull { it.data.str("text") }
        .filter { it.isNotBlank() }
        .joinToString("\n\n")
        .ifBlank { message.errorMessage ?: message.errorName.orEmpty() }
    return if (text.isBlank()) {
        emptyList()
    } else {
        listOf(
            ChatItem(
                id = "$SNAPSHOT_SYSTEM_ID_PREFIX${message.id}",
                role = ChatRole.SYSTEM,
                title = MyMessageBundle.message("session.message.system"),
                text = text,
                createdAt = message.createdAt,
                completedAt = message.completedAt ?: 0L,
                sourceMessageId = message.id,
            ),
        )
    }
}

private fun renderSystemParts(
    parts: List<DevEcoHttpApi.SessionPart>,
    sourceMessageId: String?,
    messageCreatedAt: Long,
): List<ChatItem> = parts.mapNotNull { part ->
    when (part.type) {
        // TUI parity: a /compact turn renders as the "Compaction" divider that
        // doubles as the turn boundary — the same row live (appendCompactionDividerNow)
        // and replay (withCompactionDividers) draw, keyed TURN-<server user id> so
        // the ids dedupe across the live→snapshot handover. A plain SYSTEM card
        // here would neither divide turns nor match the live marker, and keeping
        // both projections would show the compaction twice after a snapshot apply.
        "compaction" -> ChatItem(
            id = sourceMessageId?.let { "TURN-$it" } ?: "$SNAPSHOT_SYSTEM_ID_PREFIX${part.id}",
            role = ChatRole.SYSTEM,
            title = "",
            text = "",
            turnBoundary = true,
            compactionDivider = true,
            createdAt = part.data.long("time", "created") ?: messageCreatedAt,
            completedAt = part.data.long("time", "completed") ?: 0L,
            sourceMessageId = sourceMessageId,
        )

        "retry" -> {
            val message = part.data.obj("error")?.str("message") ?: return@mapNotNull null
            ChatItem(
                id = "$SNAPSHOT_SYSTEM_ID_PREFIX${part.id}",
                role = ChatRole.SYSTEM,
                title = MyMessageBundle.message("session.retry.title"),
                text = message,
                createdAt = part.data.long("time", "created") ?: 0L,
                sourceMessageId = sourceMessageId,
            )
        }

        else -> null
    }
}

/**
 * Local SYSTEM rows a snapshot apply must reinsert verbatim (send failures,
 * permission prompts, debug marker cards). Turn markers and compaction dividers
 * are excluded: the durable snapshot re-projects them from the persisted
 * subtask/compaction/debug-state user messages, so keeping the live copies would
 * double every marker after a live→snapshot handover.
 */
internal fun snapshotLocalSystemRows(messages: List<ChatItem>): List<ChatItem> = messages.filter {
    it.role == ChatRole.SYSTEM &&
        !it.turnBoundary &&
        !it.compactionDivider &&
        !it.id.startsWith(SNAPSHOT_SYSTEM_ID_PREFIX) &&
        !it.id.startsWith(PROVISIONAL_ERROR_ID_PREFIX)
}

private fun toolKind(name: String): ToolKind = when (name.lowercase()) {
    "bash", "shell" -> ToolKind.EXECUTE
    "webfetch" -> ToolKind.FETCH
    "edit", "apply_patch", "patch", "write" -> ToolKind.EDIT
    "grep", "glob", "context", "context7_resolve_library_id", "context7_get_library_docs" -> ToolKind.SEARCH
    "read" -> ToolKind.READ
    "task" -> ToolKind.THINK
    "move", "rename" -> ToolKind.MOVE
    "delete", "remove" -> ToolKind.DELETE
    else -> ToolKind.OTHER
}

private fun JsonObject.str(key: String): String? = this[key]
    ?.takeIf { it is JsonPrimitive }
    ?.jsonPrimitive
    ?.contentOrNull
    ?.takeIf { it.isNotBlank() }

private fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject

private fun JsonObject.bool(key: String): Boolean =
    (this[key]?.takeIf { it is JsonPrimitive }?.jsonPrimitive?.booleanOrNull == true)

private fun JsonObject.long(vararg path: String): Long? {
    var value: JsonObject = this
    path.dropLast(1).forEach { key ->
        value = value.obj(key) ?: return null
    }
    return (value[path.last()] as? JsonPrimitive)?.jsonPrimitive?.contentOrNull?.toLongOrNull()
}
