package org.deveco.code.session.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.jetbrains.jewel.ui.component.Text

private val DOT_SPACING = 16.dp
private val DOT_RADIUS = 1.1.dp
private val DOT_BASE_ALPHA = 0.16f
private val DOT_PATCH_ALPHA = 0.42f

// Decorative brighter dot blocks, anchored relative to the hero size (fraction of width/height).
private val DOT_PATCHES = listOf(
    DotPatch(0.70f, 0.04f, 9, 5),
    DotPatch(0.04f, 0.28f, 6, 4),
    DotPatch(0.38f, 0.08f, 5, 3),
    DotPatch(0.14f, 0.70f, 7, 4),
    DotPatch(0.62f, 0.64f, 9, 5),
)

private data class DotPatch(val x: Float, val y: Float, val cols: Int, val rows: Int)

@Composable
internal fun SessionWelcomeHeroText(modifier: Modifier = Modifier) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        // Fixed to the widest line so narrowing the panel only clips the hero
        // instead of reflowing the two lines relative to each other.
        modifier = modifier.width(IntrinsicSize.Max),
    ) {
        Text(
            MyMessageBundle.message("session.welcome.title"),
            color = DevEcoTheme.foreground,
            fontSize = 80.sp,
            fontWeight = FontWeight.SemiBold,
            fontFamily = FontFamily.Serif,
            maxLines = 1,
        )
        Spacer(Modifier.height(14.dp))
        Text(
            MyMessageBundle.message("session.welcome.subtitle"),
            color = DevEcoTheme.foreground.copy(alpha = 0.85f),
            fontSize = 20.sp,
            fontWeight = FontWeight.Normal,
            letterSpacing = 0.5.sp,
            lineHeight = 28.sp,
            maxLines = 1,
        )
    }
}

@Composable
internal fun DotMatrixBackground(modifier: Modifier, color: Color) {
    Canvas(modifier) {
        val spacing = DOT_SPACING.toPx()
        val radius = DOT_RADIUS.toPx()
        val cols = (size.width / spacing).toInt()
        val rows = (size.height / spacing).toInt()
        if (cols < 1 || rows < 1) return@Canvas
        val offsetX = (size.width - (cols - 1) * spacing) / 2f
        val offsetY = (size.height - (rows - 1) * spacing) / 2f
        val base = color.copy(alpha = DOT_BASE_ALPHA)
        for (row in 0 until rows) {
            for (col in 0 until cols) {
                drawCircle(base, radius, Offset(offsetX + col * spacing, offsetY + row * spacing))
            }
        }
        val patch = color.copy(alpha = DOT_PATCH_ALPHA)
        for (block in DOT_PATCHES) {
            val anchorX = block.x * size.width
            val anchorY = block.y * size.height
            for (row in 0 until block.rows) {
                for (col in 0 until block.cols) {
                    val center = Offset(anchorX + col * spacing, anchorY + row * spacing)
                    if (center.x < 0f || center.x > size.width || center.y < 0f || center.y > size.height) continue
                    drawCircle(patch, radius, center)
                }
            }
        }
    }
}
