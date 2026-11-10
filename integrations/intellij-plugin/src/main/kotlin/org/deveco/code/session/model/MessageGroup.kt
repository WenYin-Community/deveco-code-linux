package org.deveco.code.session.model

import com.agentclientprotocol.model.ToolCallStatus
import com.agentclientprotocol.model.ToolKind
import org.deveco.code.acp.AcpToolInputParser
import org.deveco.code.session.ui.messages.FileTreeParser

/**
 * A group of messages where an AGENT message acts as the parent
 * and subsequent THOUGHT/TOOL messages are its children.
 *
 * USER and SYSTEM messages are always standalone (no children).
 */
internal data class MessageGroup(val parent: ChatItem, val children: List<ChatItem> = emptyList())

/**
 * Groups a flat list of [ChatItem]s into [MessageGroup]s.
 *
 * Rules:
 * - AGENT messages start a new group; subsequent TOOL messages become children.
 * - THOUGHT messages never join AGENT/TOOL groups; consecutive ones merge into a
 *   single group (their text is concatenated).
 * - USER and SYSTEM messages are always standalone groups.
 * - Consecutive TOOL messages without a preceding AGENT are grouped together
 *   under a synthetic parent (the first TOOL in the sequence).
 * - A new AGENT/USER/SYSTEM message ends the current group's children collection.
 * - **Runs of consecutive TOOL items with the same toolKind are merged into a
 *   single group** to avoid showing duplicate entries like three separate
 *   "read" items. TODO and THINK (subagent) tools are exempt: each call stays
 *   its own group, and kinds interleaved across the stream keep their order.
 */
internal fun groupMessages(messages: List<ChatItem>): List<MessageGroup> {
    if (messages.isEmpty()) return emptyList()

    val groups = mutableListOf<MessageGroup>()
    var currentParent: ChatItem? = null
    var currentChildren = mutableListOf<ChatItem>()
    var orphanTools = mutableListOf<ChatItem>()
    var thoughtBuffer = mutableListOf<ChatItem>()

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
        // Orphan tools group in stream order: a run of one kind merges into a
        // single group. THINK (subagent) and EXECUTE (command) calls never merge:
        // merging hides each call's own output behind a working-directory row, so
        // every command keeps its text at its original position in the stream.
        // Pathless tools never merge either: as children they would render as an
        // empty file row and get filtered out (see isSameToolKind).
        var runKind: ToolKind? = null
        var run = mutableListOf<ChatItem>()
        fun flushRun() {
            if (run.isEmpty()) return
            if (runKind == ToolKind.THINK || runKind == ToolKind.EXECUTE) {
                run.forEach { groups.add(MessageGroup(it)) }
            } else {
                groups.add(MessageGroup(run.first(), run.drop(1)))
            }
            run = mutableListOf()
        }
        for (tool in otherTools) {
            if (tool.toolKind != runKind ||
                tool.toolKind == ToolKind.THINK ||
                tool.toolKind == ToolKind.EXECUTE ||
                isToolChildEmpty(tool)
            ) {
                flushRun()
                runKind = tool.toolKind
            }
            run.add(tool)
        }
        flushRun()
        orphanTools = mutableListOf()
    }

    fun flushThoughts() {
        if (thoughtBuffer.isEmpty()) return
        // Consecutive THOUGHT items belong to one reasoning stream (older persisted
        // sessions split them); merge their text so they render as one block.
        val merged = thoughtBuffer.reduce { acc, item -> acc.copy(text = acc.text + item.text) }
        // Thoughts always stand alone; close the open group first to keep list order.
        flushGroup()
        groups.add(MessageGroup(merged))
        thoughtBuffer = mutableListOf()
    }

    fun isSameToolKind(a: ChatItem, b: ChatItem): Boolean {
        if (a.role != ChatRole.TOOL || b.role != ChatRole.TOOL) return false
        if (a.toolKind == b.toolKind && a.toolKind != null) {
            // TODO tools should never be merged as children - each call is a separate group
            if (isTodoTool(a) || isTodoTool(b)) return false
            // Each subagent (THINK) call stays its own group; merging hides siblings
            if (a.toolKind == ToolKind.THINK) return false
            // Each command (EXECUTE) call stays its own group; merging would render
            // every call after the first as a bare working-directory row and drop
            // the command output the user needs to read.
            if (a.toolKind == ToolKind.EXECUTE) return false
            // A merged child renders as a file row, so anything isToolChildEmpty would
            // drop must never be merged in the first place — otherwise a pathless call
            // (plan_exit, question, most MCP tools) vanishes instead of keeping its own
            // card.
            if (isToolChildEmpty(b)) return false
            return true
        }
        return false
    }

    for (item in messages) {
        when (item.role) {
            ChatRole.AGENT -> {
                flushThoughts()
                flushOrphans()
                flushGroup()
                currentParent = item
            }

            ChatRole.THOUGHT -> {
                flushOrphans()
                thoughtBuffer.add(item)
            }

            ChatRole.TOOL -> {
                flushThoughts()
                val parent = currentParent
                if (parent != null && isSameToolKind(parent, item)) {
                    currentChildren.add(item)
                } else if (parent != null) {
                    flushGroup()
                    currentParent = item
                } else {
                    if (orphanTools.isNotEmpty() &&
                        isSameToolKind(orphanTools.last(), item)
                    ) {
                        orphanTools.add(item)
                    } else {
                        orphanTools.add(item)
                    }
                }
            }

            ChatRole.USER, ChatRole.SYSTEM -> {
                flushThoughts()
                flushOrphans()
                flushGroup()
                groups.add(MessageGroup(item))
            }
        }
    }
    flushThoughts()
    flushOrphans()
    flushGroup()

    return groups
}

/**
 * Checks if a [ChatItem] is a TODO tool call.
 */
internal fun isTodoTool(item: ChatItem): Boolean = item.role == ChatRole.TOOL &&
    item.title.contains("todo", ignoreCase = true)

/**
 * A visible USER bubble or an invisible turn marker delimits one logical turn.
 * Hidden model-facing USER notifications are not turn boundaries.
 */
internal fun isTurnBoundary(item: ChatItem): Boolean =
    item.turnBoundary || (item.role == ChatRole.USER && !item.internalOnly)

internal fun newTurnBoundary(id: String) = ChatItem(
    id = id,
    role = ChatRole.SYSTEM,
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
    messages: List<ChatItem>,
    parentByLocalItemId: Map<String, String?>,
    subtaskUserIds: Set<String>,
): List<ChatItem> {
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
 * Checks whether a TOOL [ChatItem] has no meaningful content to display.
 * A tool item is considered empty when:
 * - It has no text output
 * - Its text contains no parseable file paths (for SEARCH tools)
 * - It is not currently running (in-progress tools may receive content later)
 */
internal fun isToolItemEmpty(item: ChatItem): Boolean {
    if (item.role != ChatRole.TOOL) return false
    // A background task card carries terminal status even with an empty result
    // body; filtering it would make the whole task vanish without a trace.
    if (item.toolKind == ToolKind.THINK &&
        AcpToolInputParser.backgroundJobId(item.toolRawOutput) != null
    ) {
        return false
    }
    if (item.toolStatus == ToolCallStatus.PENDING ||
        item.toolStatus == ToolCallStatus.IN_PROGRESS
    ) {
        return false
    }
    if (item.text.isNotBlank()) return false
    if (item.toolKind == ToolKind.SEARCH) {
        val paths = FileTreeParser.parseFilePaths(item.text)
        if (paths.isNotEmpty()) return false
    }
    return true
}

/**
 * Checks whether a TOOL child item has a valid file path that would render visibly.
 * Directory paths (e.g. project root) are considered empty since they can't be
 * rendered as file links.
 */
internal fun isToolChildEmpty(item: ChatItem): Boolean {
    if (item.role != ChatRole.TOOL) return false
    val path = item.toolPath
    if (path.isNullOrBlank()) return true
    // Directory paths are not valid file paths for child rendering
    if (org.deveco.code.session.ui.messages.FileTreeParser.isDirectoryPath(path)) return true
    val ext = org.deveco.code.session.ui.messages.FileTreeParser.getFileExtension(path)
    return ext.isEmpty() && path.isBlank()
}

internal data class TurnFooterAnchors(
    // Last visible group in a turn -> the turn's last non-blank AGENT segment.
    // Copy/time actions render with that group, after all THOUGHT/TOOL children.
    val agentByAnchorId: Map<String, String>,
    // Last visible group in a turn -> that turn's terminal state. This is deliberately
    // independent of the AGENT segment: THOUGHT/TOOL content can follow the final
    // AGENT segment, and Stopped/Failed must still render after all of it.
    val terminalStatusByAnchorId: Map<String, TurnTerminalStatus>,
)

internal data class TurnTerminalStatus(
    // "stopped" | "failed"
    val status: String,
    val timestamp: Long,
    val errorText: String? = null,
)

// Turn footer: copy/time and terminal status are both anchored after the turn's
// final visible group.
// Synthetic continuation turns are filtered out of the group list upstream, so a
// turn here always ends at a real user message, an invisible subtask boundary, or
// the end of the conversation.
internal fun turnFooterAnchors(groups: List<MessageGroup>): TurnFooterAnchors {
    val agentByAnchorId = mutableMapOf<String, String>()
    val terminalStatusByAnchorId = mutableMapOf<String, TurnTerminalStatus>()
    var turnAgents = mutableListOf<ChatItem>()
    var turnGroups = mutableListOf<MessageGroup>()
    var lastVisibleGroupId: String? = null

    fun isVisible(group: MessageGroup): Boolean = when (group.parent.role) {
        ChatRole.AGENT -> group.parent.text.isNotBlank()
        ChatRole.TOOL -> !isToolItemEmpty(group.parent) || group.children.any { !isToolChildEmpty(it) }
        ChatRole.USER, ChatRole.SYSTEM, ChatRole.THOUGHT -> !group.parent.internalOnly
    }

    fun flushTurn() {
        val agentId = turnAgents.lastOrNull { it.text.isNotBlank() }?.id
        lastVisibleGroupId?.let { anchorId -> agentId?.let { agentByAnchorId[anchorId] = it } }
        turnAgents
            .filter { it.interrupted || it.errorText != null }
            .forEach { terminal ->
                val messageAnchorId = terminal.sourceMessageId?.let { sourceMessageId ->
                    turnGroups.asReversed().firstOrNull { group ->
                        isVisible(group) &&
                            (group.parent.sourceMessageId == sourceMessageId ||
                                group.children.any { it.sourceMessageId == sourceMessageId })
                    }?.parent?.id ?: turnGroups.asReversed().firstOrNull { group ->
                        group.parent.sourceMessageId == sourceMessageId ||
                            group.children.any { it.sourceMessageId == sourceMessageId }
                    }?.parent?.id
                }
                val anchorId = messageAnchorId ?: terminal.id.takeIf { source ->
                    turnGroups.any { it.parent.id == source }
                } ?: lastVisibleGroupId
                if (anchorId != null) terminalStatusByAnchorId[anchorId] = TurnTerminalStatus(
                    status = if (terminal.errorText != null) "failed" else "stopped",
                    timestamp = terminal.completedAt.takeIf { it > 0 } ?: terminal.createdAt,
                    errorText = terminal.errorText,
                )
            }
        turnAgents = mutableListOf()
        turnGroups = mutableListOf()
        lastVisibleGroupId = null
    }

    for (group in groups) {
        val parent = group.parent
        if (isTurnBoundary(parent)) {
            flushTurn()
            continue
        }
        turnGroups += group
        if (parent.role == ChatRole.AGENT) turnAgents += parent
        if (isVisible(group)) lastVisibleGroupId = parent.id
    }
    flushTurn()
    return TurnFooterAnchors(agentByAnchorId, terminalStatusByAnchorId)
}

/**
 * Text belonging to one logical agent turn. USER bubbles and invisible subtask
 * boundaries both stop the aggregation, so a subtask answer never includes the
 * preceding normal answer.
 */
internal fun collectTurnAgentText(messages: List<ChatItem>, item: ChatItem): String {
    val index = messages.indexOfFirst { it.id == item.id }
    if (index < 0) return item.text
    var start = index
    while (start > 0 && !isTurnBoundary(messages[start - 1])) start--
    var end = index
    while (end < messages.lastIndex && !isTurnBoundary(messages[end + 1])) end++
    return messages.subList(start, end + 1)
        .filter { it.role == ChatRole.AGENT && it.text.isNotBlank() }
        .joinToString("\n\n") { it.text }
        .ifEmpty { item.text }
}
