package org.deveco.code.session.ui.composer

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
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
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.deveco.code.session.SessionController
import org.deveco.code.session.ui.messages.DropdownIconKey
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text

private val ATTACHMENT_LIST_MAX_HEIGHT = 300.dp

@Composable
internal fun ModelSelector(controller: SessionController, muted: Color, project: Project) {
    var expanded by remember { mutableStateOf(false) }
    var buttonWidthPx by remember { mutableStateOf(0) }
    val density = LocalDensity.current
    val buttonWidth = with(density) { buttonWidthPx.toDp() } + 20.dp
    val interactionSource = remember { MutableInteractionSource() }
    val hovered by interactionSource.collectIsHoveredAsState()
    val label = controller.selectedModel?.name ?: MyMessageBundle.message("composer.model.auto")

    Box {
        Row(
            Modifier.clip(RoundedCornerShape(7.dp))
                .background(if (hovered || expanded) DevEcoTheme.pressedAccentSoft else Color.Transparent)
                .clickable(
                    enabled = controller.ready,
                    interactionSource = interactionSource,
                    indication = null,
                ) { expanded = true }
                .padding(horizontal = 10.dp, vertical = 5.dp)
                .onSizeChanged { buttonWidthPx = it.width },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                label,
                color = if (controller.ready) Color.Unspecified else muted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 180.dp),
            )
            Spacer(Modifier.width(6.dp))
            Icon(
                key = DropdownIconKey,
                contentDescription = MyMessageBundle.message("session.model.selector"),
                modifier = Modifier.size(12.dp),
            )
        }

        if (expanded && controller.ready) {
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
                    Column(
                        Modifier.heightIn(max = ATTACHMENT_LIST_MAX_HEIGHT)
                            .verticalScroll(rememberScrollState())
                    ) {
                        controller.models.forEach { model ->
                            ModelDropdownItem(
                                text = model.name,
                                selected = model.id == controller.selectedModel?.id,
                                onClick = {
                                    expanded = false
                                    controller.selectModel(model.id)
                                },
                            )
                        }
                    }
                    Box(
                        Modifier.fillMaxWidth()
                            .height(1.dp)
                            .background(DevEcoTheme.popupBorder)
                    )
                    ModelDropdownItem(
                        text = MyMessageBundle.message("composer.addModel"),
                        onClick = {
                            expanded = false
                            ShowSettingsUtil.getInstance().showSettingsDialog(project, MyMessageBundle.message("settings.models.displayName"))
                        },
                    )
                }
            }
        }
    }
}

@Composable
internal fun ModelDropdownItem(
    text: String,
    selected: Boolean = false,
    onClick: () -> Unit = {},
) {
    val interactionSource = remember { MutableInteractionSource() }
    val isHovered by interactionSource.collectIsHoveredAsState()
    val textColor = if (selected) DevEcoTheme.onAccent else DevEcoTheme.mutedGray

    Row(
        Modifier.fillMaxWidth()
            .height(24.dp)
            .hoverable(interactionSource)
            .clickable(interactionSource = interactionSource, indication = null) { onClick() }
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxHeight()
                .then(
                    if (selected) {
                        Modifier
                            .background(DevEcoTheme.accent.copy(alpha = 0.3f), RoundedCornerShape(4.dp))
                    } else if (isHovered) {
                        Modifier
                            .background(DevEcoTheme.pressedAccentSoft, RoundedCornerShape(4.dp))
                    } else {
                        Modifier
                    }
                ),
            contentAlignment = Alignment.CenterStart,
        ) {
            Text(
                text,
                color = textColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 200.dp).padding(start = 10.dp),
                fontSize = 13.sp,
            )
        }
    }
}

internal class DropdownPositionProvider(private val endAligned: Boolean = false) : PopupPositionProvider {
    override fun calculatePosition(
        anchorBounds: IntRect,
        windowSize: IntSize,
        layoutDirection: LayoutDirection,
        popupContentSize: IntSize,
    ): IntOffset {
        val x = if (endAligned) anchorBounds.right - popupContentSize.width else anchorBounds.left
        return IntOffset(maxOf(0, x), anchorBounds.top - popupContentSize.height - 2)
    }
}
