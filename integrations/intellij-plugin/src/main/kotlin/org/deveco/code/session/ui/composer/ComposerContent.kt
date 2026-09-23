package org.deveco.code.session.ui.composer

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.*
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.ui.JBColor
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.deveco.code.action.DevEcoSessionActions
import org.deveco.code.session.SessionController
import org.deveco.code.session.editor.SessionVirtualFile
import org.deveco.code.session.Thumbnailer
import org.deveco.code.session.model.AttachmentItem
import org.deveco.code.session.model.FileReference
import org.deveco.code.session.ui.messages.SendBgIconKey
import org.deveco.code.session.ui.messages.SendIconKey
import org.deveco.code.session.ui.messages.StopIconKey
import org.jetbrains.jewel.bridge.toComposeColor
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text
import java.awt.Desktop
import java.net.URI

private val log = Logger.getInstance("ComposerContent")

private const val OPENCODE_TERMS_URL = "https://legal.cloud.huawei.com/terms/scope/huawei/deveco-code/terms.htm?code=CN&language=zh-CN&branchid=0&contenttag=default"
private const val OPENCODE_PRIVACY_URL = "https://legal.cloud.huawei.com/terms/scope/huawei/deveco-code/privacy-statement.htm?code=CN&language=zh-CN&branchid=0&contenttag=default"

private const val MAX_TEXT_SIZE_BYTES = 1_048_576L  // 1 MB
private const val MAX_IMAGE_SIZE_BYTES = 10_485_760L // 10 MB

private fun formatFileSize(bytes: Long): String {
    val kb = bytes / 1024.0
    val mb = kb / 1024.0
    return when {
        mb >= 1 -> "%.1f MB".format(mb)
        kb >= 1 -> "%.0f KB".format(kb)
        else -> "$bytes B"
    }
}

@OptIn(ExperimentalTextApi::class)
@Composable
internal fun ComposerContent(
    controller: SessionController,
    project: Project,
    background: Color,
    muted: Color,
    accent: Color,
    input: TextFieldValue,
    onInputChanged: (TextFieldValue) -> Unit,
    placeholder: String,
    enabled: Boolean,
    onSend: () -> Unit,
    onStop: () -> Unit,
    sendEnabled: Boolean,
    isResponding: Boolean,
    onDraftChanged: (String) -> Unit = {},
    focusRequester: FocusRequester = remember { FocusRequester() },
    showFooter: Boolean = true,
    compact: Boolean = false,
    localAttachments: androidx.compose.runtime.snapshots.SnapshotStateList<org.deveco.code.session.model.AttachmentItem>? = null,
    localFileReferences: androidx.compose.runtime.snapshots.SnapshotStateList<org.deveco.code.session.model.FileReference>? = null,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val textColor = DevEcoTheme.foreground
    val caretColor = JBColor.namedColor("TextField.caretForeground", 0xDFE1E5).toComposeColor()
    val borderColor = DevEcoTheme.popupBorder

    var slashDismissed by remember { mutableStateOf(false) }
    var slashIndex by remember { mutableStateOf(0) }

    var mentionDismissed by remember { mutableStateOf(false) }
    var mentionIndex by remember { mutableStateOf(0) }

    var popupMaxHeight by remember { mutableStateOf(240.dp) }
    var composerBounds by remember { mutableStateOf(IntRect.Zero) }

    val slashItems = remember(input.text, slashDismissed, controller.models, controller.commands) {
        if (slashDismissed) emptyList()
        else computeSlashItems(input.text, controller.models, controller.commands)
    }

    // Refresh skill commands from HTTP API when user first types /
    var slashTriggered by remember { mutableStateOf(false) }
    LaunchedEffect(input.text.startsWith("/")) {
        val isSlash = input.text.startsWith("/") && !slashDismissed
        if (isSlash && !slashTriggered) controller.refreshCommands()
        slashTriggered = isSlash
    }
    val slashVisible = slashItems.isNotEmpty()
    val effectiveSlashIndex = if (slashItems.isEmpty()) 0 else slashIndex.coerceIn(0, slashItems.lastIndex)

    LaunchedEffect(slashItems.size) {
        if (slashIndex > 0 && slashIndex > slashItems.lastIndex) {
            slashIndex = maxOf(0, slashItems.lastIndex)
        }
    }

    val mentionItems = remember(input.text, input.selection.end, mentionDismissed) {
        if (mentionDismissed) emptyList()
        else computeMentionItems(input.text, input.selection.end, project)
    }
    val mentionVisible = mentionItems.isNotEmpty()
    val effectiveMentionIndex = if (mentionItems.isEmpty()) 0 else mentionIndex.coerceIn(0, mentionItems.lastIndex)

    LaunchedEffect(mentionItems.size) {
        if (mentionIndex > 0 && mentionIndex > mentionItems.lastIndex) {
            mentionIndex = maxOf(0, mentionItems.lastIndex)
        }
    }

    fun selectSlashItem(item: SlashItem): Boolean {
        when (item.kind) {
            SlashItemKind.COMMAND -> {
                when (item.payload) {
                    "compact" -> {
                        if (controller.ready) controller.sendPrompt("/compact")
                        onInputChanged(TextFieldValue(""))
                        onDraftChanged("")
                    }
                    "new" -> {
                        onInputChanged(TextFieldValue(""))
                        onDraftChanged("")
                        val mgr = FileEditorManager.getInstance(project)
                        mgr.openFiles.filterIsInstance<SessionVirtualFile>()
                            .firstOrNull { it.sessionId == controller.sessionId }
                            ?.let { mgr.closeFile(it) }
                        DevEcoSessionActions.forProject(project).newSession()
                    }
                    "models" -> {
                        onInputChanged(TextFieldValue("/models ", selection = androidx.compose.ui.text.TextRange(8)))
                        onDraftChanged("/models ")
                        slashDismissed = false
                    }
                }
            }
            SlashItemKind.MODEL -> {
                item.payload?.let { controller.selectModel(it) }
                onInputChanged(TextFieldValue(""))
                onDraftChanged("")
            }
            SlashItemKind.SERVER_COMMAND -> {
                item.payload?.let { commandName ->
                    onInputChanged(TextFieldValue("/$commandName ", selection = androidx.compose.ui.text.TextRange(commandName.length + 2)))
                    onDraftChanged("/$commandName ")
                    slashDismissed = true
                }
            }
        }
        focusRequester.requestFocus()
        return true
    }

    fun selectMentionItem(item: MentionItem): Boolean {
        val total = (localAttachments ?: controller.attachments).size +
            (localFileReferences ?: controller.fileReferences).size
        if (total >= SessionController.MAX_ATTACHMENTS) {
            Messages.showInfoMessage(
                project,
                MyMessageBundle.message("attachment.limit.warning"),
                MyMessageBundle.message("attachment.limit.title"),
            )
            return false
        }
        val text = input.text
        val cursor = input.selection.end
        val beforeCursor = text.substring(0, minOf(cursor, text.length))
        val atIndex = beforeCursor.lastIndexOf('@')
        if (atIndex < 0) return false
        val before = text.substring(0, atIndex)
        val after = text.substring(cursor)
        val newText = "$before$after"
        val newCursor = atIndex
        onInputChanged(TextFieldValue(newText, selection = androidx.compose.ui.text.TextRange(newCursor)))
        onDraftChanged(newText)
        // Check if file already exists in fileReferences or attachments
        val existingFileRef = (localFileReferences ?: controller.fileReferences).any { it.path == item.path }
        val existingAttachment = (localAttachments ?: controller.attachments).any { it.path == item.path }
        if (existingFileRef || existingAttachment) {
            mentionDismissed = true
            focusRequester.requestFocus()
            return true
        }
        val fileRef = FileReference(
            path = item.path,
            startLine = 0,
            endLine = 0,
        )
        if (localFileReferences != null) localFileReferences.add(fileRef)
        else controller.addFileReference(fileRef)
        mentionDismissed = true
        focusRequester.requestFocus()
        return true
    }

    fun openFileChooser(imagesOnly: Boolean) {
        val total = (localAttachments ?: controller.attachments).size +
            (localFileReferences ?: controller.fileReferences).size
        if (total >= SessionController.MAX_ATTACHMENTS) {
            Messages.showInfoMessage(
                project,
                MyMessageBundle.message("attachment.limit.warning"),
                MyMessageBundle.message("attachment.limit.title"),
            )
            return
        }
        val descriptor = FileChooserDescriptor(true, false, false, false, false, true)
        descriptor.title = MyMessageBundle.message(
            if (imagesOnly) "composer.imageChooser.title" else "composer.fileChooser.title"
        )
        if (imagesOnly) {
            descriptor.withExtensionFilter(
                MyMessageBundle.message("composer.imageChooser.filter"),
                *SUPPORTED_IMAGE_EXTENSIONS.toTypedArray(),
            )
        } else {
            descriptor.withExtensionFilter(
                MyMessageBundle.message("composer.fileChooser.filter"),
                *SUPPORTED_TEXT_EXTENSIONS.toTypedArray(),
            )
        }
        val files = FileChooser.chooseFiles(descriptor, project, null)
        files.forEach { vfile ->
            val currentTotal = (localAttachments ?: controller.attachments).size +
                (localFileReferences ?: controller.fileReferences).size
            if (currentTotal >= SessionController.MAX_ATTACHMENTS) return@forEach
            if (vfile.isDirectory) return@forEach
            val name = vfile.name
            val path = vfile.path
            val mimeType = detectMimeType(name)
            val isSupported = isSupportedImageFile(name)

            val fileSize = vfile.length
            val maxSize = if (isSupported) MAX_IMAGE_SIZE_BYTES else MAX_TEXT_SIZE_BYTES
            if (fileSize > maxSize) {
                Messages.showInfoMessage(
                    project,
                    MyMessageBundle.message(
                        "attachment.too.large.message",
                        name,
                        formatFileSize(fileSize),
                        formatFileSize(maxSize),
                    ),
                    MyMessageBundle.message("attachment.too.large.title"),
                )
                return@forEach
            }

            // Check if file already exists in fileReferences or attachments
            val existingFileRef = (localFileReferences ?: controller.fileReferences).any { it.path == path }
            val existingAttachment = (localAttachments ?: controller.attachments).any { it.path == path }
            if (existingFileRef || existingAttachment) return@forEach

            ApplicationManager.getApplication().executeOnPooledThread {
                val originalBytes = runCatching { VfsUtilCore.loadBytes(vfile) }.onFailure { log.warn("Failed to load attachment bytes: ${vfile.path}", it) }.getOrNull()
                var thumbnail: ByteArray? = null
                if (isSupported && originalBytes != null) {
                    thumbnail = runCatching { Thumbnailer.generateThumbnail(originalBytes) }.onFailure { log.warn("Failed to generate thumbnail for ${vfile.name}", it) }.getOrNull()
                }
                ApplicationManager.getApplication().invokeLater {
                    val targetAttachments = localAttachments ?: controller.attachments
                    val existingIndex = targetAttachments.indexOfFirst { it.path == path }
                    if (existingIndex >= 0) {
                        val current = targetAttachments[existingIndex]
                        if (originalBytes != null || thumbnail != null) {
                            targetAttachments[existingIndex] = current.copy(
                                thumbnail = thumbnail ?: current.thumbnail,
                                originalBytes = originalBytes ?: current.originalBytes,
                            )
                        }
                    } else {
                        if (originalBytes != null) {
                            val item = AttachmentItem(
                                name = name, path = path, mimeType = mimeType,
                                isImage = isSupported, thumbnail = thumbnail, originalBytes = originalBytes,
                            )
                            if (localAttachments != null) localAttachments.add(item)
                            else controller.addAttachment(item)
                        }
                    }
                }
            }
            val item = AttachmentItem(
                name = name, path = path, mimeType = mimeType, isImage = isSupported,
            )
            if (localAttachments != null) localAttachments.add(item)
            else controller.addAttachment(item)
        }
        focusRequester.requestFocus()
    }

    Column(Modifier.fillMaxWidth().padding(
        start = if (compact) 0.dp else 24.dp,
        end = if (compact) 0.dp else 24.dp,
        bottom = if (compact) 0.dp else 6.dp,
    )) {
        Column(
            Modifier.fillMaxWidth()
                .clip(RoundedCornerShape(7.dp))
                .background(background)
                .border(1.dp, borderColor, RoundedCornerShape(7.dp))
                .animateContentSize()
                .padding(start = 10.dp, top = 9.dp, end = 10.dp, bottom = 0.dp),
        ) {
            val attachments = localAttachments ?: controller.attachments
            val fileRefs = localFileReferences ?: controller.fileReferences
            ComposerAttachments(
                attachments = attachments,
                muted = muted,
                onRemove = { index ->
                    if (localAttachments != null) {
                        if (index in localAttachments.indices) localAttachments.removeAt(index)
                    } else controller.removeAttachment(index)
                },
                onPreview = { controller.showImageViewer(it) },
            )
            if (fileRefs.isNotEmpty()) {
                FileReferenceChipRow(
                    fileRefs = fileRefs,
                    onRemove = { fileRef ->
                        if (localFileReferences != null) {
                            val idx = localFileReferences.indexOfFirst { it == fileRef }
                            if (idx >= 0) localFileReferences.removeAt(idx)
                        } else controller.fileReferences.remove(fileRef)
                    },
                    onClick = { fileRef ->
                        val line = if (fileRef.hasLineRange) fileRef.startLine - 1 else 0
                        controller.openFileAtLine(fileRef.path, line)
                    },
                )
            }
            BasicTextField(
                value = input,
                onValueChange = {
                    val textChanged = it.text != input.text
                    onInputChanged(it)
                    onDraftChanged(it.text)
                    if (textChanged) { slashDismissed = false; mentionDismissed = false }
                },
                enabled = enabled,
                textStyle = TextStyle(color = if (!enabled) muted else textColor, fontSize = 13.sp, lineHeight = 19.sp),
                cursorBrush = SolidColor(caretColor),
                interactionSource = interactionSource,
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp, max = 140.dp)
                    .focusRequester(focusRequester)
                    .onPreviewKeyEvent { event ->
                        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                        when {
                            mentionVisible && event.key == Key.DirectionUp -> {
                                if (mentionItems.isNotEmpty()) {
                                    mentionIndex = (mentionIndex - 1 + mentionItems.size) % mentionItems.size
                                }
                                true
                            }
                            mentionVisible && event.key == Key.DirectionDown -> {
                                if (mentionItems.isNotEmpty()) {
                                    mentionIndex = (mentionIndex + 1) % mentionItems.size
                                }
                                true
                            }
                            mentionVisible && event.key == Key.Escape -> {
                                mentionDismissed = true
                                true
                            }
                            mentionVisible && (event.key == Key.Enter || event.key == Key.Tab) && !event.isShiftPressed -> {
                                if (input.composition != null) false
                                else if (mentionItems.isNotEmpty()) selectMentionItem(mentionItems[effectiveMentionIndex])
                                else false
                            }
                            slashVisible && event.key == Key.DirectionUp -> {
                                if (slashItems.isNotEmpty()) {
                                    slashIndex = (slashIndex - 1 + slashItems.size) % slashItems.size
                                }
                                true
                            }
                            slashVisible && event.key == Key.DirectionDown -> {
                                if (slashItems.isNotEmpty()) {
                                    slashIndex = (slashIndex + 1) % slashItems.size
                                }
                                true
                            }
                            slashVisible && event.key == Key.Escape -> {
                                slashDismissed = true
                                true
                            }
                            slashVisible && (event.key == Key.Enter || event.key == Key.Tab) && !event.isShiftPressed -> {
                                if (input.composition != null) false
                                else if (slashItems.isNotEmpty()) selectSlashItem(slashItems[effectiveSlashIndex])
                                else false
                            }
                            !mentionVisible && !slashVisible && event.key == Key.DirectionUp && !event.isShiftPressed -> {
                                val prev = controller.navigateHistory(-1)
                                if (prev != null) {
                                    onInputChanged(TextFieldValue(prev, androidx.compose.ui.text.TextRange(prev.length)))
                                    onDraftChanged(prev)
                                    true
                                } else false
                            }
                            !mentionVisible && !slashVisible && event.key == Key.DirectionDown && !event.isShiftPressed -> {
                                val next = controller.navigateHistory(1)
                                val newInput = if (next != null) TextFieldValue(next, androidx.compose.ui.text.TextRange(next.length))
                                else TextFieldValue("")
                                onInputChanged(newInput)
                                onDraftChanged(newInput.text)
                                true
                            }
                            event.key == Key.Enter -> {
                                when {
                                    event.isShiftPressed -> {
                                        onInputChanged(input.insertAtSelection("\n"))
                                        onDraftChanged(input.text)
                                        true
                                    }
                                    input.composition != null -> false
                                    else -> {
                                        if (!isResponding) onSend()
                                        true
                                    }
                                }
                            }
                            else -> false
                        }
                    },
                decorationBox = { innerTextField ->
                    Box(Modifier.fillMaxWidth().heightIn(min = 38.dp)) {
                        if (input.text.isEmpty()) {
                            Text(
                                placeholder,
                                color = muted,
                                fontSize = 13.sp,
                            )
                        }
                        innerTextField()
                        ComposerPopups(
                            slashVisible = slashVisible,
                            slashItems = slashItems,
                            effectiveSlashIndex = effectiveSlashIndex,
                            onSlashSelect = { selectSlashItem(it) },
                            onSlashDismiss = { slashDismissed = true },
                            mentionVisible = mentionVisible,
                            mentionItems = mentionItems,
                            effectiveMentionIndex = effectiveMentionIndex,
                            onMentionSelect = { selectMentionItem(it) },
                            onMentionDismiss = { mentionDismissed = true },
                            background = background,
                            muted = muted,
                            accent = accent,
                            popupMaxHeight = popupMaxHeight,
                        )
                    }
                },
            )
            Spacer(Modifier.height(2.dp))
            Box(Modifier.fillMaxWidth()) {
                Row(
                    Modifier.fillMaxWidth().padding(top = 0.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        val attachmentTotal = (localAttachments ?: controller.attachments).size +
                            (localFileReferences ?: controller.fileReferences).size
                        AddAttachmentButton(
                            muted = muted,
                            supportsImages = controller.supportsImages,
                            enabled = attachmentTotal < SessionController.MAX_ATTACHMENTS,
                            onSelectFile = { openFileChooser(false) },
                            onSelectImage = { openFileChooser(true) },
                        )
                        Spacer(Modifier.width(8.dp))
                        ModeSelector(controller = controller, muted = muted)
                        Spacer(Modifier.width(8.dp))
                        ModelSelector(controller = controller, muted = muted, project = project)
                        Spacer(Modifier.width(8.dp))
                        TokenUsageRing(
                            controller = controller,
                            muted = muted,
                            textColor = textColor,
                            caretColor = caretColor,
                            borderColor = borderColor,
                            composerBounds = composerBounds,
                        )
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        val sendInteractionSource = remember { MutableInteractionSource() }
                        Box(
                            Modifier
                                .clickable(
                                    interactionSource = sendInteractionSource,
                                    indication = null,
                                    enabled = if (isResponding) true else sendEnabled,
                                ) {
                                    if (isResponding) {
                                        onStop()
                                    } else {
                                        onSend()
                                    }
                                }
                                .padding(4.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                key = SendBgIconKey,
                                contentDescription = if (isResponding) MyMessageBundle.message("session.message.stop") else MyMessageBundle.message("session.message.send"),
                                modifier = Modifier.size(32.dp),
                            )
                            if (isResponding) {
                                Icon(
                                    key = StopIconKey,
                                    contentDescription = null,
                                    modifier = Modifier.size(12.dp),
                                    tint = Color.Unspecified,
                                )
                            } else {
                                Icon(
                                    key = SendIconKey,
                                    contentDescription = null,
                                    modifier = Modifier.size(16.dp),
                                    tint = if (sendEnabled) Color.White else Color.Unspecified,
                                )
                            }
                        }
                    }
                }
            }
        }

        if (showFooter) ComposerFooter()
    }
}

@Composable
private fun ComposerPopups(
    slashVisible: Boolean,
    slashItems: List<SlashItem>,
    effectiveSlashIndex: Int,
    onSlashSelect: (SlashItem) -> Unit,
    onSlashDismiss: () -> Unit,
    mentionVisible: Boolean,
    mentionItems: List<MentionItem>,
    effectiveMentionIndex: Int,
    onMentionSelect: (MentionItem) -> Unit,
    onMentionDismiss: () -> Unit,
    background: Color,
    muted: Color,
    accent: Color,
    popupMaxHeight: androidx.compose.ui.unit.Dp,
) {
    if (slashVisible) {
        Popup(
            popupPositionProvider = AboveAnchorPopupPositionProvider,
            onDismissRequest = onSlashDismiss,
            properties = PopupProperties(focusable = false),
        ) {
            SlashCommandPopupContent(
                items = slashItems,
                selectedIndex = effectiveSlashIndex,
                background = background,
                muted = muted,
                accent = accent,
                maxHeight = popupMaxHeight,
                onSelect = onSlashSelect,
            )
        }
    }
    if (mentionVisible) {
        Popup(
            popupPositionProvider = AboveAnchorPopupPositionProvider,
            onDismissRequest = onMentionDismiss,
            properties = PopupProperties(focusable = false),
        ) {
            MentionPopupContent(
                items = mentionItems,
                selectedIndex = effectiveMentionIndex,
                background = background,
                muted = muted,
                accent = accent,
                maxHeight = popupMaxHeight,
                onSelect = onMentionSelect,
            )
        }
    }
}

@Composable
private fun ComposerFooter() {
    Column(Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, bottom = 0.dp)) {
        Spacer(Modifier.height(8.dp))
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                MyMessageBundle.message("composer.disclaimer"),
                color = DevEcoTheme.disclaimerFg,
                fontSize = 11.sp,
            )
            Spacer(Modifier.width(8.dp))
            Box(
                Modifier
                    .width(1.dp)
                    .height(12.dp)
                    .background(DevEcoTheme.disclaimerFg.copy(alpha = 0.5f))
            )
            Spacer(Modifier.width(8.dp))
            val linkColor = DevEcoTheme.disclaimerFg
            val termsInteraction = remember { MutableInteractionSource() }
            val termsHovered by termsInteraction.collectIsHoveredAsState()
            Text(
                MyMessageBundle.message("composer.termsOfUse"),
                color = if (termsHovered) linkColor.copy(alpha = DevEcoTheme.mutedActionAlpha) else linkColor,
                fontSize = 11.sp,
                modifier = Modifier
                    .drawBehind {
                        val y = size.height - 1f
                        drawLine(linkColor, Offset(0f, y), Offset(size.width, y), 1f)
                    }
                    .hoverable(termsInteraction)
                    .clickable(interactionSource = termsInteraction, indication = null) {
                        Desktop.getDesktop().browse(URI(OPENCODE_TERMS_URL))
                    },
            )
            Spacer(Modifier.width(8.dp))
            val privacyInteraction = remember { MutableInteractionSource() }
            val privacyHovered by privacyInteraction.collectIsHoveredAsState()
            Text(
                MyMessageBundle.message("composer.privacyPolicy"),
                color = if (privacyHovered) linkColor.copy(alpha = DevEcoTheme.mutedActionAlpha) else linkColor,
                fontSize = 11.sp,
                modifier = Modifier
                    .drawBehind {
                        val y = size.height - 1f
                        drawLine(linkColor, Offset(0f, y), Offset(size.width, y), 1f)
                    }
                    .hoverable(privacyInteraction)
                    .clickable(interactionSource = privacyInteraction, indication = null) {
                        Desktop.getDesktop().browse(URI(OPENCODE_PRIVACY_URL))
                    },
            )
        }
    }
}

private object AboveAnchorPopupPositionProvider : PopupPositionProvider {
    override fun calculatePosition(
        anchorBounds: IntRect,
        windowSize: IntSize,
        layoutDirection: LayoutDirection,
        popupContentSize: IntSize,
    ): IntOffset {
        val gap = 4
        val x = anchorBounds.left

        val aboveY = anchorBounds.top - popupContentSize.height - gap
        if (aboveY >= 0) return IntOffset(x, aboveY)

        val belowY = anchorBounds.bottom + gap
        if (belowY + popupContentSize.height <= windowSize.height) return IntOffset(x, belowY)

        val spaceAbove = anchorBounds.top - gap
        val spaceBelow = windowSize.height - anchorBounds.bottom - gap
        return if (spaceAbove >= spaceBelow) {
            IntOffset(x, maxOf(0, aboveY))
        } else {
            IntOffset(x, maxOf(0, windowSize.height - popupContentSize.height - gap))
        }
    }
}

private fun TextFieldValue.insertAtSelection(text: String): TextFieldValue {
    val start = selection.min
    val end = selection.max
    val newText = annotatedString.text.replaceRange(start, end, text)
    val cursor = start + text.length
    return TextFieldValue(newText, selection = androidx.compose.ui.text.TextRange(cursor))
}
