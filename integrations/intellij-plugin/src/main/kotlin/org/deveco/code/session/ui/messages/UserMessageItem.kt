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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.intellij.openapi.application.ApplicationManager
import kotlinx.coroutines.delay
import org.deveco.code.DevEcoIcons
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.deveco.code.session.SessionController
import org.deveco.code.session.model.AttachmentItem
import org.deveco.code.session.model.ChatItem
import org.deveco.code.session.ui.composer.FileReferenceChipRow
import org.deveco.code.session.ui.composer.ImageViewerPopup
import org.deveco.code.session.ui.composer.decodeToImageBitmap
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.icon.PathIconKey
import org.jetbrains.jewel.ui.icons.AllIconsKeys

private val CheckmarkIconKey = PathIconKey("/icons/checkmark.svg", DevEcoTheme::class.java)

@Composable
internal fun UserMessage(
    item: ChatItem,
    accent: Color,
    background: Color,
    controller: SessionController?,
    onOverlayLift: ((Boolean) -> Unit)? = null,
) {
    // Server-side injections tagged audience=[assistant] are model-facing, not user-facing.
    if (item.internalOnly) return
    val clipboardManager = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    var tick by remember { mutableStateOf(0) }

    LaunchedEffect(item.createdAt) {
        while (true) {
            delay(60_000L)
            tick++
        }
    }

    val bubbleInteractionSource = remember { MutableInteractionSource() }
    val isBubbleHovered by bubbleInteractionSource.collectIsHoveredAsState()

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.End,
        verticalAlignment = Alignment.Top,
    ) {
        // Box so the timestamp overlay can be positioned without affecting layout
        Box(
            modifier = Modifier
                .widthIn(max = DevEcoTheme.userBubbleMaxWidth.dp)
                .hoverable(bubbleInteractionSource),
        ) {
            Column(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .clip(RoundedCornerShape(DevEcoTheme.userBubbleRadius.dp))
                    .background(DevEcoTheme.userBubbleBg)
                    .padding(
                        horizontal = DevEcoTheme.userBubblePaddingH.dp,
                        vertical = DevEcoTheme.userBubblePaddingV.dp,
                    ),
            ) {
                val hasTextAfter = item.text.isNotBlank()
                if (item.attachments.isNotEmpty()) {
                    UserAttachmentChips(item.attachments, controller)
                    if (item.fileReferences.isNotEmpty() || hasTextAfter) {
                        Spacer(Modifier.height(6.dp))
                    }
                }
                if (item.fileReferences.isNotEmpty()) {
                    FileReferenceChipRow(
                        fileRefs = item.fileReferences,
                        onRemove = { /* Read-only in history */ },
                        onClick = { fileRef ->
                            val line = if (fileRef.hasLineRange) fileRef.startLine - 1 else 0
                            controller?.openFileAtLine(fileRef.path, line)
                        },
                        modifier = Modifier.then(if (hasTextAfter) Modifier.padding(bottom = 6.dp) else Modifier),
                    )
                }
                // User bubble is deliberately plain text: no markdown rendering, so typed
                // line breaks and log/path content show exactly as entered.
                if (item.text.isNotBlank()) {
                    Text(
                        text = item.text,
                        color = DevEcoTheme.foreground,
                        fontSize = 14.sp,
                        modifier = Modifier.wrapContentWidth(),
                    )
                }
            }

            // Overlay: positioned below the bubble via offset, never affects layout
            if (item.createdAt > 0) {
                val timestampInteractionSource = remember { MutableInteractionSource() }
                val timestampHovered by timestampInteractionSource.collectIsHoveredAsState()
                // Debounce hover: 300ms delay before showing full timestamp so quick
                // mouse passes don't flicker; exit is immediate.
                var timestampDebounced by remember { mutableStateOf(false) }
                LaunchedEffect(timestampHovered) {
                    if (timestampHovered) {
                        delay(300L)
                        timestampDebounced = true
                    } else {
                        timestampDebounced = false
                    }
                }
                val copyInteractionSource = remember { MutableInteractionSource() }
                val copyHovered by copyInteractionSource.collectIsHoveredAsState()

                // Debounced visibility: show immediately when any of the three is hovered,
                // hide after 500ms delay only when all three are unhovered
                var overlayVisible by remember { mutableStateOf(false) }
                LaunchedEffect(isBubbleHovered, timestampHovered, copyHovered) {
                    if (isBubbleHovered || timestampHovered || copyHovered) {
                        overlayVisible = true
                    } else {
                        delay(500L)
                        overlayVisible = false
                    }
                }

                // The overlay hangs below the bubble, outside this list item's bounds;
                // LazyColumn draws later items on top of it, so ask the list to lift
                // this item while the overlay shows or the next message covers it.
                LaunchedEffect(overlayVisible) { onOverlayLift?.invoke(overlayVisible) }
                DisposableEffect(Unit) { onDispose { onOverlayLift?.invoke(false) } }

                // Keyed on tick so the relative time re-formats every minute; reading
                // tick here (not as a bare statement) registers the snapshot read.
                val now = remember(tick) { System.currentTimeMillis() }

                val overlayAlpha by animateFloatAsState(
                    targetValue = if (overlayVisible) 1f else 0f,
                    animationSpec = tween(durationMillis = 150),
                    label = "overlayAlpha",
                )

                Row(
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .offset(y = DevEcoTheme.actionButtonSize.dp + 2.dp)
                        .alpha(overlayAlpha),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // On hover, the relative time crossfades in place into the full
                    // timestamp. IntrinsicSize.Max reserves the wider of the two so
                    // the Row layout never shifts when the displayed text changes.
                    val hoverAlpha by animateFloatAsState(
                        targetValue = if (timestampDebounced) 1f else 0f,
                        animationSpec = tween(durationMillis = 150),
                        label = "timestampHoverAlpha",
                    )
                    // CenterEnd: anchor both texts' right edge to the Box's right
                    // edge so "15:18" sits flush against the Spacer+copy button —
                    // same position as before the Box was widened for the crossfade.
                    Box(
                        modifier = Modifier
                            .width(IntrinsicSize.Max)
                            .height(DevEcoTheme.actionButtonSize.dp)
                            .hoverable(timestampInteractionSource),
                        contentAlignment = Alignment.CenterEnd,
                    ) {
                        Text(
                            text = MessageTimeFormatter.format(item.createdAt, now),
                            color = DevEcoTheme.muted,
                            fontSize = 11.sp,
                            modifier = Modifier
                                .fillMaxHeight()
                                .wrapContentHeight(Alignment.CenterVertically)
                                .alpha(1f - hoverAlpha),
                        )
                        Text(
                            text = MessageTimeFormatter.formatHover(item.createdAt),
                            color = DevEcoTheme.muted,
                            fontSize = 11.sp,
                            fontFamily = FontFamily.Monospace,
                            modifier = Modifier
                                .fillMaxHeight()
                                .wrapContentHeight(Alignment.CenterVertically)
                                .alpha(hoverAlpha),
                        )
                    }
                    Spacer(Modifier.width(4.dp))
                    Box(modifier = Modifier.hoverable(copyInteractionSource)) {
                        ActionButton(
                            onClick = {
                                clipboardManager.setText(AnnotatedString(item.text))
                                copied = true
                            },
                            tint = DevEcoTheme.muted.copy(alpha = DevEcoTheme.mutedActionAlpha),
                            hoverTint = DevEcoTheme.linkAccent,
                            hoverBackground = DevEcoTheme.copyActionHoverBackground,
                            tooltipText = if (overlayVisible) MyMessageBundle.message("message.tooltip.copy") else null,
                        ) { _ ->
                            if (copied) {
                                Icon(
                                    key = CheckmarkIconKey,
                                    contentDescription = "Copied",
                                    tint = DevEcoTheme.green,
                                    modifier = Modifier.size(DevEcoTheme.actionIconSize.dp),
                                )
                            } else {
                                Icon(
                                    key = DevEcoIcons.iconKey("copy"),
                                    contentDescription = "Copy",
                                    modifier = Modifier.size(DevEcoTheme.actionIconSize.dp),
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    LaunchedEffect(copied) {
        if (copied) {
            delay(COPIED_INDICATOR_MS)
            copied = false
        }
    }
}

@Composable
private fun UserAttachmentChips(attachments: List<AttachmentItem>, controller: SessionController?) {
    val images = attachments.filter { it.isImage }
    val files = attachments.filter { !it.isImage }

    if (images.isNotEmpty()) {
        FlowRow(
            modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            images.forEach { att ->
                UserImageThumbnail(att)
            }
        }
    }
    if (files.isNotEmpty()) {
        FlowRow(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            files.forEach { att ->
                Row(
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .background(DevEcoTheme.muted.copy(alpha = 0.12f))
                        .then(
                            if (controller != null)
                                Modifier.clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {
                                    controller.openFileAtLine(att.path, 0)
                                }
                            else Modifier
                        )
                        .padding(horizontal = 8.dp, vertical = 5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    FileIcon(filePath = att.path, modifier = Modifier.size(14.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(
                        text = att.name,
                        color = DevEcoTheme.mutedGray,
                        fontSize = 12.sp,
                        fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.widthIn(max = 180.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun UserImageThumbnail(att: AttachmentItem) {
    var imageBitmap by remember { mutableStateOf<androidx.compose.ui.graphics.ImageBitmap?>(null) }
    LaunchedEffect(att.path, att.thumbnail) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val source = att.thumbnail ?: runCatching { java.io.File(att.path).readBytes() }.getOrNull()
            val decoded = source?.let { decodeToImageBitmap(it) }
            ApplicationManager.getApplication().invokeLater { imageBitmap = decoded }
        }
    }
    var previewBytes by remember { mutableStateOf<ByteArray?>(null) }
    Box(
        modifier = Modifier.size(48.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(DevEcoTheme.popupBackground)
            .border(1.dp, DevEcoTheme.popupBorder, RoundedCornerShape(6.dp))
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
            ) {
                if (previewBytes == null) {
                    ApplicationManager.getApplication().executeOnPooledThread {
                        val bytes = runCatching { java.io.File(att.path).readBytes() }.getOrNull()
                        ApplicationManager.getApplication().invokeLater { previewBytes = bytes }
                    }
                }
            },
    ) {
        if (imageBitmap != null) {
            Image(
                bitmap = imageBitmap!!,
                contentDescription = att.name,
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
    }
    if (previewBytes != null) {
        ImageViewerPopup(imageBytes = previewBytes!!, onDismiss = { previewBytes = null })
    }
}
