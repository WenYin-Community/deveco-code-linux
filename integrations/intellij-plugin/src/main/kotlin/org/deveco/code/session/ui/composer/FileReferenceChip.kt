package org.deveco.code.session.ui.composer

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.intellij.openapi.util.text.StringUtil
import org.deveco.code.DevEcoTheme
import org.deveco.code.session.model.FileReference
import org.deveco.code.session.ui.messages.FileIcon
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.component.Tooltip
import org.jetbrains.jewel.ui.icons.AllIconsKeys

// Monospaced 11px cap so a deep path can't make the popup wider than the
// screen — the platform fits an oversized popup's position but not its size.
// trimMiddle keeps head and tail, which is what makes a path recognizable.
private const val TOOLTIP_MAX_CHARS = 90

/**
 * Container for file reference chips. Each chip carries a platform-native
 * tooltip (Jewel IntUi bridge): the IDE's own show delay, colors, corner
 * radius and placement, identical to Swing tooltips elsewhere in the IDE.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun FileReferenceChipRow(
    fileRefs: List<FileReference>,
    onRemove: (FileReference) -> Unit,
    onClick: (FileReference) -> Unit,
    modifier: Modifier = Modifier,
    trailing: @Composable FlowRowScope.() -> Unit = {},
) {
    FlowRow(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        fileRefs.forEach { fileRef ->
            Tooltip(
                tooltip = {
                    Text(
                        text = StringUtil.trimMiddle(fileRef.path, TOOLTIP_MAX_CHARS),
                        fontSize = 11.sp,
                        fontFamily = FontFamily.Monospace,
                    )
                },
            ) {
                ChipContent(
                    fileRef = fileRef,
                    onRemove = { onRemove(fileRef) },
                    onClick = { onClick(fileRef) },
                )
            }
        }
        trailing()
    }
}

/**
 * Stateless chip content.
 */
@Composable
private fun ChipContent(
    fileRef: FileReference,
    onRemove: () -> Unit,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val backgroundColor = DevEcoTheme.fileRefChipBg

    Row(
        modifier = modifier
            .clip(RoundedCornerShape(6.dp))
            .background(backgroundColor)
            .clickable(interactionSource = null, indication = null, onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FileIcon(filePath = fileRef.path, modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(6.dp))
        Text(
            text = fileRef.fileName,
            color = Color(0xFF94A3B8),
            fontSize = 12.sp,
            fontFamily = FontFamily.Monospace,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 180.dp),
        )
        if (fileRef.hasLineRange) {
            Spacer(Modifier.width(6.dp))
            Text(
                text = fileRef.lineRange,
                color = Color(0xFF64748B),
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
            )
        }
        Spacer(Modifier.width(4.dp))
        Box(
            modifier = Modifier
                .size(14.dp)
                .clip(RoundedCornerShape(3.dp))
                .clickable { onRemove() },
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                key = AllIconsKeys.Actions.Close,
                contentDescription = "Remove file reference",
                modifier = Modifier.size(10.dp),
                tint = Color(0xFF64748B),
            )
        }
    }
}
