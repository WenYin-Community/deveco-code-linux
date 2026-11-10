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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import com.intellij.openapi.application.ApplicationManager
import org.deveco.code.DevEcoTheme
import org.deveco.code.DevEcoIcons
import org.deveco.code.MyMessageBundle
import org.deveco.code.session.model.AttachmentItem
import org.deveco.code.session.ui.messages.FileIcon
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.icons.AllIconsKeys

private const val THUMB_MAX_PX = 256

internal fun decodeToImageBitmap(imageBytes: ByteArray): androidx.compose.ui.graphics.ImageBitmap? {
    val original = runCatching { javax.imageio.ImageIO.read(imageBytes.inputStream()) }.getOrNull() ?: return null
    val w = original.width
    val h = original.height
    if (w <= 0 || h <= 0) return null
    val scale = minOf(THUMB_MAX_PX.toFloat() / w, THUMB_MAX_PX.toFloat() / h, 1f)
    val tw = (w * scale).toInt().coerceAtLeast(1)
    val th = (h * scale).toInt().coerceAtLeast(1)
    val thumb = java.awt.image.BufferedImage(tw, th, java.awt.image.BufferedImage.TYPE_INT_ARGB)
    val g = thumb.createGraphics()
    try {
        g.setRenderingHint(java.awt.RenderingHints.KEY_INTERPOLATION, java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR)
        g.setRenderingHint(java.awt.RenderingHints.KEY_RENDERING, java.awt.RenderingHints.VALUE_RENDER_QUALITY)
        g.setRenderingHint(java.awt.RenderingHints.KEY_ANTIALIASING, java.awt.RenderingHints.VALUE_ANTIALIAS_ON)
        g.drawImage(original, 0, 0, tw, th, null)
    } finally {
        g.dispose()
    }
    val out = java.io.ByteArrayOutputStream()
    runCatching { javax.imageio.ImageIO.write(thumb, "PNG", out) }.onFailure { return null }
    val pngBytes = out.toByteArray()
    val skiaImage = runCatching { org.jetbrains.skia.Image.makeFromEncoded(pngBytes) }.getOrNull() ?: return null
    return skiaImage.toComposeImageBitmap()
}

@Composable
internal fun ComposerAttachments(
    attachments: List<AttachmentItem>,
    onRemove: (Int) -> Unit,
    onPreview: (ByteArray) -> Unit,
    onOpenFile: (String) -> Unit = {},
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
                    ImageThumbnail(
                        name = indexed.value.name,
                        path = indexed.value.path,
                        thumbnail = indexed.value.thumbnail,
                        onRemove = { onRemove(indexed.index) },
                        onPreview = {
                            val filePath = indexed.value.path
                            ApplicationManager.getApplication().executeOnPooledThread {
                                runCatching { java.io.File(filePath).readBytes() }
                                    .getOrNull()?.let { bytes ->
                                        ApplicationManager.getApplication().invokeLater { onPreview(bytes) }
                                    }
                            }
                        },
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
                        path = indexed.value.path,
                        isImage = false,
                        thumbnail = null,
                        onRemove = { onRemove(indexed.index) },
                        onOpen = { onOpenFile(indexed.value.path) },
                    )
                }
            }
        }
    }
}

@Composable
private fun ImageThumbnail(
    name: String,
    path: String,
    thumbnail: ByteArray?,
    onRemove: () -> Unit,
    onPreview: () -> Unit,
) {
    var imageBitmap by remember { mutableStateOf<androidx.compose.ui.graphics.ImageBitmap?>(null) }
    LaunchedEffect(path, thumbnail) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val source = thumbnail ?: runCatching { java.io.File(path).readBytes() }.getOrNull()
            val decoded = source?.let { decodeToImageBitmap(it) }
            ApplicationManager.getApplication().invokeLater { imageBitmap = decoded }
        }
    }

    Box(
        modifier = Modifier.size(48.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(DevEcoTheme.popupBackground)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
            ) { onPreview() },
    ) {
        if (imageBitmap != null) {
            Image(
                bitmap = imageBitmap!!,
                contentDescription = name,
                contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                modifier = Modifier.fillMaxSize().clip(RoundedCornerShape(6.dp)),
            )
        } else {
            Icon(
                key = AllIconsKeys.FileTypes.Image,
                contentDescription = null,
                modifier = Modifier.size(24.dp).align(Alignment.Center),
            )
        }
        // Remove button overlay
        Box(
            Modifier.align(Alignment.TopEnd).padding(2.dp)
                .clip(CircleShape)
                .background(Color(0x99000000))
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                ) { onRemove() }
                .padding(2.dp),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                key = AllIconsKeys.Actions.Close,
                contentDescription = "Remove image",
                modifier = Modifier.size(10.dp),
                tint = Color.White,
            )
        }
    }
}


// --- Attachment support ---

@Composable
internal fun AddAttachmentButton(
    muted: Color,
    onSelectFile: () -> Unit,
    onSelectImage: () -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val interactionSource = remember { MutableInteractionSource() }
    val hovered by interactionSource.collectIsHoveredAsState()
    Box {
        Box(
            Modifier.clip(RoundedCornerShape(7.dp))
                .background(if (hovered || expanded) DevEcoTheme.pressedAccentSoft else Color.Transparent)
                .clickable(
                    interactionSource = interactionSource,
                    indication = null,
                ) { expanded = true }
                .padding(5.dp),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                key = DevEcoIcons.iconKey("add"),
                contentDescription = "Add attachment",
                modifier = Modifier.size(16.dp),
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
                        iconKey = DevEcoIcons.iconKey("file"),
                        text = MyMessageBundle.message("composer.attachment.file"),
                        onClick = {
                            expanded = false
                            onSelectFile()
                        },
                    )
                    AttachmentTypeItem(
                        iconKey = DevEcoIcons.iconKey("picture"),
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
            .padding(horizontal = 4.dp)
            .clip(RoundedCornerShape(6.dp))
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
    path: String,
    isImage: Boolean,
    thumbnail: ByteArray? = null,
    onRemove: () -> Unit,
    onPreview: () -> Unit = {},
    onOpen: () -> Unit = {},
) {
    Row(
        Modifier.clip(RoundedCornerShape(6.dp))
            .background(DevEcoTheme.muted.copy(alpha = 0.12f))
            .then(
                if (isImage && thumbnail != null)
                    Modifier.clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { onPreview() }
                else if (!isImage)
                    Modifier.clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { onOpen() }
                else Modifier
            )
            .padding(horizontal = 8.dp, vertical = 5.dp),
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
            FileIcon(filePath = path, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(4.dp))
        }
        Text(
            name,
            color = DevEcoTheme.attachmentNameFg,
            fontSize = 13.sp,
            fontWeight = androidx.compose.ui.text.font.FontWeight.Medium,
            lineHeight = 16.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 180.dp),
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
