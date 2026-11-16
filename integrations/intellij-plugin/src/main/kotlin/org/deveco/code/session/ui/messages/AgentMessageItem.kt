package org.deveco.code.session.ui.messages

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import org.deveco.code.DevEcoIcons
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.deveco.code.session.SessionController
import org.deveco.code.session.model.ChatItem
import org.deveco.code.session.model.TurnTerminalStatus
import org.jetbrains.jewel.markdown.Markdown
import org.jetbrains.jewel.markdown.extensions.LocalMarkdownBlockRenderer
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.component.Tooltip
import org.jetbrains.jewel.ui.icon.PathIconKey

private val CheckmarkIconKey = PathIconKey("/icons/checkmark.svg", DevEcoTheme::class.java)
internal const val COPIED_INDICATOR_MS = 1500L

@Composable
internal fun AgentMessage(
    item: ChatItem,
) {
    Column(
        Modifier.fillMaxWidth(),
    ) {
        if (item.text.isNotBlank()) {
            MarkdownWithCodeBlocks(
                text = item.text,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
internal fun TurnFooter(
    item: ChatItem?,
    controller: SessionController?,
    status: TurnTerminalStatus?,
    muted: Color,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxWidth()) {
        if (status?.errorText != null) {
            Text(
                status.errorText,
                color = muted,
                fontSize = 11.sp,
            )
            Spacer(Modifier.height(2.dp))
        }
        AiMessageActions(
            item = item,
            controller = controller,
            status = status,
            muted = muted,
        )
    }
}

@Composable
internal fun AiMessageActions(
    item: ChatItem?,
    controller: SessionController?,
    status: TurnTerminalStatus?,
    muted: Color,
    modifier: Modifier = Modifier,
) {
    var showReportDialog by remember { mutableStateOf(false) }
    // Copy classification for the turn footer:
    // - a turn with answer body copies the whole turn text;
    // - a turn without body but with a terminal error/log copies that error text;
    // - otherwise (e.g. stopped with no output and no error) no copy button shows.
    val errorCopyText = status?.errorText?.takeIf { it.isNotBlank() }
    val copyText: (() -> String)? = when {
        item != null && item.text.isNotBlank() && controller != null -> ({ controller.turnAgentText(item) })
        errorCopyText != null -> ({ errorCopyText })
        else -> null
    }
    val timestamp = status?.timestamp ?: item?.createdAt ?: 0L

    // Single row layout: copy + timestamp
    Row(
        modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Start,
    ) {
        if (copyText != null) {
            CopyActionButtons(copyText, muted)
            Spacer(Modifier.width(8.dp))
        }
        // Timestamp - always visible. On hover, the relative time ("13分钟前")
        // crossfades into the full timestamp ("2026-10-20 20:05:47") in place;
        // the Box is sized to the wider of the two so the swap never shifts layout.
        if (timestamp > 0) {
            val timestampInteractionSource = remember { MutableInteractionSource() }
            val timestampHovered by timestampInteractionSource.collectIsHoveredAsState()
            // Debounce hover: 300ms delay before showing full timestamp so quick
            // mouse passes don't flicker; exit is immediate.
            var hoverDebounced by remember { mutableStateOf(false) }
            LaunchedEffect(timestampHovered) {
                if (timestampHovered) {
                    delay(300L)
                    hoverDebounced = true
                } else {
                    hoverDebounced = false
                }
            }
            var tick by remember { mutableStateOf(0) }

            LaunchedEffect(timestamp) {
                while (true) {
                    delay(60_000L)
                    tick++
                }
            }

            // Keyed on tick so the relative time re-formats every minute; reading
            // tick here (not as a bare statement) registers the snapshot read.
            val now = remember(tick) { System.currentTimeMillis() }

            val timeText = if (status != null) {
                MessageTimeFormatter.formatWithStatus(timestamp, status.status, now)
            } else {
                MessageTimeFormatter.format(timestamp, now)
            }
            val hoverText = if (status != null) {
                MessageTimeFormatter.formatHoverWithStatus(timestamp, status.status)
            } else {
                MessageTimeFormatter.formatHover(timestamp)
            }

            // Crossfade alpha: 0 = relative time, 1 = full timestamp.
            val hoverAlpha by animateFloatAsState(
                targetValue = if (hoverDebounced) 1f else 0f,
                animationSpec = tween(durationMillis = 150),
                label = "timestampHoverAlpha",
            )

            // IntrinsicSize.Max reserves the width of the wider of the two texts,
            // so the Row layout never shifts when the displayed text changes.
            Box(
                modifier = Modifier
                    .width(IntrinsicSize.Max)
                    .height(DevEcoTheme.actionButtonSize.dp)
                    .hoverable(timestampInteractionSource),
                contentAlignment = Alignment.CenterStart,
            ) {
                Text(
                    timeText,
                    color = muted.copy(alpha = DevEcoTheme.mutedActionAlpha),
                    fontSize = 11.sp,
                    fontFamily = FontFamily.SansSerif,
                    modifier = Modifier
                        .fillMaxHeight()
                        .wrapContentHeight(Alignment.CenterVertically)
                        .graphicsLayer { alpha = 1f - hoverAlpha },
                )
                Text(
                    hoverText,
                    color = muted.copy(alpha = DevEcoTheme.mutedActionAlpha),
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier
                        .fillMaxHeight()
                        .wrapContentHeight(Alignment.CenterVertically)
                        .graphicsLayer { alpha = hoverAlpha },
                )
            }
        }
        // FeedbackActionButtons (like/dislike/report) hidden — keeping layout intact.
    }

    if (showReportDialog && item != null && controller != null) {
        ReportDialog(
            onDismiss = { showReportDialog = false },
            onSubmit = { reason ->
                controller.reportMessage(item.id, reason)
                showReportDialog = false
            },
        )
    }
}

@Composable
private fun CopyActionButtons(
    copyText: () -> String,
    muted: Color,
) {
    val clipboardManager = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }

    ActionButton(
        onClick = {
            clipboardManager.setText(AnnotatedString(copyText()))
            copied = true
        },
        tint = muted.copy(alpha = DevEcoTheme.mutedActionAlpha),
        hoverTint = DevEcoTheme.linkAccent,
        hoverBackground = DevEcoTheme.copyActionHoverBackground,
        tooltipText = MyMessageBundle.message("message.tooltip.copy"),
    ) { _ ->
        if (copied) {
            Icon(
                key = CheckmarkIconKey,
                contentDescription = "Copied",
                tint = DevEcoTheme.green,
                modifier = Modifier.size(DevEcoTheme.actionIconSize.dp),
            )
        } else {
            Icon(
                key = DevEcoIcons.iconKey("copy"),
                contentDescription = "Copy",
                modifier = Modifier.size(DevEcoTheme.actionIconSize.dp),
            )
        }
    }

    LaunchedEffect(copied) {
        if (copied) {
            delay(COPIED_INDICATOR_MS)
            copied = false
        }
    }
}

@Composable
private fun FeedbackActionButtons(
    item: ChatItem,
    controller: SessionController,
    muted: Color,
    enabled: Boolean,
    onReport: () -> Unit,
) {
    var liked by remember { mutableStateOf(false) }
    var disliked by remember { mutableStateOf(false) }

    ActionButton(
        onClick = {
            liked = !liked
            if (liked) disliked = false
            controller.submitFeedback(item.id, if (liked) "like" else null)
        },
        tint = if (liked) DevEcoTheme.linkAccent else muted.copy(alpha = DevEcoTheme.mutedActionAlpha),
        hoverTint = DevEcoTheme.linkAccent,
        enabled = enabled,
        tooltipText = MyMessageBundle.message("message.tooltip.like"),
    ) { _ ->
        Icon(
            key = if (liked) DevEcoIcons.iconKey("like-active") else DevEcoIcons.iconKey("like"),
            contentDescription = "Like",
            modifier = Modifier.size(DevEcoTheme.actionIconSize.dp),
        )
    }
    Spacer(Modifier.width(DevEcoTheme.actionSpacing.dp))
    ActionButton(
        onClick = {
            disliked = !disliked
            if (disliked) liked = false
            controller.submitFeedback(item.id, if (disliked) "dislike" else null)
        },
        tint = if (disliked) DevEcoTheme.danger else muted.copy(alpha = DevEcoTheme.mutedActionAlpha),
        hoverTint = DevEcoTheme.danger,
        enabled = enabled,
        tooltipText = MyMessageBundle.message("message.tooltip.dislike"),
    ) { _ ->
        Icon(
            key = if (disliked) DevEcoIcons.iconKey("dislike-active") else DevEcoIcons.iconKey("dislike"),
            contentDescription = "Dislike",
            modifier = Modifier.size(DevEcoTheme.actionIconSize.dp),
        )
    }
    Spacer(Modifier.width(DevEcoTheme.actionSpacing.dp))
    ActionButton(
        onClick = onReport,
        tint = muted.copy(alpha = DevEcoTheme.mutedActionAlpha),
        hoverTint = DevEcoTheme.danger,
        enabled = enabled,
        tooltipText = MyMessageBundle.message("message.tooltip.report"),
    ) { _ ->
        Icon(
            key = DevEcoIcons.iconKey("warn"),
            contentDescription = "Report",
            modifier = Modifier.size(DevEcoTheme.actionIconSize.dp),
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun ActionButton(
    onClick: () -> Unit,
    tint: Color,
    hoverTint: Color,
    enabled: Boolean = true,
    tooltipText: String? = null,
    hoverBackground: Color? = null,
    content: @Composable (Color) -> Unit,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val hovered by interactionSource.collectIsHoveredAsState()
    val bgColor = if (enabled && hovered) (hoverBackground ?: hoverTint.copy(alpha = 0.12f)) else Color.Transparent
    val contentColor = when {
        !enabled -> tint.copy(alpha = 0.4f)
        hovered -> hoverTint
        else -> tint
    }
    val button = @Composable {
        Box(
            Modifier
                .size(DevEcoTheme.actionButtonSize.dp)
                .clip(RoundedCornerShape(DevEcoTheme.actionButtonRadius.dp))
                .background(bgColor)
                .hoverable(interactionSource, enabled = enabled)
                .clickable(
                    enabled = enabled,
                    interactionSource = interactionSource,
                    indication = null,
                ) {
                    onClick()
                },
            contentAlignment = Alignment.Center,
        ) {
            content(contentColor)
        }
    }
    // Platform-native tooltip: Jewel's IntUi bridge feeds it the IDE's own show
    // delays, ToolTip.* colors and corner radius, so timing, placement and look
    // match the Swing tooltips elsewhere in the IDE.
    if (enabled && tooltipText != null) {
        Tooltip(tooltip = { Text(tooltipText, fontSize = 12.sp) }) { button() }
    } else {
        button()
    }
}

@Composable
private fun ReportDialog(
    onDismiss: () -> Unit,
    onSubmit: (String) -> Unit,
) {
    val reasons = listOf(
        MyMessageBundle.message("message.report.reason1"),
        MyMessageBundle.message("message.report.reason2"),
        MyMessageBundle.message("message.report.reason3"),
        MyMessageBundle.message("message.report.reason4"),
        MyMessageBundle.message("message.report.reason5"),
    )
    var selectedReason by remember { mutableStateOf(reasons[0]) }

    Box(
        Modifier.fillMaxWidth()
            .background(DevEcoTheme.popupBackground, RoundedCornerShape(8.dp))
            .border(1.dp, DevEcoTheme.popupBorder, RoundedCornerShape(8.dp))
            .padding(16.dp),
    ) {
        Column {
            Text(
                MyMessageBundle.message("message.report.title"),
                color = DevEcoTheme.onAccent,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                fontFamily = FontFamily.SansSerif,
            )
            Spacer(Modifier.height(12.dp))
            ReasonList(reasons, selectedReason) { selectedReason = it }
            Spacer(Modifier.height(16.dp))
            ReportDialogButtons(
                onCancel = onDismiss,
                onSubmit = { onSubmit(selectedReason) },
            )
        }
    }
}

@Composable
private fun ReasonList(
    reasons: List<String>,
    selectedReason: String,
    onSelect: (String) -> Unit,
) {
    reasons.forEach { reason ->
        ReasonItem(
            reason = reason,
            isSelected = selectedReason == reason,
            onSelect = { onSelect(reason) },
        )
        Spacer(Modifier.height(2.dp))
    }
}

@Composable
private fun ReasonItem(
    reason: String,
    isSelected: Boolean,
    onSelect: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(6.dp))
            .background(if (isSelected) DevEcoTheme.dropdownSelected else Color.Transparent)
            .clickable(onClick = onSelect)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(14.dp)
                .clip(RoundedCornerShape(7.dp))
                .background(if (isSelected) DevEcoTheme.linkAccent else DevEcoTheme.popupBorder),
            contentAlignment = Alignment.Center,
        ) {
            if (isSelected) {
                Icon(
                    key = CheckmarkIconKey,
                    contentDescription = null,
                    modifier = Modifier.size(12.dp),
                )
            }
        }
        Spacer(Modifier.width(10.dp))
        Text(
            reason,
            color = if (isSelected) DevEcoTheme.onAccent else DevEcoTheme.mutedGray,
            fontSize = 12.sp,
            fontFamily = FontFamily.SansSerif,
        )
    }
}

@Composable
private fun ReportDialogButtons(
    onCancel: () -> Unit,
    onSubmit: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.End,
    ) {
        Box(
            Modifier.clip(RoundedCornerShape(6.dp))
                .background(DevEcoTheme.popupBorder)
                .clickable(onClick = onCancel)
                .padding(horizontal = 14.dp, vertical = 6.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                MyMessageBundle.message("message.report.cancel"),
                color = DevEcoTheme.mutedGray,
                fontSize = 12.sp,
                fontFamily = FontFamily.SansSerif,
            )
        }
        Spacer(Modifier.width(8.dp))
        Box(
            Modifier.clip(RoundedCornerShape(6.dp))
                .background(DevEcoTheme.linkAccent)
                .clickable(onClick = onSubmit)
                .padding(horizontal = 14.dp, vertical = 6.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                MyMessageBundle.message("message.report.submit"),
                color = DevEcoTheme.onAccent,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                fontFamily = FontFamily.SansSerif,
            )
        }
    }
}
