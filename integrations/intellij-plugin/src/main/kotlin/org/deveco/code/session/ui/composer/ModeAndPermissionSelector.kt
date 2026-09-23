package org.deveco.code.session.ui.composer

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import com.intellij.openapi.ui.Messages
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.deveco.code.session.SessionController
import org.deveco.code.session.model.PermissionMode
import org.deveco.code.session.ui.messages.DropdownIconKey
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text

@Composable
internal fun ModeSelector(controller: SessionController, muted: Color) {
    var expanded by remember { mutableStateOf(false) }
    var buttonWidthPx by remember { mutableStateOf(0) }
    val density = LocalDensity.current
    val buttonWidth = with(density) { buttonWidthPx.toDp() } + 20.dp
    val interactionSource = remember { MutableInteractionSource() }
    val hovered by interactionSource.collectIsHoveredAsState()
    val enabled = controller.ready && controller.modes.isNotEmpty()
    val label = controller.selectedMode?.name?.replaceFirstChar { it.uppercase() }
        ?: MyMessageBundle.message("session.mode.loading")

    Box {
        Row(
            Modifier.clip(RoundedCornerShape(7.dp))
                .background(if (hovered || expanded) DevEcoTheme.pressedAccentSoft else Color.Transparent)
                .clickable(
                    enabled = enabled,
                    interactionSource = interactionSource,
                    indication = null,
                ) { expanded = true }
                .padding(horizontal = 10.dp, vertical = 5.dp)
                .onSizeChanged { buttonWidthPx = it.width },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                label,
                color = if (enabled) Color.Unspecified else muted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 180.dp),
            )
            Spacer(Modifier.width(6.dp))
            Icon(
                key = DropdownIconKey,
                contentDescription = MyMessageBundle.message("session.mode.selector"),
                modifier = Modifier.size(12.dp),
            )
        }

        if (expanded && enabled) {
            Popup(
                popupPositionProvider = DropdownPositionProvider(endAligned = false),
                onDismissRequest = { expanded = false },
                properties = PopupProperties(focusable = true, dismissOnBackPress = true, dismissOnClickOutside = true),
            ) {
                Column(
                    Modifier.width(IntrinsicSize.Max)
                        .widthIn(min = buttonWidth)
                        .background(DevEcoTheme.popupBackground, RoundedCornerShape(6.dp))
                        .border(1.dp, DevEcoTheme.popupBorder, RoundedCornerShape(6.dp))
                        .padding(vertical = 4.dp),
                ) {
                    controller.modes.forEach { mode ->
                        val displayName = mode.name.replaceFirstChar { it.uppercase() }
                        val isSelected = mode.id == controller.selectedMode?.id
                        ModelDropdownItem(
                            text = displayName,
                            selected = isSelected,
                            onClick = {
                                expanded = false
                                controller.selectMode(mode.id)
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
internal fun PermissionSelector(controller: SessionController, muted: Color) {
    var expanded by remember { mutableStateOf(false) }
    var buttonWidthPx by remember { mutableStateOf(0) }
    val density = LocalDensity.current
    val buttonWidth = with(density) { buttonWidthPx.toDp() } + 20.dp
    val interactionSource = remember { MutableInteractionSource() }
    val hovered by interactionSource.collectIsHoveredAsState()
    val mode = controller.permissionMode
    val enabled = false // 鏉冮檺閰嶇疆鍔熻兘鏆備笉鍙敤

    Box {
        Row(
            Modifier.clip(RoundedCornerShape(7.dp))
                .background(if ((hovered || expanded) && enabled) DevEcoTheme.pressedAccentSoft else Color.Transparent)
                .clickable(
                    enabled = enabled,
                    interactionSource = interactionSource,
                    indication = null,
                ) { expanded = true }
                .padding(horizontal = 10.dp, vertical = 5.dp)
                .onSizeChanged { buttonWidthPx = it.width },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                MyMessageBundle.message("session.permission.selector"),
                color = if (enabled) Color.Unspecified else muted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 180.dp),
            )
            Spacer(Modifier.width(6.dp))
            Icon(
                key = DropdownIconKey,
                contentDescription = MyMessageBundle.message("session.permission.selector"),
                modifier = Modifier.size(12.dp),
                tint = if (enabled) Color.Unspecified else muted,
            )
        }

        if (expanded && enabled) {
            Popup(
                popupPositionProvider = DropdownPositionProvider(endAligned = false),
                onDismissRequest = { expanded = false },
                properties = PopupProperties(focusable = true, dismissOnBackPress = true, dismissOnClickOutside = true),
            ) {
                Column(
                    Modifier.width(IntrinsicSize.Max)
                        .widthIn(min = buttonWidth)
                        .background(DevEcoTheme.popupBackground, RoundedCornerShape(6.dp))
                        .border(1.dp, DevEcoTheme.popupBorder, RoundedCornerShape(6.dp))
                        .padding(vertical = 4.dp),
                ) {
                    PermissionMode.entries.forEach { pm ->
                        val isSelected = pm.id == mode.id
                        ModelDropdownItem(
                            text = pm.label,
                            selected = isSelected,
                            onClick = {
                                if (pm.id == PermissionMode.AUTO.id && mode != PermissionMode.AUTO) {
                                    val confirmed = Messages.showYesNoDialog(
                                        MyMessageBundle.message("composer.permission.warning.body"),
                                        MyMessageBundle.message("composer.permission.warning.title"),
                                        Messages.getWarningIcon(),
                                    ) == Messages.YES
                                    if (confirmed) controller.selectPermissionModeById(pm.id)
                                } else {
                                    controller.selectPermissionModeById(pm.id)
                                }
                                expanded = false
                            },
                        )
                    }
                }
            }
        }
    }
}
