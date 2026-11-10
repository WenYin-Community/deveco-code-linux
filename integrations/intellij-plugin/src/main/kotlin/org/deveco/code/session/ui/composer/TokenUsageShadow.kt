package org.deveco.code.session.ui.composer

import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import org.deveco.code.DevEcoTheme

internal fun Modifier.tokenUsageCardShadow(shape: Shape, isLightTheme: Boolean): Modifier = dropShadow(
    shape = shape,
    shadow = Shadow(
        radius = if (isLightTheme) 6.dp else 16.dp,
        spread = 0.dp,
        offset = DpOffset(0.dp, if (isLightTheme) 3.dp else 8.dp),
        color = DevEcoTheme.tooltipShadow,
        alpha = if (isLightTheme) 0.18f else 0.4f,
    ),
)
