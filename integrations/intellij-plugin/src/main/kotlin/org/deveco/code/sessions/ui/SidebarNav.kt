package org.deveco.code.sessions.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import org.deveco.code.util.hoverable
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.deveco.code.DevEcoIcons
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text

enum class ConfigTab(private val displayKey: String, val iconName: String) {
    Skill("sidebar.tab.skill", "skill"),
    Models("sidebar.tab.models", "model"),
    ;

    val displayName: String get() = MyMessageBundle.message(displayKey)
}

internal enum class ChevronDirection { RIGHT, DOWN }

@Composable
internal fun Chevron(direction: ChevronDirection, size: Dp = 16.dp) {
    val rotation = when (direction) {
        ChevronDirection.DOWN -> 0f
        ChevronDirection.RIGHT -> -90f
    }
    Icon(
        key = DevEcoIcons.iconKey("arrow"),
        contentDescription = null,
        modifier = Modifier.size(size).rotate(rotation),
    )
}

@Composable
@OptIn(ExperimentalComposeUiApi::class)
fun CollapsibleMenu(
    menuCollapsed: Boolean,
    agentCount: Int,
    skillCount: Int,
    mcpAllConnected: Boolean,
    onToggleMenu: () -> Unit,
    onToggleTab: (ConfigTab) -> Unit,
) {
    val titleFg = DevEcoTheme.titleFg

    Column(
        modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 16.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().height(20.dp)
                .clickable { onToggleMenu() }
                .padding(start = 0.dp, end = 12.dp, top = 2.dp, bottom = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Chevron(if (menuCollapsed) ChevronDirection.RIGHT else ChevronDirection.DOWN)
            Spacer(Modifier.width(2.dp))
            Text(MyMessageBundle.message("sidebar.menu"), color = titleFg, fontSize = 13.sp, fontWeight = FontWeight.Medium, lineHeight = 16.sp)
            Spacer(Modifier.weight(1f))
        }

        if (!menuCollapsed) {
            Spacer(Modifier.height(8.dp))
            ConfigTab.entries.forEachIndexed { index, tab ->
                var hovered by remember { mutableStateOf(false) }
                val interactionSource = remember { MutableInteractionSource() }
                val pressed by interactionSource.collectIsPressedAsState()
                val bg = when {
                    pressed -> DevEcoTheme.pressedAccentSoft
                    hovered -> DevEcoTheme.pressedAccentSoft
                    else -> Color.Transparent
                }
                Row(
                    modifier = Modifier.fillMaxWidth().height(36.dp).clip(RoundedCornerShape(12.dp)).background(bg)
                        .clickable(interactionSource = interactionSource, indication = null) { onToggleTab(tab) }
                        .hoverable { hovered = it }
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        key = DevEcoIcons.iconKey(tab.iconName),
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(tab.displayName, fontWeight = FontWeight.Medium, fontSize = 13.sp)
                    Spacer(Modifier.weight(1f))
                }
            }
        }
    }
}
