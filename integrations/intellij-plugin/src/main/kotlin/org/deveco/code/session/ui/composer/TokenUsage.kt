package org.deveco.code.session.ui.composer

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.font.FontWeight
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
import com.intellij.ui.JBColor
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.deveco.code.session.SessionController
import org.jetbrains.jewel.bridge.toComposeColor
import org.jetbrains.jewel.ui.component.Text

private const val TOOLTIP_HIDE_DELAY_MS = 300L
private val RING_SIZE = 16.dp
private val RING_STROKE = 3.dp

@OptIn(ExperimentalTextApi::class)
@Composable
internal fun TokenUsageRing(
    controller: SessionController,
    muted: Color,
    textColor: Color,
    caretColor: Color,
    borderColor: Color,
    composerBounds: IntRect,
) {
    val used = controller.usedTokens
    val threshold = controller.tokenThreshold

    val ratio = (used.toFloat() / threshold.toFloat()).coerceIn(0f, 1f)
    val percentStr = String.format("%.1f", ratio * 100)

    val baseRingColor = DevEcoTheme.muted.copy(alpha = 0.1f)
    val progressRingColor = if (ratio >= 1f) DevEcoTheme.warning else DevEcoTheme.foreground.copy(alpha = 0.6f)

    val interactionSource = remember { MutableInteractionSource() }
    val hovered by interactionSource.collectIsHoveredAsState()
    val popupInteractionSource = remember { MutableInteractionSource() }
    val popupHovered by popupInteractionSource.collectIsHoveredAsState()
    var showPopup by remember { mutableStateOf(false) }

    LaunchedEffect(hovered, popupHovered) {
        if (hovered || popupHovered) {
            showPopup = true
        } else {
            delay(TOOLTIP_HIDE_DELAY_MS)
            showPopup = false
        }
    }

    Box(
        Modifier
            .size(RING_SIZE)
            .hoverable(interactionSource),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val strokePx = RING_STROKE.toPx()
            val arcDim = size.minDimension - strokePx
            val topLeft = Offset((size.width - arcDim) / 2, (size.height - arcDim) / 2)
            drawArc(
                color = baseRingColor,
                startAngle = 0f, sweepAngle = 360f, useCenter = false,
                topLeft = topLeft, size = Size(arcDim, arcDim),
                style = Stroke(width = strokePx, cap = StrokeCap.Round),
            )
            if (ratio > 0f) {
                drawArc(
                    color = progressRingColor,
                    startAngle = -90f, sweepAngle = 360f * ratio, useCenter = false,
                    topLeft = topLeft, size = Size(arcDim, arcDim),
                    style = Stroke(width = strokePx, cap = StrokeCap.Round),
                )
            }
        }
    }

    if (showPopup) {
        TokenUsageTooltip(
            used = used,
            threshold = threshold,
            percentStr = percentStr,
            muted = muted,
            popupInteractionSource = popupInteractionSource,
            onDismiss = { showPopup = false },
        )
    }
}

@Composable
private fun TokenUsageTooltip(
    used: Long,
    threshold: Long,
    percentStr: String,
    muted: Color,
    popupInteractionSource: MutableInteractionSource,
    onDismiss: () -> Unit,
) {
    val isLightTheme = DevEcoTheme.panel.luminance() >= 0.5f
    
    Popup(
        popupPositionProvider = TooltipAboveLeftProvider,
        onDismissRequest = onDismiss,
        properties = PopupProperties(focusable = false),
    ) {
        Column(
            Modifier
                .hoverable(popupInteractionSource)
                .widthIn(max = 240.dp)
                .tokenUsageCardShadow(RoundedCornerShape(6.dp), isLightTheme)
                .clip(RoundedCornerShape(6.dp))
                .background(JBColor(0xF2F2F2, 0x2B2D30).toComposeColor())
                .border(1.dp, DevEcoTheme.popupBorder, RoundedCornerShape(6.dp))
                .padding(horizontal = 10.dp, vertical = 8.dp),
        ) {
            Text(
                MyMessageBundle.message("token.usage.title"),
                color = muted, fontSize = 11.sp, fontWeight = FontWeight.Medium,
            )
            Spacer(Modifier.height(4.dp))
            Row(
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "$percentStr%",
                    color = muted, fontSize = 11.sp,
                )
                Spacer(Modifier.width(12.dp))
                Text(
                    "${formatK(used)} / ${formatK(threshold, preferInteger = true)}",
                    color = muted, fontSize = 11.sp,
                )
            }
        }
    }
}

private fun formatK(tokens: Long, preferInteger: Boolean = false): String {
    val k = tokens / 1000.0
    return if (preferInteger && k == k.toInt().toDouble()) "${k.toInt()}K" else String.format("%.1fK", k)
}


private object TooltipAboveLeftProvider : PopupPositionProvider {
    override fun calculatePosition(
        anchorBounds: IntRect,
        windowSize: IntSize,
        layoutDirection: LayoutDirection,
        popupContentSize: IntSize,
    ): IntOffset {
        val x = anchorBounds.left + anchorBounds.width
        val y = anchorBounds.top - popupContentSize.height - 4
        return IntOffset(maxOf(0, x), maxOf(0, y))
    }
}
