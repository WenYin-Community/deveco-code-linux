package org.deveco.code.session.ui.composer

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
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
internal fun ModeSelector(controller: SessionController, muted: Color, inputFocusRequester: FocusRequester) {
    var expanded by remember { mutableStateOf(false) }
    var buttonWidthPx by remember { mutableStateOf(0) }
    val density = LocalDensity.current
    val buttonWidth = with(density) { buttonWidthPx.toDp() } + 20.dp
    val interactionSource = remember { MutableInteractionSource() }
    val hovered by interactionSource.collectIsHoveredAsState()
    val enabled = controller.modes.isNotEmpty()
    val label = controller.selectedMode?.name?.replaceFirstChar { it.uppercase() }
        ?: MyMessageBundle.message("session.mode.loading")

    // Same refocus contract as ModelSelector: the focusable popup steals focus
    // from the prompt input, and focus must be handed back only after the
    // popup has fully left composition or the input's IME stops engaging.
    var pendingRefocus by remember { mutableStateOf(false) }
    LaunchedEffect(expanded) {
        if (!expanded && pendingRefocus) {
            pendingRefocus = false
            withFrameNanos { }
            withFrameNanos { }
            inputFocusRequester.requestFocus()
        }
    }

    Box {
        Row(
            Modifier.clip(RoundedCornerShape(7.dp))
                .background(if (hovered || expanded) DevEcoTheme.pressedAccentSoft else Color.Transparent)
                .clickable(
                    enabled = enabled,
                    interactionSource = interactionSource,
                    indication = null,
                ) { expanded = true }
                .widthIn(min = 68.dp)
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
                modifier = Modifier.size(12.dp).rotate(if (expanded) 180f else 0f),
            )
        }

        if (expanded && enabled) {
            // Highlight starts on the selected mode so Enter right after
            // opening keeps the current selection. Recomputed per popup open
            // (this block leaves composition while collapsed) and clamped on
            // read so an async modes refresh can't leave it out of range.
            var highlightIndex by remember {
                mutableStateOf(controller.modes.indexOfFirst { it.id == controller.selectedMode?.id }.takeIf { it >= 0 } ?: 0)
            }
            val highlight = highlightIndex.coerceIn(0, controller.modes.lastIndex)
            val popupFocusRequester = remember { FocusRequester() }

            // Grab keyboard focus for the popup one frame after it shows, once
            // the Column is attached, so the arrow keys reach the handler
            // without a click.
            LaunchedEffect(Unit) {
                withFrameNanos { }
                popupFocusRequester.requestFocus()
            }

            // Same interception pattern as ModelSelector's search field:
            // plain arrow keys and Enter only; keys pass through whenever a
            // modifier is held.
            val handleKeyEvent = { event: KeyEvent ->
                if (event.type != KeyEventType.KeyDown ||
                    event.isCtrlPressed || event.isMetaPressed || event.isAltPressed || event.isShiftPressed
                ) {
                    false
                } else {
                    when (event.key) {
                        Key.DirectionUp -> {
                            highlightIndex = (highlight + controller.modes.size - 1) % controller.modes.size
                            true
                        }
                        Key.DirectionDown -> {
                            highlightIndex = (highlight + 1) % controller.modes.size
                            true
                        }
                        Key.Enter, Key.NumPadEnter -> {
                            controller.modes.getOrNull(highlight)?.let { mode ->
                                expanded = false
                                if (mode.id != controller.selectedMode?.id) controller.selectMode(mode.id)
                            }
                            pendingRefocus = true
                            true
                        }
                        Key.Escape -> {
                            expanded = false
                            pendingRefocus = true
                            true
                        }
                        else -> false
                    }
                }
            }

            Popup(
                popupPositionProvider = DropdownPositionProvider(endAligned = false),
                onDismissRequest = {
                    expanded = false
                    pendingRefocus = true
                },
                properties = PopupProperties(focusable = true, dismissOnBackPress = true, dismissOnClickOutside = true),
            ) {
                Column(
                    Modifier.width(IntrinsicSize.Max)
                        .widthIn(min = buttonWidth)
                        .background(DevEcoTheme.popupBackground, RoundedCornerShape(6.dp))
                        .border(1.dp, DevEcoTheme.popupBorder, RoundedCornerShape(6.dp))
                        .padding(vertical = 4.dp)
                        .focusRequester(popupFocusRequester)
                        .onPreviewKeyEvent(handleKeyEvent)
                        .focusable(),
                ) {
                    controller.modes.forEachIndexed { index, mode ->
                        val displayName = mode.name.replaceFirstChar { it.uppercase() }
                        val isSelected = mode.id == controller.selectedMode?.id
                        ModelDropdownItem(
                            text = displayName,
                            selected = isSelected,
                            highlighted = index == highlight,
                            // Mirror hover into the keyboard highlight so Enter
                            // after hovering commits the hovered row.
                            onHoverChange = { itemHovered -> if (itemHovered) highlightIndex = index },
                            onClick = {
                                expanded = false
                                controller.selectMode(mode.id)
                                pendingRefocus = true
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
