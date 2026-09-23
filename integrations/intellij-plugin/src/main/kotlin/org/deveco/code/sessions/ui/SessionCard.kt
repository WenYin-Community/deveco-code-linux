package org.deveco.code.sessions.ui

import com.agentclientprotocol.annotations.UnstableApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import org.deveco.code.DevEcoIcons
import org.deveco.code.util.hoverable
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentclientprotocol.model.SessionInfo
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text

internal enum class SessionCardStatus { NEW, RUNNING, NORMAL_UNREAD, NORMAL_READ, ABNORMAL_UNREAD, ABNORMAL_READ }

internal data class SessionCardColors(
    val hover: Color,
    val muted: Color,
    val accent: Color,
)

internal data class SessionCardActions(
    val onOpen: (SessionInfo) -> Unit,
    val onStop: (SessionInfo) -> Unit,
    val onDelete: (SessionInfo) -> Unit,
)

internal data class SessionCardState(
    val item: SessionItem,
    val isRunning: Boolean,
    val isNew: Boolean,
    val isNormal: Boolean,
    val isUnread: Boolean,
    val startedAt: Long?,
    val activity: String?,
    val selected: Boolean,
    val hovered: Boolean,
    val lastDuration: Long?,
)

@Composable
@OptIn(ExperimentalComposeUiApi::class, UnstableApi::class)
internal fun SessionCard(
    state: SessionCardState,
    colors: SessionCardColors,
    actions: SessionCardActions,
    onHoverChange: (Boolean) -> Unit,
    onContextMenu: () -> Unit,
) {
    val item = state.item
    val isRunning = state.isRunning
    val accent = colors.accent
    val muted = colors.muted
    val currentOnContextMenu by rememberUpdatedState(onContextMenu)
    val bg = if (state.hovered) DevEcoTheme.pressedAccentSoft else Color.Transparent
    Row(
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(bg)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
            ) { actions.onOpen(item.info) }
            .hoverable(onHoverChange)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = Modifier.weight(1f),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StatusIndicator(
                status = when {
                    isRunning -> SessionCardStatus.RUNNING
                    state.isNew && state.lastDuration == null -> SessionCardStatus.NEW
                    state.isNormal && state.isUnread -> SessionCardStatus.NORMAL_UNREAD
                    state.isNormal -> SessionCardStatus.NORMAL_READ
                    state.isUnread -> SessionCardStatus.ABNORMAL_UNREAD
                    else -> SessionCardStatus.ABNORMAL_READ
                },
                accent = accent,
                muted = muted,
            )
            Spacer(Modifier.width(10.dp))
            Text(
                displayTitle(item.info.title),
                modifier = Modifier.weight(1f),
                fontWeight = FontWeight.Medium,
                fontSize = 13.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.width(8.dp))
        CardActionArea(
            isNew = state.isNew,
            running = isRunning,
            hovered = state.hovered,
            selected = state.selected,
            onStop = { actions.onStop(item.info) },
            onDelete = { actions.onDelete(item.info) },
            onMore = currentOnContextMenu,
        )
    }
}

@Composable
private fun CardActionArea(
    isNew: Boolean,
    running: Boolean,
    hovered: Boolean,
    selected: Boolean,
    onStop: () -> Unit,
    onDelete: () -> Unit,
    onMore: () -> Unit,
) {
    if (hovered || selected) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (running) StopButton(onStop) else DeleteButton(onDelete)
            if (!isNew) {
                Spacer(Modifier.width(4.dp))
                MoreButton(onMore)
            }
        }
    }
}

@Composable
private fun StopButton(onStop: () -> Unit) {
    val interactionSource = remember { MutableInteractionSource() }
    Box(
        modifier = Modifier.size(16.dp)
            .clickable(interactionSource = interactionSource, indication = null) { onStop() },
        contentAlignment = Alignment.Center,
    ) {
        Icon(key = DevEcoIcons.iconKey("session-stop"), contentDescription = null)
    }
}

@Composable
private fun DeleteButton(onDelete: () -> Unit) {
    val interactionSource = remember { MutableInteractionSource() }
    Box(
        modifier = Modifier.size(16.dp)
            .clickable(interactionSource = interactionSource, indication = null) { onDelete() },
        contentAlignment = Alignment.Center,
    ) {
        Icon(key = DevEcoIcons.iconKey("session-delete"), contentDescription = null)
    }
}

@Composable
private fun MoreButton(onMore: () -> Unit) {
    val interactionSource = remember { MutableInteractionSource() }
    Box(
        modifier = Modifier.size(16.dp)
            .clickable(interactionSource = interactionSource, indication = null) { onMore() },
        contentAlignment = Alignment.Center,
    ) {
        Icon(key = DevEcoIcons.iconKey("session-more"), contentDescription = null)
    }
}

@Composable
private fun StatusIndicator(status: SessionCardStatus, accent: Color, muted: Color) {
    val size = 16.dp
    val (iconName, ext) = when (status) {
        SessionCardStatus.NEW -> "session-new" to "svg"
        SessionCardStatus.RUNNING -> "session-running" to "png"
        SessionCardStatus.NORMAL_UNREAD -> "session-normal-unread" to "svg"
        SessionCardStatus.NORMAL_READ -> "session-normal-read" to "svg"
        SessionCardStatus.ABNORMAL_UNREAD -> "session-abnormal-unread" to "svg"
        SessionCardStatus.ABNORMAL_READ -> "session-abnormal-read" to "svg"
    }
    Icon(
        key = DevEcoIcons.iconKey(iconName, ext),
        contentDescription = null,
        modifier = Modifier.size(size),
    )
}

private fun displayTitle(title: String?): String {
    if (title.isNullOrBlank() || isEmptyConversation(title)) return MyMessageBundle.message("session.new.title")
    val looksLikeDate = title.length >= 10 &&
        (title[4] == '-' || title[4] == '/') && (title[7] == '-' || title[7] == '/')
    val allDigits = title.length >= 10 && title.all { it.isDigit() }
    return if (looksLikeDate || allDigits) MyMessageBundle.message("session.new.title") else title
}
