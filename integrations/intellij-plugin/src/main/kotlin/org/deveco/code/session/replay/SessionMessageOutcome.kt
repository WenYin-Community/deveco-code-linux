package org.deveco.code.session.replay

import org.deveco.code.acp.DevEcoHttpApi
import org.deveco.code.session.model.conversation.ActivityError
import org.deveco.code.session.model.conversation.ActivityResult
import org.deveco.code.session.model.conversation.AssistantContentState
import org.deveco.code.session.model.conversation.IncompleteReason

internal fun assistantMessagesForUser(
    messages: List<DevEcoHttpApi.SessionMessageTime>,
    userMessageId: String?,
): List<DevEcoHttpApi.SessionMessageTime> {
    if (userMessageId == null) return emptyList()
    val explicit = messages.filter { it.role == "assistant" && it.parentID == userMessageId }
    if (explicit.isNotEmpty()) return explicit

    val userIndex = messages.indexOfLast { it.id == userMessageId }
    if (userIndex < 0) return emptyList()
    return messages
        .drop(userIndex + 1)
        .takeWhile { it.role != "user" }
        .filter { it.role == "assistant" }
}

internal fun terminalAssistantMessage(
    messages: List<DevEcoHttpApi.SessionMessageTime>,
    userMessageId: String?,
    userTurnOrdinal: Int? = null,
): DevEcoHttpApi.SessionMessageTime? {
    val resolvedUserId = userMessageId ?: userMessageForTurn(messages, null, userTurnOrdinal)?.id
    return assistantMessagesForUser(messages, resolvedUserId).lastOrNull { it.isTerminalAssistant() }
}

internal fun latestAssistantMessage(
    messages: List<DevEcoHttpApi.SessionMessageTime>,
    userMessageId: String?,
    userTurnOrdinal: Int? = null,
): DevEcoHttpApi.SessionMessageTime? {
    val resolvedUserId = userMessageId ?: userMessageForTurn(messages, null, userTurnOrdinal)?.id
    return assistantMessagesForUser(messages, resolvedUserId).lastOrNull()
}

internal fun userMessageForTurn(
    messages: List<DevEcoHttpApi.SessionMessageTime>,
    userMessageId: String?,
    userTurnOrdinal: Int?,
): DevEcoHttpApi.SessionMessageTime? {
    if (userMessageId != null) return messages.firstOrNull { it.id == userMessageId && it.role == "user" }
    return userTurnOrdinal?.let { visibleServerUserMessages(messages).getOrNull(it) }
}

internal fun DevEcoHttpApi.SessionMessageTime.isTerminalAssistant(): Boolean = role == "assistant" &&
    completedAt != null &&
    finish?.lowercase() != "tool-calls" &&
    (finish != null || errorName != null)

/**
 * Persistent HTTP state wins over ACP's terminal stop reason, which wins over legacy content
 * inference. Unknown and still-running results are not fallbacks.
 */
internal fun canonicalActivityResult(
    message: DevEcoHttpApi.SessionMessageTime?,
    acpFallback: ActivityResult = ActivityResult.Unknown,
    legacyFallback: ActivityResult = ActivityResult.Unknown,
): ActivityResult {
    message?.canonicalResult()?.let { return it }
    if (acpFallback !is ActivityResult.Unknown && acpFallback !is ActivityResult.Running) return acpFallback
    if (legacyFallback !is ActivityResult.Unknown && legacyFallback !is ActivityResult.Running) return legacyFallback
    return ActivityResult.Unknown
}

internal fun AssistantContentState.afterCanonicalResult(result: ActivityResult): AssistantContentState = when (result) {
    is ActivityResult.Cancelled -> AssistantContentState.Interrupted()

    is ActivityResult.Failed -> AssistantContentState.Failed(
        result.error.message ?: result.error.name.orEmpty(),
    )

    ActivityResult.Completed,
    is ActivityResult.Incomplete,
    ActivityResult.Running,
    ActivityResult.Unknown,
    -> AssistantContentState.Completed
}

private fun DevEcoHttpApi.SessionMessageTime.canonicalResult(): ActivityResult? {
    val normalizedFinish = finish?.lowercase()
    return when {
        errorName == "ContentFilterError" || normalizedFinish == "content-filter" ->
            ActivityResult.Incomplete(IncompleteReason.REFUSED)

        errorName == "MessageOutputLengthError" || normalizedFinish == "length" ->
            ActivityResult.Incomplete(IncompleteReason.OUTPUT_LENGTH)

        errorName == "MessageAbortedError" -> ActivityResult.Cancelled()

        errorName != null -> ActivityResult.Failed(
            ActivityError(
                name = errorName,
                message = errorMessage ?: errorName,
            ),
        )

        normalizedFinish == "stop" && completedAt != null -> ActivityResult.Completed

        else -> null
    }
}
