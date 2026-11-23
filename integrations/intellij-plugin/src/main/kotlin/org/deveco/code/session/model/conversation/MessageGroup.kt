package org.deveco.code.session.model.conversation

import com.agentclientprotocol.model.ToolCallContent

/**
 * A group of messages where an AGENT message acts as the parent
 * and subsequent THOUGHT/TOOL messages are its children.
 *
 * USER and SYSTEM messages are always standalone (no children).
 */
internal data class MessageGroup(
    val parent: ConversationItem,
    val children: List<ConversationItem> = emptyList(),
    val displayText: String? = null,
)

/**
 * Groups a flat list of [ConversationItem]s into [MessageGroup]s.
 *
 * Rules:
 * - AGENT messages start a new group; subsequent TOOL messages become children.
 * - THOUGHT messages never join AGENT/TOOL groups; consecutive ones merge into a
 *   single group (their text is concatenated).
 * - USER and SYSTEM messages are always standalone groups.
 * - Consecutive TOOL messages without a preceding AGENT are grouped together
 *   under a synthetic parent (the first TOOL in the sequence).
 * - A new AGENT/USER/SYSTEM message ends the current group's children collection.
 * - **Only consecutive TOOL items belonging to one file-list family are merged**
 *   into a single group (see `mergeableToolName`), so three `read` calls collapse into
 *   one card. Merging is per exact tool name: `write` never joins an `edit` run.
 *   Everything else keeps one card per call: a merged text card would hide its own
 *   output behind the parent's row. TODO calls stay standalone; interleaved families
 *   keep their stream order.
 */
internal fun groupMessages(messages: List<ConversationItem>): List<MessageGroup> {
    if (messages.isEmpty()) return emptyList()

    val groups = mutableListOf<MessageGroup>()
    var currentParent: ConversationItem? = null
    var currentChildren = mutableListOf<ConversationItem>()
    var orphanTools = mutableListOf<ConversationItem>()
    var thoughtBuffer = mutableListOf<ConversationItem>()

    fun flushGroup() {
        val parent = currentParent ?: return
        groups.add(MessageGroup(parent, currentChildren.toList()))
        currentParent = null
        currentChildren = mutableListOf()
    }

    fun flushOrphans() {
        if (orphanTools.isEmpty()) return
        // TODO tools should each be their own group (no children merged)
        val todoTools = orphanTools.filter { isTodoTool(it) }
        val otherTools = orphanTools.filterNot { isTodoTool(it) }
        // Each TODO tool is its own standalone group
        for (tool in todoTools) {
            groups.add(MessageGroup(tool))
        }
        // Orphan tools group in stream order: a run of one mergeable tool name joins a single
        // group, everything else stays one card per call (see mergeableToolName). A call whose
        // row the card could not draw never merges either.
        var runName: String? = null
        var run = mutableListOf<ConversationItem>()
        fun flushRun() {
            if (run.isEmpty()) return
            if (runName == null) {
                run.forEach { groups.add(MessageGroup(it)) }
            } else {
                groups.add(MessageGroup(run.first(), run.drop(1)))
            }
            run = mutableListOf()
        }
        for (tool in otherTools) {
            val name = mergeableToolName(tool.toolCall()?.name())
            if (name == null || name != runName || isToolChildEmpty(tool)) {
                flushRun()
                runName = name
            }
            run.add(tool)
        }
        flushRun()
        orphanTools = mutableListOf()
    }

    fun flushThoughts() {
        if (thoughtBuffer.isEmpty()) return
        // Consecutive THOUGHT items belong to one reasoning stream (older persisted
        // sessions split them). Keep the source nodes untouched and project display text separately.
        val thoughts = thoughtBuffer.toList()
        // Thoughts always stand alone; close the open group first to keep list order.
        flushGroup()
        groups.add(
            MessageGroup(
                parent = thoughts.first(),
                children = thoughts.drop(1),
                displayText = thoughts.joinToString(separator = "") { it.text },
            ),
        )
        thoughtBuffer = mutableListOf()
    }

    fun isSameMergeableTool(a: ConversationItem, b: ConversationItem): Boolean {
        val aTool = a.toolCall() ?: return false
        val bTool = b.toolCall() ?: return false
        val name = mergeableToolName(aTool.name()) ?: return false
        if (name != mergeableToolName(bTool.name())) return false
        // TODO tools should never be merged as children - each call is a separate group
        if (isTodoTool(a) || isTodoTool(b)) return false
        // A merged child renders as a file row, so anything isToolChildEmpty would drop must
        // never be merged in the first place — otherwise a pathless call vanishes instead of
        // keeping its own card.
        if (isToolChildEmpty(b)) return false
        return true
    }

    for (item in messages) {
        when (item) {
            is ConversationItem.User -> {
                flushThoughts()
                flushOrphans()
                flushGroup()
                groups.add(MessageGroup(item))
            }

            is ConversationItem.System -> {
                flushThoughts()
                flushOrphans()
                flushGroup()
                groups.add(MessageGroup(item))
            }

            is ConversationItem.Assistant.Text -> {
                flushThoughts()
                flushOrphans()
                flushGroup()
                currentParent = item
            }

            is ConversationItem.Assistant.Thought -> {
                flushOrphans()
                thoughtBuffer.add(item)
            }

            is ConversationItem.Assistant.ToolItem -> {
                flushThoughts()
                val parent = currentParent
                if (parent != null && isSameMergeableTool(parent, item)) {
                    currentChildren.add(item)
                } else if (parent != null) {
                    flushGroup()
                    currentParent = item
                } else {
                    if (orphanTools.isNotEmpty() &&
                        isSameMergeableTool(orphanTools.last(), item)
                    ) {
                        orphanTools.add(item)
                    } else {
                        orphanTools.add(item)
                    }
                }
            }
        }
    }
    flushThoughts()
    flushOrphans()
    flushGroup()

    return groups
}

/**
 * Checks if a [ConversationItem] is a TODO tool call.
 */
internal fun isTodoTool(item: ConversationItem): Boolean = item.toolCall()?.let(::isTodoTool) == true

internal fun isTodoTool(tool: ToolItem): Boolean = tool.displayTitle()?.contains("todo", ignoreCase = true) == true

/**
 * A visible USER bubble or an invisible turn marker delimits one logical turn.
 * Hidden model-facing USER notifications are not turn boundaries.
 */
internal fun isTurnBoundary(item: ConversationItem): Boolean = when (item) {
    is ConversationItem.User -> !item.internalOnly
    is ConversationItem.System -> item.turnBoundary
    is ConversationItem.Assistant -> false
}

internal fun newTurnBoundary(id: String) = ConversationItem.system(
    id = id,
    title = "",
    text = "",
    internalOnly = true,
    turnBoundary = true,
)

/**
 * Rebuild replayed messages with boundaries before the first visible item of
 * each subtask turn. The server message parentID identifies the invisible USER
 * message that owns every assistant/tool segment in that turn.
 */
internal fun insertSubtaskTurnBoundaries(
    messages: List<ConversationItem>,
    parentByLocalItemId: Map<String, String?>,
    subtaskUserIds: Set<String>,
): List<ConversationItem> {
    val insertedParents = mutableSetOf<String>()
    return messages.flatMap { message ->
        val parentId = parentByLocalItemId[message.id]
        if (parentId != null &&
            parentId in subtaskUserIds &&
            insertedParents.add(parentId)
        ) {
            listOf(newTurnBoundary("TURN-$parentId"), message)
        } else {
            listOf(message)
        }
    }
}

/**
 * Normalized name a call merges under, or null when it keeps its own card.
 *
 * Merging is per exact file-list tool name: `write` must not collapse into `edit`.
 */
internal fun mergeableToolName(toolName: String?): String? = toolName?.trim()?.lowercase()
    ?.takeIf { it in MERGEABLE_FILE_TOOLS }

private val MERGEABLE_FILE_TOOLS = setOf("read", "edit", "write", "glob")

/**
 * True when a merged child would contribute no content to the parent card.
 *
 * Grouping reads only ACP fields from [ConversationItem]. It must not depend on card-local parsing
 * helpers, which would make the model layer depend on UI.
 */
internal fun isToolChildEmpty(item: ConversationItem): Boolean {
    val tool = item.toolCall() ?: return true
    return when (mergeableToolName(tool.name())) {
        "read" -> tool.locations().firstOrNull()?.path.isNullOrBlank()

        "edit", "write" -> {
            tool.locations().firstOrNull()?.path.isNullOrBlank() &&
                (tool as? ConversationItem.Assistant.ToolItem.FileMutation)?.fileEdits.isNullOrEmpty() &&
                tool.content().any { it is ToolCallContent.Diff } == false
        }

        "glob" -> item.text.isBlank()

        else -> true
    }
}

/**
 * Text belonging to one logical agent turn. USER bubbles and invisible subtask
 * boundaries both stop the aggregation, so a subtask answer never includes the
 * preceding normal answer.
 */
internal fun collectTurnAgentText(messages: List<ConversationItem>, item: ConversationItem): String {
    val index = messages.indexOfFirst { it.id == item.id }
    if (index < 0) return item.text
    var start = index
    while (start > 0 && !isTurnBoundary(messages[start - 1])) start--
    var end = index
    while (end < messages.lastIndex && !isTurnBoundary(messages[end + 1])) end++
    return messages.subList(start, end + 1)
        .filter { it.textOutput() != null && it.text.isNotBlank() }
        .joinToString("\n\n") { it.text }
        .ifEmpty { item.text }
}

private fun ConversationItem.textOutput(): ConversationItem.Assistant.Text? = this as? ConversationItem.Assistant.Text
