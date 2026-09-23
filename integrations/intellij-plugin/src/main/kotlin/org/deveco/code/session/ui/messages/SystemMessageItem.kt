package org.deveco.code.session.ui.messages

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import org.deveco.code.DevEcoIcons
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.deveco.code.session.model.ChatItem
import org.deveco.code.session.model.PermissionChoice
import org.jetbrains.jewel.markdown.Markdown
import org.jetbrains.jewel.markdown.extensions.LocalMarkdownBlockRenderer
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.icons.AllIconsKeys

/**
 * Permission card state.
 */
internal enum class PermissionCardState {
    /** Permission request - blue card with info icon */
    REQUEST,
    /** Sensitive permission request - yellow card with warning icon */
    WARNING,
    /** Authorization success - green card with checkmark icon */
    SUCCESS,
    /** Permission denied - orange/yellow card with warning icon */
    DENIED,
    /** Regular system message */
    SYSTEM,
}

@Composable
internal fun SystemItem(
    item: ChatItem,
    card: Color,
    muted: Color,
    choices: List<PermissionChoice>?,
    permissionResult: String? = null,
    permissionDenied: Boolean = false,
) {
    // Determine card state
    val state = when {
        permissionDenied -> PermissionCardState.DENIED
        choices != null -> {
            // Check if this is a sensitive permission request (contains warning keywords)
            if (item.text.contains("上传", ignoreCase = true) ||
                item.text.contains("服务器", ignoreCase = true) ||
                item.text.contains("网络", ignoreCase = true)
            ) {
                PermissionCardState.WARNING
            } else {
                PermissionCardState.REQUEST
            }
        }
        permissionResult != null -> PermissionCardState.SUCCESS
        else -> PermissionCardState.SYSTEM
    }

    // Get card colors based on state
    val (bgColor, borderColor, iconKey) = when (state) {
        PermissionCardState.REQUEST -> Triple(
            DevEcoTheme.permissionRequestBg,
            DevEcoTheme.permissionRequestBorder,
            DevEcoIcons.iconKey("migration-info"),
        )
        PermissionCardState.WARNING -> Triple(
            DevEcoTheme.permissionWarningBg,
            DevEcoTheme.permissionWarningBorder,
            AllIconsKeys.General.Warning,
        )
        PermissionCardState.SUCCESS -> Triple(
            DevEcoTheme.permissionSuccessBg,
            DevEcoTheme.permissionSuccessBorder,
            AllIconsKeys.General.InspectionsOK,
        )
        PermissionCardState.DENIED -> Triple(
            DevEcoTheme.permissionDeniedBg,
            DevEcoTheme.permissionDeniedBorder,
            AllIconsKeys.General.Warning,
        )
        PermissionCardState.SYSTEM -> Triple(card, Color.Transparent, null)
    }

    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(DevEcoTheme.systemCardRadius.dp))
            .background(bgColor)
            .then(
                if (borderColor != Color.Transparent) {
                    Modifier.border(1.dp, borderColor, RoundedCornerShape(DevEcoTheme.systemCardRadius.dp))
                } else {
                    Modifier
                }
            )
            .padding(
                horizontal = DevEcoTheme.systemCardPaddingH.dp,
                vertical = DevEcoTheme.systemCardPaddingV.dp,
            ),
    ) {
        // Title row with icon
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (iconKey != null) {
                Icon(
                    key = iconKey,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                    tint = when (state) {
                        PermissionCardState.REQUEST -> Color.Unspecified
                        PermissionCardState.WARNING -> DevEcoTheme.warning
                        PermissionCardState.SUCCESS -> DevEcoTheme.green
                        PermissionCardState.DENIED -> DevEcoTheme.warning
                        PermissionCardState.SYSTEM -> muted
                    },
                )
                Spacer(Modifier.width(6.dp))
            }
            Text(
                item.title,
                color = when (state) {
                    PermissionCardState.SUCCESS -> DevEcoTheme.green
                    PermissionCardState.DENIED -> DevEcoTheme.warning
                    else -> muted
                },
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
            )
        }

        // Show error message text for SYSTEM state
        if (state == PermissionCardState.SYSTEM && item.text.isNotBlank()) {
            Spacer(Modifier.height(6.dp))
            Text(
                item.text,
                color = DevEcoTheme.foreground,
                fontSize = 12.sp,
                fontWeight = FontWeight.Normal,
            )
        }

        // Buttons (only for request/warning states)
        choices?.let {
            Spacer(Modifier.height(8.dp))
            Row(
                Modifier.padding(start = 20.dp),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                it.forEach { choice ->
                    Box(
                        modifier = Modifier
                            .clickable { choice.select() }
                            .pointerHoverIcon(PointerIcon.Hand),
                    ) {
                        DisableSelection {
                            Text(
                                choice.name,
                                color = DevEcoTheme.linkAccent,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Medium,
                            )
                        }
                    }
                }
            }
        }
    }
}
