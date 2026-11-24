package org.deveco.code.session.replay

import org.deveco.code.acp.DevEcoHttpApi
import org.deveco.code.session.model.conversation.ConversationItem

internal fun visibleServerUserMessages(
    messages: List<DevEcoHttpApi.SessionMessageTime>,
): List<DevEcoHttpApi.SessionMessageTime> = messages.filter { it.role == "user" && !it.hasSubtaskPart }

internal fun borrowedUserCreatedAt(
    items: List<ConversationItem>,
    serverUsers: List<DevEcoHttpApi.SessionMessageTime>,
): Map<String, Long> {
    var ordinal = 0
    return buildMap {
        items.forEach { item ->
            if (item !is ConversationItem.User) return@forEach
            serverUsers.getOrNull(ordinal)?.let { put(item.id, it.createdAt) }
            ordinal++
        }
    }
}

internal fun parentIdsByLocalItem(messages: List<DevEcoHttpApi.SessionMessageTime>): Map<String, String?> = buildMap {
    messages.forEach { message ->
        put(message.id, message.parentID)
        put("thought-${message.id}", message.parentID)
        message.partIds.forEach { partId ->
            put(partId, message.parentID)
            put("tool-$partId", message.parentID)
        }
    }
}

internal fun agentIdsMissingServerTimes(items: List<ConversationItem>, serverMessageIds: Set<String>): Set<String> =
    items
        .filterIsInstance<ConversationItem.Assistant.Text>()
        .map { it.id }
        .filterNot { it in serverMessageIds }
        .toSet()

/**
 * Returns the last complete AGENT id only when it has immediately following
 * TOOL/THOUGHT rows. Moving only this item preserves the streamed history.
 */
internal fun lastCompleteAgentToMove(items: List<ConversationItem>): String? {
    val agentIndex = items.indexOfLast {
        it is ConversationItem.Assistant.Text && it.isComplete
    }
    if (agentIndex < 0) return null
    val hasFollowingAssistantMetadata = items.drop(agentIndex + 1)
        .takeWhile {
            it is ConversationItem.Assistant.ToolItem ||
                it is ConversationItem.Assistant.Thought
        }
        .isNotEmpty()
    return items[agentIndex].id.takeIf { hasFollowingAssistantMetadata }
}
