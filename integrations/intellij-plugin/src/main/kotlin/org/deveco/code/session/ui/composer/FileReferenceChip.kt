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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.intellij.openapi.ui.popup.JBPopup
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.util.text.StringUtil
import com.intellij.ui.awt.RelativePoint
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Font
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.MouseInfo
import java.awt.Point
import java.awt.RenderingHints
import java.awt.geom.RoundRectangle2D
import javax.swing.JPanel
import kotlinx.coroutines.delay
import org.deveco.code.DevEcoTheme
import org.deveco.code.session.model.FileReference
import org.deveco.code.session.ui.messages.FileIcon
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.icons.AllIconsKeys

private const val TOOLTIP_DELAY_MS = 400L
private const val CURSOR_OFFSET_PX = 12
private const val TOOLTIP_HEIGHT_PX = 32
private const val TOOLTIP_CORNER_PX = 4
// Monospaced 11px cap so a deep path can't make the popup wider than the
// screen — the platform fits an oversized popup's position but not its size.
// trimMiddle keeps head and tail, which is what makes a path recognizable.
private const val TOOLTIP_MAX_CHARS = 90

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
    trailing: @Composable FlowRowScope.() -> Unit = {},
) {
    var hoveredRef by remember { mutableStateOf<FileReference?>(null) }
    var showTooltip by remember { mutableStateOf(false) }
    // Plain holder, not mutableStateOf: nothing reads the popup during
    // composition, so snapshot writes would only cause useless recompositions.
    val tooltipPopup = remember { arrayOfNulls<JBPopup>(1) }

    LaunchedEffect(hoveredRef) {
        showTooltip = false
        if (hoveredRef == null) return@LaunchedEffect
        delay(TOOLTIP_DELAY_MS)
        showTooltip = true
    }

    // A chip removed while hovered (X click) leaves the composition without a
    // hover-exit callback, stranding hoveredRef — drop it so the popup cancels.
    LaunchedEffect(fileRefs) {
        val hovered = hoveredRef
        if (hovered != null && fileRefs.none { it == hovered }) hoveredRef = null
    }

    // The tooltip lives in the Swing popup layer so long paths can extend past
    // the tool window panel, which clips everything drawn inside Compose.
    // It anchors to the cursor position at show time and never follows it.
    LaunchedEffect(showTooltip, hoveredRef) {
        tooltipPopup[0]?.cancel()
        tooltipPopup[0] = null
        if (!showTooltip || hoveredRef == null) return@LaunchedEffect
        // getPointerInfo() is null when no screen reports the cursor (headless,
        // monitor unplugged mid-hover) — skip the tooltip instead of NPE-ing.
        val cursor = MouseInfo.getPointerInfo()?.location ?: return@LaunchedEffect
        val popup = createPathTooltip(hoveredRef!!.path)
        tooltipPopup[0] = popup
        popup.show(RelativePoint(Point(cursor.x + CURSOR_OFFSET_PX, cursor.y + CURSOR_OFFSET_PX)))
    }

    DisposableEffect(Unit) {
        onDispose { tooltipPopup[0]?.cancel() }
    }

    FlowRow(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        fileRefs.forEach { fileRef ->
            ChipWithHover(
                fileRef = fileRef,
                onHover = { isHover ->
                    if (isHover) {
                        hoveredRef = fileRef
                    } else if (hoveredRef == fileRef) {
                        hoveredRef = null
                    }
                },
                onRemove = { onRemove(fileRef) },
                onClick = { onClick(fileRef) },
            )
        }
        trailing()
    }
}

/**
 * Swing-layer tooltip so the path can extend beyond the tool window panel,
 * which clips everything drawn inside the Compose hierarchy.
 */
private fun createPathTooltip(path: String): JBPopup {
    val label = JBLabel(StringUtil.trimMiddle(path, TOOLTIP_MAX_CHARS)).apply {
        font = Font(Font.MONOSPACED, Font.PLAIN, JBUI.scaleFontSize(11f))
        foreground = DevEcoTheme.tooltipForeground
        border = JBUI.Borders.empty(0, 8)
    }
    val content = object : JPanel(BorderLayout()) {
        init {
            isOpaque = false
            add(label, BorderLayout.CENTER)
            preferredSize = JBUI.size(label.preferredSize.width + 1, JBUI.scale(TOOLTIP_HEIGHT_PX))
        }

        override fun paintComponent(g: Graphics) {
            val g2 = g.create() as Graphics2D
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            g2.color = DevEcoTheme.tooltipBackground
            val arc = JBUI.scale(TOOLTIP_CORNER_PX) * 2f
            g2.fill(RoundRectangle2D.Float(0f, 0f, width.toFloat(), height.toFloat(), arc, arc))
            g2.dispose()
        }
    }
    return JBPopupFactory.getInstance()
        .createComponentPopupBuilder(content, null)
        .setFocusable(false)
        .setRequestFocus(false)
        .setCancelKeyEnabled(false)
        .setShowShadow(false)
        .setShowBorder(false)
        .setMaskProvider { dimension ->
            val arc = JBUI.scale(TOOLTIP_CORNER_PX) * 2f
            RoundRectangle2D.Float(0f, 0f, dimension.width.toFloat(), dimension.height.toFloat(), arc, arc)
        }
        .createPopup()
}

/**
 * A single chip with hover tracking. Hover state is reported to the parent
 * via callback instead of being held locally, so the chip's own composition
 * is not invalidated when hover changes.
 */
@Composable
private fun ChipWithHover(
    fileRef: FileReference,
    onHover: (Boolean) -> Unit,
    onRemove: () -> Unit,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val hovered by interactionSource.collectIsHoveredAsState()

    LaunchedEffect(hovered) {
        onHover(hovered)
    }

    ChipContent(
        fileRef = fileRef,
        interactionSource = interactionSource,
        onRemove = onRemove,
        onClick = onClick,
        modifier = modifier,
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
    val backgroundColor = DevEcoTheme.fileRefChipBg

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
