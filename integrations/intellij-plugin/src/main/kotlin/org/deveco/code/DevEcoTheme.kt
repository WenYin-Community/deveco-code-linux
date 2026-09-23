package org.deveco.code

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.intellij.ui.JBColor
import org.jetbrains.jewel.bridge.toComposeColor

object DevEcoTheme {
    val panel: Color get() = JBColor.namedColor("Panel.background", 0xF7F8FA).toComposeColor()
    val muted: Color get() = JBColor.namedColor("Label.infoForeground", 0x6C707E).toComposeColor()
    val accent: Color get() = JBColor.namedColor("Component.accentColor", 0x3574F0).toComposeColor()
    val foreground: Color get() = JBColor.namedColor("Label.foreground", 0xDFE1E5).toComposeColor()
    val hover: Color get() = JBColor.namedColor("List.hoverBackground", 0xEDF3FF).toComposeColor()
    val selectedBg: Color get() = JBColor.namedColor("List.selectionInactiveBackground", 0xDFE7F5).toComposeColor()
    val titleFg: Color get() = JBColor(0x6C707E, 0x555861).toComposeColor()
    val subtleOverlay: Color get() = JBColor(0xECEEF1, 0x343438).toComposeColor()
    val lightOverlay: Color get() = JBColor(0xDEE1E8, 0x3A3D44).toComposeColor()
    val mutedOverlay: Color get() = JBColor(0x6C707E, 0xABAFB6).toComposeColor()
    val cardFg: Color get() = JBColor(0x1E1F22, 0xFFFFFF).toComposeColor()
    val pressedAccent: Color get() = Color(0xFF317AF7)
    val green: Color get() = JBColor(0x2E7D32, 0x66BB6A).toComposeColor()
    val red: Color get() = JBColor(0xC62828, 0xEF5350).toComposeColor()
    val linkAccent: Color get() = JBColor.namedColor("Link.activeForeground", 0x5B8DEF).toComposeColor()
    val danger: Color get() = JBColor(0xE53935, 0xE57373).toComposeColor()
    val stopRed: Color get() = JBColor(0xD32F2F, 0xE5484D).toComposeColor()
    val warning: Color get() = JBColor(0xE65100, 0xE08C3A).toComposeColor()
    val inputBackground: Color get() = JBColor.namedColor("TextField.background", 0xFFFFFF).toComposeColor()
    val popupBackground: Color get() = JBColor(0xF2F2F2, 0x2B2B2B).toComposeColor()
    val popupBorder: Color get() = JBColor(0x999999, 0x3C3C3C).toComposeColor()
    val dropdownSelected: Color get() = JBColor(0xE0E0E0, 0x3D3D3D).toComposeColor()
    val dropdownHover: Color get() = JBColor(0xE8E8E8, 0x353535).toComposeColor()
    val onAccent: Color get() = JBColor(0x1E1F22, 0xFFFFFF).toComposeColor()
    val disclaimerFg: Color get() = JBColor(0x999999, 0x999999).toComposeColor()
    val mutedGray: Color get() = JBColor(0x6C707E, 0xB0B0B0).toComposeColor()
    val mutedActionAlpha: Float get() = 0.7f
    val borderAlpha: Float get() = 0.38f
    val pressedAccentSoft: Color get() = pressedAccent.copy(alpha = 0.4f)
    val tooltipBackground: Color get() = JBColor(0x333333, 0x2B2B2B).toComposeColor()
    val tooltipForeground: Color get() = JBColor(0xFFFFFF, 0xFFFFFF).toComposeColor()
    val actionTooltipBackground: Color get() = JBColor(0xF5F5F5, 0x2B2B2B).toComposeColor()
    val actionTooltipForeground: Color get() = JBColor(0x1E1F22, 0xDFE1E5).toComposeColor()

    // Message-specific tokens
    val messageBackground: Color get() = JBColor.namedColor("Editor.background", 0xFFFFFF).toComposeColor()
    val userBubbleBg: Color get() = JBColor(0xF0F4FF, 0x27282C).toComposeColor()
    val userBubbleBorder: Color get() = JBColor(0xC8D0DC, 0x37383C).toComposeColor()
    val userBubbleRadius: Int get() = 10
    val userBubblePaddingH: Int get() = 14
    val userBubblePaddingV: Int get() = 10
    val userBubbleMaxWidth: Int get() = 480

    val agentMessageRadius: Int get() = 8
    val agentMessagePaddingV: Int get() = 4

    val toolOutputBg: Color get() = JBColor(0xF7F8FA, 0x27282C).toComposeColor()
    val toolOutputBorder: Color get() = JBColor(0x8B95A5, 0x6B7280).toComposeColor().copy(alpha = 0.4f)
    val toolOutputRadius: Int get() = 6
    val toolOutputPaddingH: Int get() = 12
    val toolOutputPaddingV: Int get() = 10

    val thoughtTextColor: Color get() = Color(0xFF6F737A)
    val thoughtLabelSize: Float get() = 13f
    val thoughtIndent: Int get() = 20

    val toolLabelSize: Float get() = 13f
    val toolIndent: Int get() = 20

    val systemCardRadius: Int get() = 8
    val systemCardPaddingH: Int get() = 14
    val systemCardPaddingV: Int get() = 12

    // Permission card colors
    val permissionRequestBg: Color get() = JBColor(0xE8F0FE, 0x1A2744).toComposeColor()
    val permissionRequestBorder: Color get() = JBColor(0x5B8DEF, 0x5B8DEF).toComposeColor().copy(alpha = 0.3f)
    val permissionWarningBg: Color get() = JBColor(0xFFF8E1, 0x3D2E1A).toComposeColor()
    val permissionWarningBorder: Color get() = JBColor(0xE65100, 0xE08C3A).toComposeColor().copy(alpha = 0.3f)
    val permissionSuccessBg: Color get() = JBColor(0xE8F5E9, 0x1B2A1F).toComposeColor()
    val permissionSuccessBorder: Color get() = JBColor(0x4E9C5A, 0x3D6B4A).toComposeColor().copy(alpha = 0.3f)
    val permissionDeniedBg: Color get() = JBColor(0xFFF8E1, 0x3D2E1A).toComposeColor()
    val permissionDeniedBorder: Color get() = JBColor(0xE65100, 0xE08C3A).toComposeColor().copy(alpha = 0.3f)

    val messageSpacingTop: Int get() = 10
    val messageSpacingBottom: Int get() = 10
    val firstMessageTop: Int get() = 16
    val messageHorizontalPadding: Int get() = 24

    val actionButtonSize: Int get() = 24
    val actionIconSize: Int get() = 14
    val actionButtonRadius: Int get() = 4
    val actionSpacing: Int get() = 4

    val loadingIndicatorSize: Int get() = 14
    val loadingIndicatorColor: Color get() = JBColor(0x6C707E, 0x66FFFFFF).toComposeColor()
    val loadingTextSize: Float get() = 12f

    val lineDiffAdded: Color get() = Color(0xFF4EC9B0)
    val lineDiffRemoved: Color get() = Color(0xFFF48771)

    // Tool-type-specific output styles
    val toolEditBg: Color get() = JBColor(0xF0F4EE, 0x1B2A1F).toComposeColor()
    val toolEditBorder: Color get() = JBColor(0x4E9C5A, 0x3D6B4A).toComposeColor().copy(alpha = 0.3f)
    val toolEditAddedLineBg: Color get() = JBColor(0xE6F4E6, 0x1E3320).toComposeColor()
    val toolEditRemovedLineBg: Color get() = JBColor(0xFCE8E8, 0x331E1E).toComposeColor()
    val toolExecBg: Color get() = JBColor(0xF0F4FF, 0x161719).toComposeColor()
    val toolExecFg: Color get() = JBColor(0x1E1F22, 0xD4D7DD).toComposeColor()
    val toolExecBorder: Color get() = JBColor(0xC0D0E0, 0x2A2C2F).toComposeColor()
    val toolSearchBg: Color get() = JBColor(0xF0F4FF, 0x1A2138).toComposeColor()
    val toolSearchBorder: Color get() = JBColor(0x5B8DEF, 0x5B8DEF).toComposeColor().copy(alpha = 0.25f)

    val codeBlockBg: Color get() = JBColor(0xF6F8FA, 0x323232).toComposeColor()
    val codeBlockBorder: Color get() = JBColor(0xD0D7DE, 0x3C3C3C).toComposeColor().copy(alpha = 0.4f)
    val codeTextColor: Color get() = JBColor.namedColor("Editor.foreground", 0x000000).toComposeColor()
    val toolReadBg: Color get() = JBColor(0xF7F8FA, 0x27282C).toComposeColor()
    val toolReadBorder: Color get() = JBColor(0x8B95A5, 0x6B7280).toComposeColor().copy(alpha = 0.25f)
    val toolThinkBg: Color get() = JBColor(0xFBF8F0, 0x2A2820).toComposeColor()
    val toolThinkBorder: Color get() = JBColor(0xC8A85A, 0x8A7430).toComposeColor().copy(alpha = 0.25f)
    val toolMoveBg: Color get() = JBColor(0xF5F0FA, 0x241F33).toComposeColor()
    val toolMoveBorder: Color get() = JBColor(0x8B5CF6, 0x8B5CF6).toComposeColor().copy(alpha = 0.25f)
}

@Composable
fun SmallSpinner(
    modifier: Modifier = Modifier.size(14.dp),
    size: Dp = 14.dp,
    color: Color = DevEcoTheme.loadingIndicatorColor,
) {
    val transition = rememberInfiniteTransition(label = "spinner")
    val angle by transition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 800, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "spinner-angle",
    )
    Canvas(modifier = modifier.size(size)) {
        val canvasSize = this.size.width
        val center = androidx.compose.ui.geometry.Offset(canvasSize / 2f, canvasSize / 2f)
        val radius = canvasSize / 2f * 0.75f
        val strokeWidth = canvasSize * 0.15f
        val rad = Math.toRadians(angle.toDouble())
        val startAngle = (rad * 180 / Math.PI).toFloat()
        drawArc(
            color = color,
            startAngle = startAngle,
            sweepAngle = 270f,
            useCenter = false,
            topLeft = androidx.compose.ui.geometry.Offset(center.x - radius, center.y - radius),
            size = androidx.compose.ui.geometry.Size(radius * 2f, radius * 2f),
            style = Stroke(width = strokeWidth, cap = StrokeCap.Round),
        )
    }
}
