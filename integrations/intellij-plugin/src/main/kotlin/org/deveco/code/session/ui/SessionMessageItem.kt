package org.deveco.code.session.ui

import androidx.compose.runtime.*
import androidx.compose.ui.graphics.Color
import org.deveco.code.session.SessionController
import org.deveco.code.session.model.ChatItem
import org.deveco.code.session.model.ChatRole
import org.deveco.code.session.model.PermissionChoice
import org.deveco.code.session.ui.messages.AgentMessage
import org.deveco.code.session.ui.messages.CompactionDividerItem
import org.deveco.code.session.ui.messages.SystemItem
import org.deveco.code.session.ui.messages.ThoughtItem
import org.deveco.code.session.ui.messages.ToolItem
import org.deveco.code.session.ui.messages.UserMessage

@Composable
internal fun SessionMessageItem(
    item: ChatItem,
    card: Color,
    muted: Color,
    accent: Color,
    conversationBackground: Color,
    expandedThoughts: MutableMap<String, Boolean>,
    expandedTools: MutableMap<String, Boolean>,
    permissionChoices: Map<String, List<PermissionChoice>>,
    permissionResults: Map<String, String> = emptyMap(),
    permissionDeniedIds: Set<String> = emptySet(),
    onOpenFile: (ChatItem) -> Unit,
    preserveScroll: ((() -> Unit) -> Unit),
    controller: SessionController? = null,
    children: List<ChatItem> = emptyList(),
    showHeader: Boolean = true,
    isChild: Boolean = false,
    onOverlayLift: ((Boolean) -> Unit)? = null,
) {
    if (item.compactionDivider) {
        CompactionDividerItem(muted)
        return
    }
    when (item.role) {
        ChatRole.USER -> UserMessage(item, accent, conversationBackground, controller, onOverlayLift)
        ChatRole.AGENT -> AgentMessage(item)
        ChatRole.THOUGHT -> ThoughtItem(item, muted, expandedThoughts, preserveScroll, showHeader, showTreeLine = !isChild)
        ChatRole.TOOL -> ToolItem(item, card, muted, expandedTools, preserveScroll, onOpenFile, children, isChild)
        ChatRole.SYSTEM -> SystemItem(
            item,
            card,
            muted,
            permissionChoices[item.id],
            permissionResults[item.id],
            permissionDenied = item.id in permissionDeniedIds,
        )
    }
}
