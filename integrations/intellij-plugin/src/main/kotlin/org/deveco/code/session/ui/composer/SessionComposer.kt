package org.deveco.code.session.ui.composer

import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import com.intellij.openapi.vfs.LocalFileSystem
import org.deveco.code.session.SessionController
import com.intellij.openapi.project.Project
import androidx.compose.ui.graphics.Color

@OptIn(ExperimentalTextApi::class)
@Composable
internal fun SessionComposer(
    controller: SessionController,
    project: Project,
    background: Color,
    muted: Color,
    accent: Color,
    initialDraft: String,
    onDraftChanged: (String) -> Unit,
) {
    var input by remember {
        mutableStateOf(TextFieldValue(initialDraft, selection = TextRange(initialDraft.length)))
    }
    val focusRequester = remember { FocusRequester() }

    LaunchedEffect(focusRequester) {
        focusRequester.requestFocus()
    }

    fun resolveMentions(text: String): String {
        val pattern = Regex("@(\\S+)")
        val baseDir = project.basePath ?: return text
        return pattern.replace(text) { match ->
            val relPath = match.groupValues[1]
            val fullPath = if (java.io.File(relPath).isAbsolute) relPath else "$baseDir/$relPath"
            val file = LocalFileSystem.getInstance().findFileByPath(fullPath)
            if (file != null) {
                "@$fullPath"
            } else {
                match.value
            }
        }
    }

    fun send() {
        val trimmed = input.text.trim()
        if (trimmed.isEmpty() && controller.attachments.isEmpty() && controller.fileReferences.isEmpty()) return
        if (!controller.ready || controller.memoryLimitReached) return
        controller.sendPrompt(resolveMentions(trimmed))
        input = TextFieldValue("")
        onDraftChanged("")
        focusRequester.requestFocus()
    }

    val sendEnabled = controller.ready && !controller.memoryLimitReached &&
        (input.text.isNotBlank() || controller.attachments.isNotEmpty() || controller.fileReferences.isNotEmpty())

    ComposerContent(
        controller = controller,
        project = project,
        background = background,
        muted = muted,
        accent = accent,
        input = input,
        onInputChanged = { input = it },
        placeholder = org.deveco.code.MyMessageBundle.message("session.composer.placeholder"),
        enabled = !controller.memoryLimitReached,
        onSend = { send() },
        onStop = { controller.stopSession() },
        sendEnabled = sendEnabled,
        isResponding = controller.responding,
        onDraftChanged = onDraftChanged,
        focusRequester = focusRequester,
    )

    // Image viewer popup —shown when user clicks a thumbnail (in composer or chat messages).
    val currentViewerBytes = controller.viewerBytes
    if (currentViewerBytes != null) {
        ImageViewerPopup(
            imageBytes = currentViewerBytes,
            onDismiss = { controller.dismissImageViewer() },
        )
    }
}
