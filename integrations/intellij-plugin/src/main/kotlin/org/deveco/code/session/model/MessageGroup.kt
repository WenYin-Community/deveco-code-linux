package org.deveco.code.session.model

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
 * - Consecutive THOUGHT messages are merged into a single group (their text is concatenated).
 * - USER and SYSTEM messages are always standalone groups.
 * - Consecutive TOOL messages without a preceding AGENT are grouped together
 *   under a synthetic parent (the first TOOL in the sequence).
 * - A new AGENT/USER/SYSTEM message ends the current group's children collection.
 * - **Consecutive TOOL items with the same toolKind are merged into a single group**
 *   to avoid showing duplicate entries like three separate "read" items.
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
        // Group other orphan tools by toolKind - each group becomes a separate MessageGroup
        val grouped = otherTools.groupBy { it.toolKind }
        for ((_, tools) in grouped) {
            if (tools.isEmpty()) continue
            val syntheticParent = tools.first()
            val remaining = tools.drop(1)
            groups.add(MessageGroup(syntheticParent, remaining))
        }
        orphanTools = mutableListOf()
    }

    fun flushThoughts() {
        if (thoughtBuffer.isEmpty()) return
        // Consecutive THOUGHT items belong to one reasoning stream (older persisted
        // sessions split them); merge their text so they render as one block.
        val merged = thoughtBuffer.reduce { acc, item -> acc.copy(text = acc.text + item.text) }
        if (currentParent != null) {
            currentChildren.add(merged)
        } else {
            groups.add(MessageGroup(merged))
        }
        thoughtBuffer = mutableListOf()
    }

    fun isSameToolKind(a: ChatItem, b: ChatItem): Boolean {
        if (a.role != ChatRole.TOOL || b.role != ChatRole.TOOL) return false
        if (a.toolKind == b.toolKind && a.toolKind != null) {
            // TODO tools should never be merged as children - each call is a separate group
            if (isTodoTool(a) || isTodoTool(b)) return false
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
 * Checks whether a TOOL [ChatItem] has no meaningful content to display.
 * A tool item is considered empty when:
 * - It has no text output
 * - Its text contains no parseable file paths (for SEARCH tools)
 * - It is not currently running (in-progress tools may receive content later)
 */
internal fun isToolItemEmpty(item: ChatItem): Boolean {
    if (item.role != ChatRole.TOOL) return false
    if (item.toolStatus == com.agentclientprotocol.model.ToolCallStatus.PENDING ||
        item.toolStatus == com.agentclientprotocol.model.ToolCallStatus.IN_PROGRESS
    ) {
        return false
    }
    if (item.text.isNotBlank()) return false
    if (item.toolKind == com.agentclientprotocol.model.ToolKind.SEARCH) {
        val paths = org.deveco.code.session.ui.messages.FileTreeParser.parseFilePaths(item.text)
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
