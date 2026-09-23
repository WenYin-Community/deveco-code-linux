package org.deveco.code.session.ui.messages

import org.deveco.code.SmallSpinner

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
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import androidx.compose.ui.window.PopupPositionProvider
import kotlinx.coroutines.delay
import org.deveco.code.DevEcoIcons
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.deveco.code.session.SessionController
import org.deveco.code.session.model.ChatItem
import org.jetbrains.jewel.markdown.Markdown
import org.jetbrains.jewel.markdown.extensions.LocalMarkdownBlockRenderer
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.icon.PathIconKey
import org.jetbrains.jewel.ui.icons.AllIconsKeys

private val WarningIconKey = PathIconKey("/icons/warning.svg", DevEcoTheme::class.java)
private val CheckmarkIconKey = PathIconKey("/icons/checkmark.svg", DevEcoTheme::class.java)
private const val COPIED_INDICATOR_MS = 2000L

@Composable
internal fun AgentMessage(
    item: ChatItem,
    muted: Color,
    controller: SessionController?,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val isHovered by interactionSource.collectIsHoveredAsState()

    Column(
        Modifier.fillMaxWidth()
            .hoverable(interactionSource),
    ) {
        if (item.text.isNotBlank()) {
            MarkdownWithCodeBlocks(
                text = item.text,
                modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
            )
        } else {
            // Placeholder when agent has no text yet (e.g. during tool-calling phase)
            Row(
                Modifier.fillMaxWidth().padding(vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    key = AllIconsKeys.General.Information,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    MyMessageBundle.message("session.status.responding"),
                    color = muted,
                    fontSize = 12.sp,
                )
            }
        }
        if (item.interrupted) {
            Box(
                Modifier.fillMaxWidth().padding(vertical = 6.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    MyMessageBundle.message("session.error.cancelled"),
                    color = muted,
                    fontSize = 11.sp,
                )
            }
        }
        if (controller != null && item.isComplete) {
            AiMessageActions(
                item = item,
                controller = controller,
                muted = muted,
                enabled = !controller.responding,
                isHovered = isHovered,
            )
        }
    }
}

@Composable
internal fun AiMessageActions(
    item: ChatItem,
    controller: SessionController,
    muted: Color,
    enabled: Boolean,
    isHovered: Boolean,
) {
    var showReportDialog by remember { mutableStateOf(false) }

    val showDuration = item.duration > 0 && item.isComplete
    val showTimeInfo = isHovered && item.isComplete
    val infoAlpha by animateFloatAsState(
        targetValue = if (showTimeInfo) 1f else 0f,
        animationSpec = tween(durationMillis = 150),
        label = "infoAlpha",
    )

    // Single row layout: disclaimer + duration + timestamp + buttons
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        // Left side: warning + duration
        Row(
            modifier = Modifier.weight(1f),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AiMessageWarning(muted)
            Spacer(Modifier.width(12.dp))
            // Show duration from the item itself (each message stores its own duration)
            if (showDuration) {
                Text(
                    MyMessageBundle.message("message.duration", formatDuration(item.duration)),
                    color = muted.copy(alpha = DevEcoTheme.mutedActionAlpha),
                    fontSize = 11.sp,
                    fontFamily = FontFamily.SansSerif,
                    modifier = Modifier.graphicsLayer { alpha = infoAlpha },
                )
            }
        }
        // Right side: timestamp + action buttons
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.End,
        ) {
            // Timestamp - visible only on hover
            if (item.createdAt > 0) {
                Text(
                    MessageTimeFormatter.format(item.createdAt),
                    color = muted.copy(alpha = DevEcoTheme.mutedActionAlpha),
                    fontSize = 11.sp,
                    fontFamily = FontFamily.SansSerif,
                    modifier = Modifier.graphicsLayer { alpha = infoAlpha },
                )
                Spacer(Modifier.width(12.dp))
            }
            RegenerateActionButton(item, controller, muted, enabled)
            Spacer(Modifier.width(DevEcoTheme.actionSpacing.dp))
            CopyActionButtons(item, muted, enabled)
            // FeedbackActionButtons (like/dislike/report) hidden — keeping layout intact.
        }
    }

    if (showReportDialog) {
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
private fun AiMessageWarning(muted: Color, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            key = WarningIconKey,
            contentDescription = "Warning",
            modifier = Modifier.size(DevEcoTheme.actionIconSize.dp),
        )
        Spacer(Modifier.width(6.dp))
        Text(
            MyMessageBundle.message("message.aiDisclaimer"),
            color = muted.copy(alpha = DevEcoTheme.mutedActionAlpha),
            fontSize = 11.sp,
            fontFamily = FontFamily.SansSerif,
        )
    }
}

@Composable
private fun RegenerateActionButton(
    item: ChatItem,
    controller: SessionController,
    muted: Color,
    enabled: Boolean,
) {
    var isRegenerating by remember { mutableStateOf(false) }
    ActionButton(
        onClick = {
            isRegenerating = true
            controller.regenerateMessage(item)
            isRegenerating = false
        },
        tint = if (isRegenerating) DevEcoTheme.linkAccent else muted.copy(alpha = DevEcoTheme.mutedActionAlpha),
        hoverTint = DevEcoTheme.linkAccent,
        enabled = enabled,
        tooltipText = MyMessageBundle.message("message.tooltip.regenerate"),
    ) { _ ->
        if (isRegenerating) {
            SmallSpinner(
                size = DevEcoTheme.actionIconSize.dp,
                color = DevEcoTheme.loadingIndicatorColor,
            )
        } else {
            Icon(
                key = DevEcoIcons.iconKey("refresh"),
                contentDescription = "Regenerate",
                modifier = Modifier.size(DevEcoTheme.actionIconSize.dp),
            )
        }
    }
}

@Composable
private fun CopyActionButtons(
    item: ChatItem,
    muted: Color,
    enabled: Boolean,
) {
    val clipboardManager = LocalClipboardManager.current

    ActionButton(
        onClick = {
            clipboardManager.setText(AnnotatedString(item.text))
        },
        tint = muted.copy(alpha = DevEcoTheme.mutedActionAlpha),
        hoverTint = DevEcoTheme.linkAccent,
        enabled = enabled,
        tooltipText = MyMessageBundle.message("message.tooltip.copy"),
    ) { _ ->
        Icon(
            key = DevEcoIcons.iconKey("copy"),
            contentDescription = "Copy",
            modifier = Modifier.size(DevEcoTheme.actionIconSize.dp),
        )
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

@Composable
private fun ActionButton(
    onClick: () -> Unit,
    tint: Color,
    hoverTint: Color,
    enabled: Boolean = true,
    tooltipText: String? = null,
    content: @Composable (Color) -> Unit,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val hovered by interactionSource.collectIsHoveredAsState()
    val bgColor = if (enabled && hovered) hoverTint.copy(alpha = 0.12f) else Color.Transparent
    val contentColor = when {
        !enabled -> tint.copy(alpha = 0.4f)
        hovered -> hoverTint
        else -> tint
    }
    val showTooltip = enabled && hovered && tooltipText != null

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

    if (showTooltip) {
        TooltipPopup(tooltipText!!)
    }
}

@Composable
private fun TooltipPopup(text: String) {
    Popup(
        popupPositionProvider = TooltipPositionProvider,
        properties = PopupProperties(focusable = false),
    ) {
        Box(
            Modifier
                .clip(RoundedCornerShape(4.dp))
                .background(DevEcoTheme.actionTooltipBackground)
                .border(1.dp, DevEcoTheme.popupBorder, RoundedCornerShape(4.dp))
                .padding(horizontal = 8.dp, vertical = 4.dp),
        ) {
            Text(
                text = text,
                color = DevEcoTheme.actionTooltipForeground,
                fontSize = 11.sp,
                fontFamily = FontFamily.SansSerif,
            )
        }
    }
}

private object TooltipPositionProvider : PopupPositionProvider {
    override fun calculatePosition(
        anchorBounds: IntRect,
        windowSize: IntSize,
        layoutDirection: LayoutDirection,
        popupContentSize: IntSize,
    ): IntOffset {
        val x = anchorBounds.left + anchorBounds.width / 2 - popupContentSize.width / 2
        val y = anchorBounds.top - popupContentSize.height - 6
        return IntOffset(
            x.coerceIn(0, windowSize.width - popupContentSize.width),
            y.coerceAtLeast(0),
        )
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
