package org.deveco.code.session.model.conversation

import com.agentclientprotocol.model.SessionUpdate
import com.intellij.openapi.diagnostic.Logger
import com.intellij.util.messages.MessageBus
import com.intellij.util.messages.Topic

/**
 * Facts published after SessionController commits a tool snapshot. Domain subscribers consume
 * [Updated.after], never a raw ACP delta, so later derived changes cannot rewrite protocol state.
 */
internal sealed interface ToolBusEvent {
    val sessionId: String
    val replay: Boolean

    data class Updated(
        override val sessionId: String,
        val activityId: String?,
        val toolCallId: String,
        val before: ToolItem?,
        val after: ToolItem,
        override val replay: Boolean,
    ) : ToolBusEvent

    data class PermissionRequested(
        override val sessionId: String,
        val activityId: String?,
        val toolCallId: String,
        val toolCall: SessionUpdate.ToolCallUpdate,
        override val replay: Boolean = false,
    ) : ToolBusEvent

    data class SubagentLinked(
        override val sessionId: String,
        val activityId: String,
        val toolCallId: String,
        val link: SubagentLink,
        override val replay: Boolean,
    ) : ToolBusEvent
}

/**
 * Receives committed tool facts synchronously on the publisher's thread.
 *
 * Publishing does not imply the EDT. Listeners that mutate Compose state, Swing state or VFS
 * must dispatch those operations to their required thread themselves.
 */
internal fun interface ToolBusListener {
    fun onToolEvent(event: ToolBusEvent)
}

internal val TOOL_BUS_TOPIC: Topic<ToolBusListener> = Topic.create(
    "DevEco Code Tool Bus",
    ToolBusListener::class.java,
)

private val toolBusLog = Logger.getInstance(ToolBusEvent::class.java)

/** Publishes a committed tool fact without allowing a listener failure to break the caller. */
internal fun MessageBus.publishToolBusEvent(event: ToolBusEvent) {
    try {
        syncPublisher(TOOL_BUS_TOPIC).onToolEvent(event)
    } catch (e: Exception) {
        toolBusLog.warn("Tool bus listener failed for ${event::class.java.simpleName}", e)
    }
}
