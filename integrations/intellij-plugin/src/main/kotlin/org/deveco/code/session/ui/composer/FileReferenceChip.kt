package org.deveco.code.session.ui.composer

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import kotlinx.coroutines.delay
import org.deveco.code.DevEcoTheme
import org.deveco.code.session.model.FileReference
import org.deveco.code.session.ui.messages.FileIcon
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.icons.AllIconsKeys

private object AboveChipTooltipProvider : PopupPositionProvider {
    override fun calculatePosition(
        anchorBounds: IntRect,
        windowSize: IntSize,
        layoutDirection: LayoutDirection,
        popupContentSize: IntSize,
    ): IntOffset {
        val x = anchorBounds.left
        val y = maxOf(0, anchorBounds.top - popupContentSize.height - 4)
        return IntOffset(x, y)
    }
}

/**
 * Container for file reference chips with a shared tooltip.
 * Tooltip state is held at this level so individual chips don't recompose
 * when hover changes, preventing layout jitter in FlowRow.
 */
@Composable
internal fun FileReferenceChipRow(
    fileRefs: List<FileReference>,
    onRemove: (FileReference) -> Unit,
    onClick: (FileReference) -> Unit,
    modifier: Modifier = Modifier,
) {
    var hoveredRef by remember { mutableStateOf<FileReference?>(null) }
    var hoveredBounds by remember { mutableStateOf(IntRect.Zero) }
    var showTooltip by remember { mutableStateOf(false) }

    LaunchedEffect(hoveredRef) {
        if (hoveredRef != null) {
            delay(400)
            showTooltip = hoveredRef != null
        } else {
            showTooltip = false
        }
    }

    FlowRow(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        fileRefs.forEach { fileRef ->
            ChipWithHover(
                fileRef = fileRef,
                onHover = { isHover, bounds ->
                    if (isHover) {
                        hoveredRef = fileRef
                        hoveredBounds = bounds
                    } else if (hoveredRef == fileRef) {
                        hoveredRef = null
                    }
                },
                onRemove = { onRemove(fileRef) },
                onClick = { onClick(fileRef) },
            )
        }
    }

    if (showTooltip && hoveredRef != null) {
        val tooltipBounds = hoveredBounds
        val positionProvider = remember(tooltipBounds) {
            object : PopupPositionProvider {
                override fun calculatePosition(
                    anchorBounds: IntRect,
                    windowSize: IntSize,
                    layoutDirection: LayoutDirection,
                    popupContentSize: IntSize,
                ): IntOffset {
                    val x = tooltipBounds.left
                    val y = maxOf(0, tooltipBounds.top - popupContentSize.height - 4)
                    return IntOffset(x, y)
                }
            }
        }
        Popup(
            popupPositionProvider = positionProvider,
            onDismissRequest = {},
            properties = PopupProperties(focusable = false),
        ) {
            Text(
                text = hoveredRef!!.path,
                color = DevEcoTheme.tooltipForeground,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier
                    .background(DevEcoTheme.tooltipBackground, RoundedCornerShape(4.dp))
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            )
        }
    }
}

/**
 * A single chip with hover tracking. Hover state is reported to the parent
 * via callback instead of being held locally, so the chip's own composition
 * is not invalidated when hover changes.
 */
@Composable
private fun ChipWithHover(
    fileRef: FileReference,
    onHover: (Boolean, IntRect) -> Unit,
    onRemove: () -> Unit,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val hovered by interactionSource.collectIsHoveredAsState()

    LaunchedEffect(hovered) {
        onHover(hovered, IntRect.Zero)
    }

    ChipContent(
        fileRef = fileRef,
        interactionSource = interactionSource,
        onRemove = onRemove,
        onClick = onClick,
        modifier = modifier.onGloballyPositioned { coordinates ->
            if (hovered) {
                val pos = coordinates.positionInWindow()
                val size = coordinates.size
                onHover(true, IntRect(pos.x.toInt(), pos.y.toInt(), pos.x.toInt() + size.width, pos.y.toInt() + size.height))
            }
        },
    )
}

/**
 * Stateless chip content. Has no hover state of its own, so it never
 * recomposes due to hover changes.
 */
@Composable
private fun ChipContent(
    fileRef: FileReference,
    interactionSource: MutableInteractionSource,
    onRemove: () -> Unit,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val backgroundColor = Color(0x0DFFFFFF)

    Row(
        modifier = modifier
            .clip(RoundedCornerShape(6.dp))
            .background(backgroundColor)
            .hoverable(interactionSource)
            .clickable(interactionSource = interactionSource, indication = null) { onClick() }
            .padding(horizontal = 8.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FileIcon(filePath = fileRef.path, modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(6.dp))
        Text(
            text = fileRef.fileName,
            color = Color(0xFF94A3B8),
            fontSize = 12.sp,
            fontFamily = FontFamily.Monospace,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 180.dp),
        )
        if (fileRef.hasLineRange) {
            Spacer(Modifier.width(6.dp))
            Text(
                text = fileRef.lineRange,
                color = Color(0xFF64748B),
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
            )
        }
        Spacer(Modifier.width(4.dp))
        Box(
            modifier = Modifier
                .size(14.dp)
                .clip(RoundedCornerShape(3.dp))
                .clickable { onRemove() },
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                key = AllIconsKeys.Actions.Close,
                contentDescription = "Remove file reference",
                modifier = Modifier.size(10.dp),
                tint = Color(0xFF64748B),
            )
        }
    }
}

/**
 * Standalone chip with its own tooltip. Used in read-only contexts
 * (e.g. message history) where there's no FlowRow-level shared tooltip.
 */
@Composable
internal fun FileReferenceChip(
    fileRef: FileReference,
    onRemove: () -> Unit,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val isHovered by interactionSource.collectIsHoveredAsState()
    var showTooltip by remember { mutableStateOf(false) }

    LaunchedEffect(isHovered) {
        if (isHovered) {
            delay(400)
            showTooltip = true
        } else {
            showTooltip = false
        }
    }

    ChipContent(
        fileRef = fileRef,
        interactionSource = interactionSource,
        onRemove = onRemove,
        onClick = onClick,
        modifier = modifier,
    )

    if (showTooltip) {
        Popup(
            popupPositionProvider = AboveChipTooltipProvider,
            onDismissRequest = {},
            properties = PopupProperties(focusable = false),
        ) {
            Text(
                text = fileRef.path,
                color = DevEcoTheme.tooltipForeground,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier
                    .background(DevEcoTheme.tooltipBackground, RoundedCornerShape(4.dp))
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            )
        }
    }
}
