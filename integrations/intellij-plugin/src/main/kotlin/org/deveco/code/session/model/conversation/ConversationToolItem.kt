package org.deveco.code.session.model.conversation

import com.agentclientprotocol.model.ContentBlock
import com.agentclientprotocol.model.SessionUpdate
import com.agentclientprotocol.model.ToolCallContent
import com.agentclientprotocol.model.ToolCallStatus
import com.agentclientprotocol.model.ToolKind
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import org.deveco.code.acp.AcpToolInputParser

internal typealias ToolItem = ConversationItem.Assistant.ToolItem

private enum class ConversationToolItemType {
    GENERIC,
    READ,
    FILE_MUTATION,
    SUBAGENT,
}

internal val ToolItem.outputText: String
    get() = native.renderConversationToolOutput()

internal fun ToolItem.callId(): String = native.toolCallId.value

internal fun ToolItem.name(): String? = AcpToolInputParser.toolNameFromMeta(native._meta)

internal fun ToolItem.kind(): ToolKind? = native.kind

internal fun ToolItem.status(): ToolCallStatus? = native.status

internal fun ToolItem.content(): List<ToolCallContent> = native.content

internal fun ToolItem.rawInput(): JsonElement? = native.rawInput

internal fun ToolItem.rawOutput(): JsonElement? = native.rawOutput

internal fun ToolItem.locations() = native.locations

internal fun ToolItem.isRunning(): Boolean =
    status() == ToolCallStatus.PENDING || status() == ToolCallStatus.IN_PROGRESS

internal fun reduceConversationToolItem(current: ToolItem, update: SessionUpdate.ToolCallUpdate): ToolItem {
    val mergedNative = current.mergeConversationToolNative(update)
    val type = conversationToolItemType(mergedNative)
    if (conversationToolItemType(current) == type) {
        current.updateNative(
            if (type == ConversationToolItemType.SUBAGENT) normalizeRunningReceipt(mergedNative) else mergedNative,
        )
        return current
    }
    return toolItemFrom(
        native = mergedNative,
        createdAt = current.createdAt,
        completedAt = current.completedAt,
        backgroundMerged = current.backgroundMerged,
    ).apply {
        setExpanded(current.expanded)
    }
}

internal fun mergeConversationToolItem(
    current: ToolItem,
    replacement: ToolItem,
    backgroundMerged: Boolean = replacement.backgroundMerged,
): ToolItem {
    val replacementWithEnvelope = replacement.apply {
        setEnvelope(
            createdAt = current.createdAt,
            completedAt = current.completedAt,
            backgroundMerged = backgroundMerged,
        )
        setExpanded(current.expanded)
    }
    if (current::class == replacementWithEnvelope::class) {
        current.updateNative(replacementWithEnvelope.native)
        current.setEnvelope(
            createdAt = current.createdAt,
            completedAt = current.completedAt,
            backgroundMerged = backgroundMerged,
        )
        return current
    }
    return replacementWithEnvelope
}

internal fun ConversationItem.Assistant.ToolItem.Subagent.setBackgroundResult(status: ToolCallStatus, body: String) {
    native = native.copy(status = status).withConversationToolOutputText(body)
    description = conversationTaskDescription(native)
}

internal fun toolItemFrom(
    native: SessionUpdate.ToolCall,
    createdAt: Long = System.currentTimeMillis(),
    completedAt: Long = 0,
    backgroundMerged: Boolean = false,
): ToolItem = when (conversationToolItemType(native)) {
    ConversationToolItemType.SUBAGENT ->
        newConversationSubagent(native, createdAt, completedAt, backgroundMerged)

    ConversationToolItemType.READ ->
        ConversationItem.Assistant.ToolItem.Read(native, createdAt, completedAt, backgroundMerged)

    ConversationToolItemType.FILE_MUTATION ->
        ConversationItem.Assistant.ToolItem.FileMutation(native, createdAt, completedAt, backgroundMerged)

    ConversationToolItemType.GENERIC ->
        ConversationItem.Assistant.ToolItem.Generic(native, createdAt, completedAt, backgroundMerged)
}

internal fun toolItemFrom(update: SessionUpdate.ToolCallUpdate): ToolItem = toolItemFrom(
    SessionUpdate.ToolCall(
        toolCallId = update.toolCallId,
        title = update.title.orEmpty(),
        kind = update.kind,
        status = update.status,
        content = update.content.orEmpty(),
        locations = update.locations.orEmpty(),
        rawInput = update.rawInput,
        rawOutput = update.rawOutput,
        _meta = update._meta,
    ),
)

internal fun conversationToolDisplayTitle(native: SessionUpdate.ToolCall): String? = resolveConversationToolTitle(
    nativeTitle = native.title,
    toolName = AcpToolInputParser.toolNameFromMeta(native._meta),
    kind = native.kind,
    rawInput = native.rawInput,
)

private fun ToolItem.mergeConversationToolNative(update: SessionUpdate.ToolCallUpdate): SessionUpdate.ToolCall {
    val mergedKind = update.kind ?: native.kind
    val mergedMeta = update._meta ?: native._meta
    val incomingTitle = update.title
        ?.takeIf { !isSyntheticConversationToolTitle(it, AcpToolInputParser.toolNameFromMeta(mergedMeta), mergedKind) }
    return native.copy(
        title = incomingTitle ?: native.title,
        kind = mergedKind,
        status = update.status ?: native.status,
        content = update.content ?: native.content,
        rawInput = update.rawInput ?: native.rawInput,
        rawOutput = update.rawOutput ?: native.rawOutput,
        locations = update.locations ?: native.locations,
        _meta = mergedMeta,
    )
}

private fun ToolItem.updateNative(value: SessionUpdate.ToolCall) {
    native = value
    if (this is ConversationItem.Assistant.ToolItem.Subagent) {
        description = conversationTaskDescription(value)
    }
}

private fun conversationToolItemType(native: SessionUpdate.ToolCall): ConversationToolItemType {
    val toolName = AcpToolInputParser.toolNameFromMeta(native._meta)
    if (toolName.equals("task", ignoreCase = true)) return ConversationToolItemType.SUBAGENT
    if (toolName.equals("read", ignoreCase = true)) return ConversationToolItemType.READ
    if (native.kind == ToolKind.EDIT || native.kind == ToolKind.DELETE) {
        return ConversationToolItemType.FILE_MUTATION
    }
    return ConversationToolItemType.GENERIC
}

private fun conversationToolItemType(item: ToolItem): ConversationToolItemType = when (item) {
    is ConversationItem.Assistant.ToolItem.Subagent -> ConversationToolItemType.SUBAGENT
    is ConversationItem.Assistant.ToolItem.Read -> ConversationToolItemType.READ
    is ConversationItem.Assistant.ToolItem.FileMutation -> ConversationToolItemType.FILE_MUTATION
    is ConversationItem.Assistant.ToolItem.Generic -> ConversationToolItemType.GENERIC
}

private fun newConversationSubagent(
    native: SessionUpdate.ToolCall,
    createdAt: Long,
    completedAt: Long,
    backgroundMerged: Boolean,
): ConversationItem.Assistant.ToolItem.Subagent {
    val normalized = normalizeRunningReceipt(native)
    return ConversationItem.Assistant.ToolItem.Subagent(
        native = normalized,
        description = conversationTaskDescription(normalized),
        createdAt = createdAt,
        completedAt = completedAt,
        backgroundMerged = backgroundMerged,
    )
}

private fun ConversationItem.Assistant.ToolItem.Subagent.normalizeConversationSubagentReceipt() {
    native = normalizeRunningReceipt(native)
}

private fun normalizeRunningReceipt(native: SessionUpdate.ToolCall): SessionUpdate.ToolCall {
    val runningReceipt = native.status == ToolCallStatus.COMPLETED &&
        native.kind == ToolKind.THINK &&
        AcpToolInputParser.backgroundJobId(native.rawOutput) != null &&
        AcpToolInputParser.parseTaskWrapper(native.renderConversationToolOutput())?.state == "running"
    return if (runningReceipt) native.copy(status = ToolCallStatus.IN_PROGRESS) else native
}

private fun conversationTaskDescription(native: SessionUpdate.ToolCall): String? = (native.rawInput as? JsonObject)
    ?.get("description")
    ?.jsonPrimitive
    ?.contentOrNull
    ?.takeIf { it.isNotBlank() }

internal interface PrimaryFileLocation {
    val primaryPath: String?
    val primaryLine: Int?
}

private fun resolveConversationToolTitle(
    nativeTitle: String?,
    toolName: String?,
    kind: ToolKind?,
    rawInput: JsonElement?,
): String? {
    val description = (rawInput as? JsonObject)
        ?.get("description")
        ?.jsonPrimitive
        ?.contentOrNull
        ?.takeIf { it.isNotBlank() }

    if (toolName.equals("task", ignoreCase = true) && description != null) return description
    return nativeTitle
        ?.takeIf { it.isNotBlank() }
        ?.takeUnless { isSyntheticConversationToolTitle(it, toolName, kind) }
        ?: description
        ?: toolName?.takeIf { it.isNotBlank() }
}

private fun isSyntheticConversationToolTitle(title: String, toolName: String?, kind: ToolKind?): Boolean {
    val normalized = title.lowercase()
    return normalized == toolName?.lowercase() ||
        normalized == kind?.name?.lowercase()?.replace('_', ' ')
}

private val PATH_LISTING_TOOL_TITLES = listOf("list_directory_tree")

/** Flattens ACP tool content into the plain text consumed by generic cards. */
private fun SessionUpdate.ToolCall.renderConversationToolOutput(): String =
    renderConversationToolOutput(content, rawOutput, kind, title).orEmpty()

private fun SessionUpdate.ToolCall.withConversationToolOutputText(value: String): SessionUpdate.ToolCall = copy(
    content = listOf(
        ToolCallContent.Content(ContentBlock.Text(value)),
    ),
)

private fun renderConversationToolOutput(
    content: List<ToolCallContent>?,
    rawOutput: Any?,
    kind: ToolKind?,
    title: String?,
): String? {
    val rendered = content.orEmpty().mapNotNull { block ->
        when (block) {
            is ToolCallContent.Content -> when (val value = block.content) {
                is ContentBlock.Text -> value.text
                else -> value.toString()
            }

            is ToolCallContent.Diff -> buildString {
                append(block.path)
                block.newText.takeIf { it.isNotBlank() }?.let { append("\n").append(it) }
            }

            is ToolCallContent.Terminal -> block.terminalId
        }
    }.filter { it.isNotBlank() }.joinToString("\n\n").takeIf { it.isNotBlank() }

    if (kind == ToolKind.EXECUTE || PATH_LISTING_TOOL_TITLES.none { title?.endsWith(it) == true }) {
        return rendered
    }
    if (rendered != null) {
        val trimmed = rendered.trim()
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
            renderConversationToolJsonOutput(trimmed)?.let { return it }
        }
        return rendered
    }
    renderConversationToolJsonOutput(rawOutput)?.let { return it }
    return rawOutput?.toString()?.takeUnless { it == "{}" }
}

private fun renderConversationToolJsonOutput(rawOutput: Any?): String? {
    val array: JsonArray = when (rawOutput) {
        is JsonArray -> rawOutput

        is List<*> -> {
            val objects = rawOutput.filterIsInstance<JsonObject>()
            if (objects.isEmpty()) return null
            JsonArray(objects)
        }

        is String -> {
            val trimmed = rawOutput.trim()
            if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null
            try {
                Json.parseToJsonElement(trimmed) as? JsonArray ?: return null
            } catch (_: Exception) {
                return null
            }
        }

        else -> return null
    }
    if (array.isEmpty()) return null
    val pathKeys = listOf("path", "name", "file", "file_path", "filePath")
    return array
        .flatMap { extractConversationToolPaths(it, pathKeys) }
        .takeIf { it.isNotEmpty() }
        ?.joinToString("\n")
}

private fun extractConversationToolPaths(element: JsonElement, pathKeys: List<String>): List<String> {
    if (element !is JsonObject) return listOf(element.toString())
    val result = mutableListOf<String>()
    for (key in pathKeys) {
        val value = element[key]
        if (value is JsonPrimitive) {
            val text = value.contentOrNull
            if (!text.isNullOrBlank()) {
                result.add(text)
                break
            }
        }
    }
    if (result.isEmpty()) {
        element.entries
            .firstOrNull {
                val value = it.value
                value is JsonPrimitive && !value.contentOrNull.isNullOrBlank()
            }
            ?.value
            ?.let { it as JsonPrimitive }
            ?.contentOrNull
            ?.let { result.add(it) }
    }
    val children = element["children"]
    if (children is JsonArray) {
        for (child in children) result.addAll(extractConversationToolPaths(child, pathKeys))
    }
    return result
}
