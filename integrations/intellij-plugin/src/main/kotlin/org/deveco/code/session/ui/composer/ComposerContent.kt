package org.deveco.code.session.ui.composer

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
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
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.ui.JBColor
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.deveco.code.action.DevEcoSessionActions
import org.deveco.code.session.PromptHistoryEntry
import org.deveco.code.session.SessionController
import org.deveco.code.session.Thumbnailer
import org.deveco.code.session.SendImageOptimizer
import org.deveco.code.session.model.AttachmentItem
import org.deveco.code.session.model.FileReference
import org.deveco.code.DevEcoIcons
import org.deveco.code.session.ui.messages.StopIconKey
import org.jetbrains.jewel.bridge.toComposeColor
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text
import java.awt.Desktop
import java.awt.KeyboardFocusManager
import java.awt.event.KeyEvent
import java.net.URI
import javax.swing.SwingUtilities

private val log = Logger.getInstance("ComposerContent")

private const val OPENCODE_TERMS_URL = "https://legal.cloud.huawei.com/terms/scope/huawei/deveco-code/terms.htm?code=CN&language=zh-CN&branchid=0&contenttag=default"
private const val OPENCODE_PRIVACY_URL = "https://legal.cloud.huawei.com/terms/scope/huawei/deveco-code/privacy-statement.htm?code=CN&language=zh-CN&branchid=0&contenttag=default"

@OptIn(ExperimentalTextApi::class)
@Composable
internal fun ComposerContent(
    controller: SessionController,
    project: Project,
    background: Color,
    muted: Color,
    accent: Color,
    input: String,
    onInputChanged: (String) -> Unit,
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

    // Bumped every time a popup stops showing. The popup's Swing window closes
    // asynchronously, so its dismiss callback can land after our own state already hid
    // it — sometimes after the user typed a fresh "/" — and an unguarded write would
    // suppress the next popup until the next edit. A callback carrying an older
    // generation belongs to a window we hid ourselves and is ignored.
    var slashPopupGeneration by remember { mutableStateOf(0) }
    var mentionPopupGeneration by remember { mutableStateOf(0) }

    var popupMaxHeight by remember { mutableStateOf(240.dp) }
    var composerBounds by remember { mutableStateOf(IntRect.Zero) }

    // The String overload of BasicTextField keeps the previous selection when the
    // text is replaced programmatically, leaving the caret mid-text (e.g. right
    // after the slash of an inserted command), and exposes no API to move it —
    // a remount only resets the selection to zero. Synthesize an End key on the
    // focused component instead; the desktop key mapping turns it into LINE_END,
    // which for these single-line inserts is the end of the text. User typing
    // never takes this path, so IME composition stays untouched.
    var userEdit by remember { mutableStateOf(true) }
    val fieldFocused by interactionSource.collectIsFocusedAsState()
    // Marks the synthetic bare-Enter dispatch below so onPreviewKeyEvent lets it
    // through to the text field (NEW_LINE) instead of treating it as a send.
    var pendingSyntheticNewline by remember { mutableStateOf(false) }
    LaunchedEffect(input) {
        if (userEdit) {
            userEdit = false
            return@LaunchedEffect
        }
        userEdit = false
        if (!fieldFocused) return@LaunchedEffect
        SwingUtilities.invokeLater {
            val target = KeyboardFocusManager.getCurrentKeyboardFocusManager().focusOwner
                ?: return@invokeLater
            val timestamp = System.currentTimeMillis()
            target.dispatchEvent(KeyEvent(target, KeyEvent.KEY_PRESSED, timestamp, 0, KeyEvent.VK_END, KeyEvent.CHAR_UNDEFINED))
            target.dispatchEvent(KeyEvent(target, KeyEvent.KEY_RELEASED, timestamp, 0, KeyEvent.VK_END, KeyEvent.CHAR_UNDEFINED))
        }
    }

    val slashItems = remember(input, slashDismissed, controller.models, controller.commands) {
        if (slashDismissed) emptyList()
        else computeSlashItems(input, controller.models, controller.commands)
    }

    // Refresh skill commands from HTTP API when user first types /
    var slashTriggered by remember { mutableStateOf(false) }
    LaunchedEffect(input.startsWith("/")) {
        val startsWithSlash = input.startsWith("/")
        // Leaving the slash context clears popup suppression and the selection so the
        // next "/" always starts fresh, even if a dismiss raced a programmatic change.
        if (!startsWithSlash) {
            slashDismissed = false
            slashIndex = 0
        }
        val isSlash = startsWithSlash && !slashDismissed
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

    // The String overload of BasicTextField exposes no selection, so the mention
    // scan assumes the caret sits at the end of the text (the common case while
    // typing a mention).
    val mentionItems = remember(input, mentionDismissed) {
        if (mentionDismissed) emptyList()
        else computeMentionItems(input, input.length, project)
    }
    val mentionVisible = mentionItems.isNotEmpty()
    val effectiveMentionIndex = if (mentionItems.isEmpty()) 0 else mentionIndex.coerceIn(0, mentionItems.lastIndex)

    LaunchedEffect(mentionItems.size) {
        if (mentionIndex > 0 && mentionIndex > mentionItems.lastIndex) {
            mentionIndex = maxOf(0, mentionItems.lastIndex)
        }
    }

    LaunchedEffect(slashVisible) { if (!slashVisible) slashPopupGeneration++ }
    LaunchedEffect(mentionVisible) { if (!mentionVisible) mentionPopupGeneration++ }

    fun selectSlashItem(item: SlashItem): Boolean {
        // Guarded: an unattached FocusRequester throws, and an exception escaping this
        // handler aborts the key dispatch with the popup state half-applied.
        runCatching { focusRequester.requestFocus() }
        when (item.kind) {
            SlashItemKind.COMMAND -> {
                when (item.payload) {
                    // Lifecycle/context ops act on the session itself and take no
                    // arguments: run on selection. Prompt-style server commands insert
                    // instead so the user can add arguments before sending.
                    "compact" -> {
                        if (controller.ready) controller.sendPrompt("/compact")
                        onInputChanged("")
                        onDraftChanged("")
                    }
                    "new" -> {
                        onInputChanged("")
                        onDraftChanged("")
                        DevEcoSessionActions.forProject(project).newSession()
                    }
                    "models" -> {
                        onInputChanged("/models ")
                        onDraftChanged("/models ")
                        slashDismissed = false
                    }
                }
            }
            SlashItemKind.MODEL -> {
                item.payload?.let { controller.selectModel(it) }
                onInputChanged("")
                onDraftChanged("")
            }
            SlashItemKind.SERVER_COMMAND -> {
                item.payload?.let { commandName ->
                    // No trailing space: a leftover space after the command name would
                    // read as an empty argument and keep the caret racing the synthetic
                    // End key, suppressing completions while the user backspaces.
                    onInputChanged("/$commandName")
                    onDraftChanged("/$commandName")
                    slashDismissed = true
                }
            }
        }
        return true
    }

    fun selectMentionItem(item: MentionItem): Boolean {
        val atIndex = input.lastIndexOf('@')
        if (atIndex < 0) return false
        val newText = input.substring(0, atIndex)
        onInputChanged(newText)
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
                *SUPPORTED_FILE_CHOOSER_EXTENSIONS.toTypedArray(),
            )
        }
        val files = FileChooser.chooseFiles(descriptor, project, null)
        files.forEach { vfile ->
            if (vfile.isDirectory) return@forEach
            val name = vfile.name
            val path = vfile.path
            val mimeType = detectMimeType(name)
            val isSupported = isSupportedImageFile(name)

            // Check if file already exists in fileReferences or attachments
            val existingFileRef = (localFileReferences ?: controller.fileReferences).any { it.path == path }
            val existingAttachment = (localAttachments ?: controller.attachments).any { it.path == path }
            if (existingFileRef || existingAttachment) return@forEach

            ApplicationManager.getApplication().executeOnPooledThread {
                val originalBytes = runCatching { VfsUtilCore.loadBytes(vfile) }.onFailure { log.warn("Failed to load attachment bytes: ${vfile.name}", it) }.getOrNull()
                var thumbnail: ByteArray? = null
                var optimizedBytes: ByteArray? = null
                var optimizedMime: String? = null
                if (isSupported && originalBytes != null) {
                    thumbnail = runCatching { Thumbnailer.generateThumbnail(originalBytes) }.onFailure { log.warn("Failed to generate thumbnail for ${vfile.name}", it) }.getOrNull()
                    // 方案一: pre-compress the send payload here, on the same background
                    // thread as the thumbnail, so sending just reads the cache. This
                    // removes the seconds-long decode/scale/encode window during which an
                    // immediate stop click was swallowed. buildAttachmentBlocks falls back
                    // to send-time compression if this fails or the item was restored
                    // without a cache.
                    optimizedBytes = runCatching { SendImageOptimizer.optimize(originalBytes, mimeType) }.onFailure { log.warn("Failed to pre-optimize image for ${vfile.name}", it) }.getOrNull()
                    // Decide the payload mime here, against the add-time original,
                    // so sending needs neither a disk read nor a size re-compare.
                    optimizedMime = optimizedBytes?.let { opt -> if (opt.size < originalBytes.size) "image/jpeg" else mimeType }
                }
                ApplicationManager.getApplication().invokeLater {
                    val targetAttachments = localAttachments ?: controller.attachments
                    val existingIndex = targetAttachments.indexOfFirst { it.path == path }
                    if (existingIndex >= 0) {
                        if (thumbnail != null || optimizedBytes != null) {
                            val current = targetAttachments[existingIndex]
                            targetAttachments[existingIndex] = current.copy(
                                thumbnail = thumbnail ?: current.thumbnail,
                                optimizedBytes = optimizedBytes ?: current.optimizedBytes,
                                optimizedMime = optimizedMime ?: current.optimizedMime,
                            )
                        }
                    } else {
                        val item = AttachmentItem(
                            name = name, path = path, mimeType = mimeType,
                            isImage = isSupported, thumbnail = thumbnail,
                            optimizedBytes = optimizedBytes, optimizedMime = optimizedMime,
                        )
                        if (localAttachments != null) localAttachments.add(item)
                        else controller.addAttachment(item)
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
                .padding(start = 12.dp, top = 12.dp, end = 12.dp, bottom = 2.dp),
        ) {
            val attachments = localAttachments ?: controller.attachments
            val fileRefs = localFileReferences ?: controller.fileReferences
            ComposerAttachments(
                attachments = attachments,
                onRemove = { index ->
                    if (localAttachments != null) {
                        if (index in localAttachments.indices) localAttachments.removeAt(index)
                    } else controller.removeAttachment(index)
                },
                onPreview = { controller.showImageViewer(it) },
                onOpenFile = { path -> controller.openFileAtLine(path, 0) },
            )
            if (fileRefs.isNotEmpty() || controller.pendingPrompt != null) {
                FileReferenceChipRow(
                    fileRefs = fileRefs,
                    onRemove = { fileRef ->
                        if (localFileReferences != null) {
                            val idx = localFileReferences.indexOf(fileRef)
                            if (idx >= 0) localFileReferences.removeAt(idx)
                        } else controller.fileReferences.remove(fileRef)
                    },
                    onClick = { fileRef ->
                        val line = if (fileRef.hasLineRange) fileRef.startLine - 1 else 0
                        controller.openFileAtLine(fileRef.path, line)
                    },
                ) {
                    controller.pendingPrompt?.let { pending ->
                        val preview = pending.lineSequence().firstOrNull()?.trim()?.take(20) ?: pending.take(20)
                        PendingPromptChip(
                            preview = preview,
                            onRemove = { controller.pendingPrompt = null },
                        )
                    }
                }
            }
            BasicTextField(
                value = input,
                onValueChange = {
                    val textChanged = it != input
                    onInputChanged(it)
                    onDraftChanged(it)
                    if (textChanged) {
                        userEdit = true
                        slashDismissed = false
                        mentionDismissed = false
                    }
                },
                enabled = enabled,
                textStyle = TextStyle(color = if (!enabled) muted else textColor, fontSize = 13.sp, lineHeight = 19.sp),
                cursorBrush = SolidColor(caretColor),
                interactionSource = interactionSource,
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp, max = 140.dp)
                    .focusRequester(focusRequester)
                    .onPreviewKeyEvent { event ->
                        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                        // Our own synthetic bare Enter (dispatched below to turn Shift+Enter
                        // into a newline): bypass every branch — including the mention/slash
                        // popup Enter handlers — so it reaches the text field and the desktop
                        // key mapping turns it into NEW_LINE at the real caret.
                        if (pendingSyntheticNewline) {
                            pendingSyntheticNewline = false
                            return@onPreviewKeyEvent false
                        }
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
                            mentionVisible && (event.key == Key.Enter || event.key == Key.NumPadEnter || event.key == Key.Tab) && !event.isShiftPressed -> {
                                if (mentionItems.isNotEmpty()) selectMentionItem(mentionItems[effectiveMentionIndex])
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
                            slashVisible && (event.key == Key.Enter || event.key == Key.NumPadEnter || event.key == Key.Tab) && !event.isShiftPressed -> {
                                if (slashItems.isNotEmpty()) selectSlashItem(slashItems[effectiveSlashIndex])
                                else false
                            }
                            !mentionVisible && !slashVisible && event.key == Key.DirectionUp && !event.isShiftPressed -> {
                                val prev = controller.navigateHistory(-1)
                                if (prev != null) {
                                    onInputChanged(prev.text)
                                    onDraftChanged(prev.text)
                                    val target = localAttachments ?: controller.attachments
                                    target.clear()
                                    target.addAll(prev.attachments)
                                    val targetRefs = localFileReferences ?: controller.fileReferences
                                    targetRefs.clear()
                                    targetRefs.addAll(prev.fileReferences)
                                    true
                                } else false
                            }
                            !mentionVisible && !slashVisible && event.key == Key.DirectionDown && !event.isShiftPressed -> {
                                val next = controller.navigateHistory(1)
                                val target = localAttachments ?: controller.attachments
                                val targetRefs = localFileReferences ?: controller.fileReferences
                                if (next != null) {
                                    onInputChanged(next.text)
                                    onDraftChanged(next.text)
                                    target.clear()
                                    target.addAll(next.attachments)
                                    targetRefs.clear()
                                    targetRefs.addAll(next.fileReferences)
                                } else {
                                    onInputChanged("")
                                    onDraftChanged("")
                                    target.clear()
                                    targetRefs.clear()
                                }
                                true
                            }
                            event.key == Key.Enter || event.key == Key.NumPadEnter -> {
                                when {
                                    // Shift+Enter / Shift+NumPadEnter inserts a newline. The
                                    // platform key mapping only maps a *bare* Enter/NumPadEnter to
                                    // NEW_LINE (Shift+Enter maps to null, and we'd otherwise send),
                                    // so consume the shifted key and re-dispatch a modifier-free
                                    // Enter KEY_PRESSED — the same synthetic-key mechanism the End
                                    // caret fix above already relies on. The pendingSyntheticNewline
                                    // guard at the top of this handler keeps that bare Enter from
                                    // being interpreted as a send or as a popup selection.
                                    event.isShiftPressed -> {
                                        // Capture the focus owner during the real key event (it is
                                        // the Compose host); re-resolving inside invokeLater could
                                        // hand the bare Enter to a different component if focus moved
                                        // in between. Compose key dispatch inside dispatchEvent is
                                        // synchronous, so the preview guard above has already
                                        // consumed the flag by the time it returns — the finally only
                                        // covers a dispatch that never reached the guard, since a
                                        // stale flag would swallow the user's next real Enter as a
                                        // newline instead of a send.
                                        val target = KeyboardFocusManager.getCurrentKeyboardFocusManager().focusOwner
                                        if (target != null) {
                                            pendingSyntheticNewline = true
                                            SwingUtilities.invokeLater {
                                                try {
                                                    val timestamp = System.currentTimeMillis()
                                                    target.dispatchEvent(KeyEvent(target, KeyEvent.KEY_PRESSED, timestamp, 0, KeyEvent.VK_ENTER, KeyEvent.CHAR_UNDEFINED))
                                                    target.dispatchEvent(KeyEvent(target, KeyEvent.KEY_RELEASED, timestamp, 0, KeyEvent.VK_ENTER, KeyEvent.CHAR_UNDEFINED))
                                                } finally {
                                                    pendingSyntheticNewline = false
                                                }
                                            }
                                        }
                                        true
                                    }
                                    // No composition check here (unavailable on the String
                                    // overload); on Windows the IME consumes Enter while
                                    // composing, so this only fires on committed input.
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
                        val hasContent = input.isNotEmpty() ||
                            !localAttachments.isNullOrEmpty() || controller.attachments.isNotEmpty() ||
                            !localFileReferences.isNullOrEmpty() || controller.fileReferences.isNotEmpty()
                        if (!hasContent) {
                            Text(
                                placeholder,
                                color = muted,
                                fontSize = 13.sp,
                            )
                        }
                        innerTextField()
                        // Read at composition time: the dismiss callback compares the
                        // generation of the show cycle it was attached to with the current one.
                        val slashGeneration = slashPopupGeneration
                        val mentionGeneration = mentionPopupGeneration
                        ComposerPopups(
                            slashVisible = slashVisible,
                            slashItems = slashItems,
                            effectiveSlashIndex = effectiveSlashIndex,
                            onSlashSelect = { selectSlashItem(it) },
                            onSlashDismiss = {
                                if (slashGeneration == slashPopupGeneration) {
                                    slashDismissed = true
                                }
                            },
                            mentionVisible = mentionVisible,
                            mentionItems = mentionItems,
                            effectiveMentionIndex = effectiveMentionIndex,
                            onMentionSelect = { selectMentionItem(it) },
                            onMentionDismiss = {
                                if (mentionGeneration == mentionPopupGeneration) {
                                    mentionDismissed = true
                                }
                            },
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
                        AddAttachmentButton(
                            muted = muted,
                            onSelectFile = { openFileChooser(false) },
                            onSelectImage = { openFileChooser(true) },
                        )
                        Spacer(Modifier.width(8.dp))
                        ModeSelector(controller = controller, muted = muted, inputFocusRequester = focusRequester)
                        Spacer(Modifier.width(8.dp))
                        ModelSelector(controller = controller, muted = muted, project = project, inputFocusRequester = focusRequester)
                        if (controller.tokenThreshold > 0L) {
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
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        val sendInteractionSource = remember { MutableInteractionSource() }
                        val bgIconKey = DevEcoIcons.iconKey("button-icon")
                        val sendIconKey = DevEcoIcons.iconKey("send")
                        val sendDisabledIconKey = DevEcoIcons.iconKey("send-disabled")
                        Box(
                            Modifier
                                .clickable(
                                    interactionSource = sendInteractionSource,
                                    indication = null,
                                    enabled = if (isResponding) !controller.stopping else sendEnabled,
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
                            // While a stop is in flight the button shows the same grey
                            // send icon as the disabled idle state: an existing,
                            // unmistakable "not clickable" affordance.
                            val stoppingNow = isResponding && controller.stopping
                            Icon(
                                key = bgIconKey,
                                contentDescription = if (isResponding) MyMessageBundle.message("session.message.stop") else MyMessageBundle.message("session.message.send"),
                                modifier = Modifier.size(32.dp),
                            )
                            when {
                                stoppingNow -> Icon(
                                    key = sendDisabledIconKey,
                                    contentDescription = null,
                                    modifier = Modifier.size(16.dp),
                                    tint = Color.Unspecified,
                                )
                                isResponding -> Icon(
                                    key = StopIconKey,
                                    contentDescription = null,
                                    modifier = Modifier.size(12.dp),
                                    tint = Color.Unspecified,
                                )
                                else -> Icon(
                                    key = if (sendEnabled) sendIconKey else sendDisabledIconKey,
                                    contentDescription = null,
                                    modifier = Modifier.size(16.dp),
                                    tint = Color.Unspecified,
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
                softWrap = false,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
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
                softWrap = false,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
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
                softWrap = false,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
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

@Composable
private fun PendingPromptChip(
    preview: String,
    onRemove: () -> Unit,
) {
    val interactionSource = remember { MutableInteractionSource() }

    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(Color(0x0DFFFFFF))
            .hoverable(interactionSource)
            .padding(horizontal = 8.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            key = org.jetbrains.jewel.ui.icons.AllIconsKeys.FileTypes.Text,
            contentDescription = null,
            modifier = Modifier.size(14.dp),
            tint = Color(0xFF94A3B8),
        )
        Spacer(Modifier.width(6.dp))
        Text(
            text = preview,
            color = Color(0xFF94A3B8),
            fontSize = 12.sp,
            fontFamily = FontFamily.Monospace,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 120.dp),
        )
        Spacer(Modifier.width(4.dp))
        Box(
            modifier = Modifier
                .size(14.dp)
                .clip(RoundedCornerShape(3.dp))
                .clickable { onRemove() },
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                key = org.jetbrains.jewel.ui.icons.AllIconsKeys.Actions.Close,
                contentDescription = "Remove",
                modifier = Modifier.size(10.dp),
                tint = Color(0xFF64748B),
            )
        }
    }
}
