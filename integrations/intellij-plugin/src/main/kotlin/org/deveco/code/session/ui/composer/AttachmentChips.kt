package org.deveco.code.session.ui.composer

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import org.deveco.code.DevEcoTheme
import org.deveco.code.DevEcoIcons
import org.deveco.code.MyMessageBundle
import org.deveco.code.session.model.AttachmentItem
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.icon.PathIconKey
import org.jetbrains.jewel.ui.icons.AllIconsKeys

internal val FileIconKey = PathIconKey("/icons/file.svg", DevEcoTheme::class.java)

internal val PictureIconKey = PathIconKey("/icons/picture.svg", DevEcoTheme::class.java)

@Composable
internal fun ComposerAttachments(
    attachments: List<AttachmentItem>,
    muted: Color,
    onRemove: (Int) -> Unit,
    onPreview: (ByteArray) -> Unit,
) {
    if (attachments.isNotEmpty()) {
        val images = attachments.withIndex().filter { it.value.isImage }
        val texts = attachments.withIndex().filter { !it.value.isImage }

        if (images.isNotEmpty()) {
            FlowRow(
                Modifier.fillMaxWidth().padding(bottom = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                images.forEach { indexed ->
                    AttachmentChip(
                        name = indexed.value.name,
                        isImage = true,
                        thumbnail = indexed.value.thumbnail,
                        muted = muted,
                        onRemove = { onRemove(indexed.index) },
                        onPreview = { indexed.value.originalBytes?.let { onPreview(it) } },
                    )
                }
            }
        }
        if (texts.isNotEmpty()) {
            FlowRow(
                Modifier.fillMaxWidth().padding(bottom = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                texts.forEach { indexed ->
                    AttachmentChip(
                        name = indexed.value.name,
                        isImage = false,
                        thumbnail = null,
                        muted = muted,
                        onRemove = { onRemove(indexed.index) },
                    )
                }
            }
        }
    }
}


// --- Attachment support ---

@Composable
internal fun AddAttachmentButton(
    muted: Color,
    supportsImages: Boolean,
    enabled: Boolean = true,
    onSelectFile: () -> Unit,
    onSelectImage: () -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val interactionSource = remember { MutableInteractionSource() }
    val hovered by interactionSource.collectIsHoveredAsState()
    Box {
        Box(
            Modifier.clip(RoundedCornerShape(7.dp))
                .background(if (enabled && (hovered || expanded)) DevEcoTheme.pressedAccentSoft else Color.Transparent)
                .clickable(
                    interactionSource = interactionSource,
                    indication = null,
                    enabled = enabled,
                ) { expanded = true }
                .padding(horizontal = 8.dp, vertical = 5.dp),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                key = DevEcoIcons.iconKey("add"),
                contentDescription = "Add attachment",
                modifier = Modifier
                    .size(16.dp)
                    .then(if (!enabled) Modifier.alpha(0.4f) else Modifier),
            )
        }

        if (expanded) {
            Popup(
                popupPositionProvider = DropdownPositionProvider(endAligned = false),
                onDismissRequest = { expanded = false },
                properties = PopupProperties(focusable = true, dismissOnBackPress = true, dismissOnClickOutside = true),
            ) {
                Column(
                    Modifier.width(IntrinsicSize.Max)
                        .background(DevEcoTheme.popupBackground, RoundedCornerShape(6.dp))
                        .border(1.dp, DevEcoTheme.popupBorder, RoundedCornerShape(6.dp))
                        .padding(vertical = 4.dp),
                ) {
                    AttachmentTypeItem(
                        iconKey = FileIconKey,
                        text = MyMessageBundle.message("composer.attachment.file"),
                        onClick = {
                            expanded = false
                            onSelectFile()
                        },
                    )
                    if (supportsImages) {
                        AttachmentTypeItem(
                            iconKey = PictureIconKey,
                            text = MyMessageBundle.message("composer.attachment.image"),
                            onClick = {
                                expanded = false
                                onSelectImage()
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun AttachmentTypeItem(
    iconKey: org.jetbrains.jewel.ui.icon.IconKey,
    text: String,
    onClick: () -> Unit,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val isHovered by interactionSource.collectIsHoveredAsState()
    Row(
        Modifier.fillMaxWidth()
            .hoverable(interactionSource)
            .background(if (isHovered) DevEcoTheme.pressedAccentSoft else Color.Transparent)
            .clickable(interactionSource = interactionSource, indication = null) { onClick() }
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            key = iconKey,
            contentDescription = null,
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.width(8.dp))
        Text(
            text,
            color = DevEcoTheme.mutedGray,
            fontSize = 12.sp,
        )
    }
}

@Composable
private fun AttachmentChip(
    name: String,
    isImage: Boolean,
    thumbnail: ByteArray? = null,
    muted: Color,
    onRemove: () -> Unit,
    onPreview: () -> Unit = {},
) {
    Row(
        Modifier.clip(RoundedCornerShape(7.dp))
            .background(muted.copy(alpha = 0.12f))
            .then(
                if (isImage && thumbnail != null)
                    Modifier.clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { onPreview() }
                else Modifier
            )
            .padding(horizontal = 6.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (isImage && thumbnail != null) {
            // Thumbnail preview —a small square image with rounded corners, clickable for full view.
            val skiaImage = remember(thumbnail) { runCatching { org.jetbrains.skia.Image.makeFromEncoded(thumbnail) }.getOrNull() }
            val imageBitmap = remember(skiaImage) { skiaImage?.toComposeImageBitmap() }
            if (imageBitmap != null) {
                Image(
                    bitmap = imageBitmap,
                    contentDescription = "Thumbnail of $name",
                    modifier = Modifier.size(20.dp).clip(RoundedCornerShape(3.dp)),
                )
                Spacer(Modifier.width(4.dp))
            } else {
                Icon(
                    key = AllIconsKeys.FileTypes.Image,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                )
                Spacer(Modifier.width(4.dp))
            }
        } else {
            Icon(
                key = if (isImage) AllIconsKeys.FileTypes.Image else AllIconsKeys.FileTypes.Text,
                contentDescription = null,
                modifier = Modifier.size(14.dp),
            )
            Spacer(Modifier.width(4.dp))
        }
        Text(
            name,
            fontSize = 11.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 120.dp),
        )
        Spacer(Modifier.width(4.dp))
        Box(
            Modifier.clip(CircleShape)
                .clickable { onRemove() }
                .padding(2.dp),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                key = AllIconsKeys.Actions.Close,
                contentDescription = "Remove attachment",
                modifier = Modifier.size(12.dp),
            )
        }
    }
}
