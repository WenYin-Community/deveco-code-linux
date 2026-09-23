package org.deveco.code.session.ui.messages

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.deveco.code.DevEcoTheme
import org.deveco.code.session.SessionController
import org.deveco.code.session.model.AttachmentItem
import org.deveco.code.session.model.ChatItem
import org.deveco.code.session.ui.composer.FileReferenceChip
import org.jetbrains.jewel.ui.component.Text

@Composable
internal fun UserMessage(
    item: ChatItem,
    accent: Color,
    background: Color,
    controller: SessionController?,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val isHovered by interactionSource.collectIsHoveredAsState()

    val timestampAlpha by animateFloatAsState(
        targetValue = if (isHovered && item.createdAt > 0) 1f else 0f,
        animationSpec = tween(durationMillis = 150),
        label = "timestampAlpha",
    )

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.End,
        verticalAlignment = Alignment.Top,
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = DevEcoTheme.userBubbleMaxWidth.dp)
                .hoverable(interactionSource),
        ) {
            Column(
                modifier = Modifier
                    .clip(RoundedCornerShape(DevEcoTheme.userBubbleRadius.dp))
                    .background(DevEcoTheme.userBubbleBg)
                    .border(1.dp, DevEcoTheme.userBubbleBorder, RoundedCornerShape(DevEcoTheme.userBubbleRadius.dp))
                    .padding(
                        horizontal = DevEcoTheme.userBubblePaddingH.dp,
                        vertical = DevEcoTheme.userBubblePaddingV.dp,
                    ),
            ) {
                val imageAttachments = item.attachments.filter { it.isImage && it.thumbnail != null }
                if (imageAttachments.isNotEmpty()) UserImageGrid(imageAttachments, controller)
                item.fileReferences.forEach { fileRef ->
                    FileReferenceChip(
                        fileRef = fileRef,
                        onRemove = { /* Read-only in history */ },
                        onClick = {
                            val line = if (fileRef.hasLineRange) fileRef.startLine - 1 else 0
                            controller?.openFileAtLine(fileRef.path, line)
                        },
                        modifier = Modifier.padding(bottom = 6.dp),
                    )
                }
                if (item.text.isNotBlank()) {
                    MarkdownWithCodeBlocks(text = item.text, modifier = Modifier.wrapContentWidth())
                }
                val nonImageAttachments = item.attachments.filter { !it.isImage }
                if (nonImageAttachments.isNotEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    UserAttachmentChips(nonImageAttachments, accent)
                }
            }
            if (item.createdAt > 0) {
                Text(
                    text = MessageTimeFormatter.format(item.createdAt),
                    color = DevEcoTheme.muted,
                    fontSize = 11.sp,
                    modifier = Modifier
                        .align(Alignment.End)
                        .padding(top = 2.dp, end = 4.dp)
                        .graphicsLayer { alpha = timestampAlpha },
                )
            }
        }
    }
}

@Composable
private fun UserImageGrid(attachments: List<AttachmentItem>, controller: SessionController?) {
    FlowRow(
        modifier = Modifier.fillMaxWidth().padding(bottom = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        attachments.forEach { att ->
            val skiaImage = remember(att.thumbnail) {
                att.thumbnail?.let { runCatching { org.jetbrains.skia.Image.makeFromEncoded(it) }.getOrNull() }
            }
            val imageBitmap = remember(skiaImage) { skiaImage?.toComposeImageBitmap() }
            if (imageBitmap != null) {
                Column(
                    modifier = Modifier.width(80.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Box(
                        modifier = Modifier.size(80.dp)
                            .clip(RoundedCornerShape(6.dp))
                            .background(DevEcoTheme.popupBackground)
                            .clickable(
                                interactionSource = remember { MutableInteractionSource() },
                                indication = null,
                            ) {
                                att.originalBytes?.let { controller?.showImageViewer(it) }
                            },
                    ) {
                        Image(
                            bitmap = imageBitmap,
                            contentDescription = att.name,
                            modifier = Modifier.fillMaxSize().clip(RoundedCornerShape(6.dp)),
                        )
                    }
                    // Show file name below thumbnail
                    Text(
                        text = att.name,
                        color = DevEcoTheme.muted,
                        fontSize = 10.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier
                            .width(80.dp)
                            .padding(top = 2.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun UserAttachmentChips(attachments: List<AttachmentItem>, accent: Color) {
    FlowRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        attachments.forEach { att ->
            Box(
                modifier = Modifier.clip(RoundedCornerShape(4.dp))
                    .background(accent.copy(alpha = 0.15f))
                    .padding(horizontal = 6.dp, vertical = 2.dp),
            ) {
                Text(text = att.name, fontSize = 10.sp, color = DevEcoTheme.foreground)
            }
        }
    }
}
