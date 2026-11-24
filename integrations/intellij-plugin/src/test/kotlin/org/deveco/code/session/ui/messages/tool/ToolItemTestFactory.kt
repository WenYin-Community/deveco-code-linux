package org.deveco.code.session.ui.messages.tool

import com.agentclientprotocol.model.ContentBlock
import com.agentclientprotocol.model.SessionUpdate
import com.agentclientprotocol.model.ToolCallContent
import com.agentclientprotocol.model.ToolCallId
import com.agentclientprotocol.model.ToolCallLocation
import com.agentclientprotocol.model.ToolCallStatus
import com.agentclientprotocol.model.ToolKind
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.deveco.code.session.model.conversation.ConversationItem
import org.deveco.code.session.model.conversation.ToolItem

internal object ToolItemTestFactory {
    fun create(
        id: String = "tool-1",
        title: String = "tool",
        text: String = "output",
        kind: ToolKind? = null,
        status: ToolCallStatus? = ToolCallStatus.COMPLETED,
        content: List<ToolCallContent> = emptyList(),
        locations: List<ToolCallLocation> = emptyList(),
        rawInput: JsonElement? = null,
        rawOutput: JsonElement? = null,
        name: String? = null,
    ): ToolItem {
        val nativeContent = if (content.isEmpty() && text.isNotEmpty()) {
            listOf(ToolCallContent.Content(ContentBlock.Text(text)))
        } else {
            content
        }
        val native = SessionUpdate.ToolCall(
            toolCallId = ToolCallId(id),
            title = title,
            kind = kind,
            status = status,
            content = nativeContent,
            locations = locations,
            rawInput = rawInput,
            rawOutput = rawOutput,
            _meta = name?.let { JsonObject(mapOf("tool_name" to JsonPrimitive(it))) },
        )
        return when {
            name.equals(
                "task",
                ignoreCase = true,
            ) -> ConversationItem.Assistant.ToolItem.Subagent(native, description = null)

            kind == ToolKind.READ -> ConversationItem.Assistant.ToolItem.Read(native)

            kind == ToolKind.EDIT || kind == ToolKind.DELETE ->
                ConversationItem.Assistant.ToolItem.FileMutation(native)

            else -> ConversationItem.Assistant.ToolItem.Generic(native)
        }
    }
}
