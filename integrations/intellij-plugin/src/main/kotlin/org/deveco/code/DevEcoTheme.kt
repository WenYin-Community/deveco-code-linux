package org.deveco.code

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.intellij.ui.JBColor
import kotlinx.coroutines.delay
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
    // Inline markdown chips: code spans get a 1px rounded outline on the panel
    // background, links a filled rounded chip (drawn from text layout geometry
    // in MarkdownChipRenderer261.kt, mirrored as flat spans on the 243 line).
    val inlineCodeBorder: Color get() = JBColor(0xB9BEC7, 0x57595E).toComposeColor()
    val linkChipBg: Color get() = JBColor(0xDCE4F0, 0x2B2E33).toComposeColor()
    val danger: Color get() = JBColor(0xE53935, 0xE57373).toComposeColor()
    val stopRed: Color get() = JBColor(0xD32F2F, 0xE5484D).toComposeColor()
    val warning: Color get() = JBColor(0xE65100, 0xE08C3A).toComposeColor()
    val inputBackground: Color get() = JBColor.namedColor("TextField.background", 0xFFFFFF).toComposeColor()
    val popupBackground: Color get() = JBColor(0xF2F2F2, 0x2B2B2B).toComposeColor()
    val popupBorder: Color get() = JBColor(0x999999, 0x3C3C3C).toComposeColor()
    val tooltipShadow: Color get() = JBColor(0x1B1F26, 0x000000).toComposeColor()
    val dropdownSelected: Color get() = JBColor(0xE0E0E0, 0x3D3D3D).toComposeColor()
    val dropdownHover: Color get() = JBColor(0xE8E8E8, 0x353535).toComposeColor()
    val onAccent: Color get() = JBColor(0x1E1F22, 0xFFFFFF).toComposeColor()
    val disclaimerFg: Color get() = JBColor(0x999999, 0x999999).toComposeColor()
    val mutedGray: Color get() = JBColor(0x6C707E, 0xB0B0B0).toComposeColor()
    val attachmentNameFg: Color get() = JBColor(0x000000, 0xDFE1E6).toComposeColor()
    // JBColor(int, int) derives its has-alpha flag from the light value only, so an
    // alpha-bearing dark int (0x0DFFFFFF) would be flattened to opaque white; pass
    // explicit awt Colors to keep the dark chip translucent.
    val fileRefChipBg: Color get() = JBColor(java.awt.Color(0xEBECF0), java.awt.Color(0x0DFFFFFF, true)).toComposeColor()
    val mutedActionAlpha: Float get() = 0.7f
    val borderAlpha: Float get() = 0.38f
    val pressedAccentSoft: Color get() = pressedAccent.copy(alpha = 0.4f)
    val selectedHoveredSessionBg: Color get() = JBColor(0xD4E2FF, 0x2E436E).toComposeColor()
    val selectedSessionBg: Color get() = JBColor(0xDFE1E5, 0x4E5157).toComposeColor()
    val hoveredSessionBg: Color get() = JBColor(0xEBECF0, 0x393B40).toComposeColor()
    val previewedFileBg: Color get() = JBColor(0xD4E2FF, 0x2B4A7E).toComposeColor()
    val previewedFileFg: Color get() = JBColor(0x1E1F22, 0xFFFFFF).toComposeColor()
    // Copy-button hover fill: same surface formula as the message attachment chips.
    val copyActionHoverBackground: Color get() = muted.copy(alpha = 0.12f)
    // Shared scrollbar thumb colors: message list and composer stay identical.
    val scrollbarThumb: Color get() = JBColor(0xD9D9D9, 0x48494B).toComposeColor()
    val scrollbarThumbHover: Color get() = JBColor(0x7B7C7D, 0x595A5C).toComposeColor()

    // Message-specific tokens
    val messageBackground: Color get() = JBColor.namedColor("Editor.background", 0xFFFFFF).toComposeColor()
    val userBubbleBg: Color get() = messageBackground
    val userBubbleRadius: Int get() = 8
    val userBubblePaddingH: Int get() = 14
    val userBubblePaddingV: Int get() = 10
    val userBubbleMaxWidth: Int get() = 544

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

    val messageSpacingTop: Int get() = 20
    val messageSpacingBottom: Int get() = 10
    val firstMessageTop: Int get() = 16
    val messageHorizontalPadding: Int get() = 24

    // In-turn nodes (AGENT text, THOUGHT, TOOL) share one 8px rhythm. A node group
    // takes nodeGap + nodePadding on top and nodePadding at the bottom, so two
    // adjacent nodes end up 8px apart without an explicit gap row. Children inside
    // a group get nodePadding on both sides plus a nodeGap spacer, which lands on
    // the same 8px between siblings.
    val nodePadding: Int get() = 2
    val nodeGap: Int get() = 4

    // Gap between an assistant message body and its action row.
    val actionRowGap: Int get() = 8

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
    val toolExecBg: Color get() = JBColor(0xFEFEFE, 0x161719).toComposeColor()
    val toolExecFg: Color get() = JBColor(0x1E1F22, 0xD4D7DD).toComposeColor()
    val toolExecBorder: Color get() = JBColor(0x999999, 0x2A2C2F).toComposeColor()
    val toolSearchBg: Color get() = JBColor(0xF0F4FF, 0x1A2138).toComposeColor()
    val toolSearchBorder: Color get() = JBColor(0x5B8DEF, 0x5B8DEF).toComposeColor().copy(alpha = 0.25f)

    val codeBlockBg: Color get() = JBColor(0xF6F8FA, 0x323232).toComposeColor()
    val codeBlockBorder: Color get() = JBColor(0xD0D7DE, 0x3C3C3C).toComposeColor().copy(alpha = 0.4f)
    val codeTextColor: Color get() = JBColor.namedColor("Editor.foreground", 0x000000).toComposeColor()
    val toolReadBg: Color get() = JBColor(0xF7F8FA, 0x27282C).toComposeColor()
    val toolReadBorder: Color get() = JBColor(0x8B95A5, 0x6B7280).toComposeColor().copy(alpha = 0.25f)
    val toolMoveBg: Color get() = JBColor(0xF5F0FA, 0x241F33).toComposeColor()
    val toolMoveBorder: Color get() = JBColor(0x8B5CF6, 0x8B5CF6).toComposeColor().copy(alpha = 0.25f)
}

// Frame-stepped rotation, mirroring the platform AI chat spinners: a LaunchedEffect
// delay loop advances a discrete frame index, so the layer rotation changes only
// ~30 times per second in 15° steps and the Compose surface stays quiet between
// steps. The Swing-embedded renderer paints on the IntelliJ EDT, so a continuously
// interpolated animation (even via graphicsLayer) keeps the event queue busy and
// blocks IdeEventQueue.flushQueue from settling to open modals.
private const val SPINNER_CYCLE_MILLIS = 800L
private const val SPINNER_FRAMES = 24

@Composable
fun SmallSpinner(
    modifier: Modifier = Modifier.size(14.dp),
    size: Dp = 14.dp,
    color: Color = DevEcoTheme.loadingIndicatorColor,
) {
    val frame = remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(SPINNER_CYCLE_MILLIS / SPINNER_FRAMES)
            frame.intValue = (frame.intValue + 1) % SPINNER_FRAMES
        }
    }
    Canvas(modifier = modifier.size(size).graphicsLayer { rotationZ = frame.intValue * 360f / SPINNER_FRAMES }) {
        val canvasSize = this.size.width
        val center = androidx.compose.ui.geometry.Offset(canvasSize / 2f, canvasSize / 2f)
        val radius = canvasSize / 2f * 0.75f
        val strokeWidth = canvasSize * 0.15f
        drawArc(
            color = color,
            startAngle = 0f,
            sweepAngle = 270f,
            useCenter = false,
            topLeft = androidx.compose.ui.geometry.Offset(center.x - radius, center.y - radius),
            size = androidx.compose.ui.geometry.Size(radius * 2f, radius * 2f),
            style = Stroke(width = strokeWidth, cap = StrokeCap.Round),
        )
    }
}
