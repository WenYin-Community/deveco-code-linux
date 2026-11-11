package org.deveco.code.session.ui.composer

import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.ExperimentalTextApi
import com.intellij.openapi.vfs.LocalFileSystem
import org.deveco.code.action.DevEcoSessionActions
import org.deveco.code.platform.LocalDevEcoComposeFocusLost
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
    // This String state mirrors the composer field for logic and drafts; the field
    // itself is a state-based BasicTextField (see ComposerContent), whose internal
    // buffer takes IME events directly and exposes explicit selection edits for
    // programmatic writes (CMP-9380 / JBR-9928 only corrupt the TextFieldValue
    // overload, not this path).
    var input by remember(controller.sessionId) { mutableStateOf(initialDraft) }
    val focusRequester = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    val composeFocusLost = LocalDevEcoComposeFocusLost.current

    LaunchedEffect(focusRequester) {
        focusRequester.requestFocus()
    }

    LaunchedEffect(composeFocusLost) {
        if (composeFocusLost) focusManager.clearFocus(force = true)
    }

    // A prompt dropped during attachment prep (stop before dispatch) comes
    // back: restore its text only into an empty input, mirroring the TUI's
    // interrupt-before-output recall — never clobber content typed meanwhile.
    // Attachment/file chips reappear via controller state on their own.
    LaunchedEffect(controller.restoreDraft) {
        val draft = controller.restoreDraft ?: return@LaunchedEffect
        controller.restoreDraft = null
        // TUI parity (prompt/index.tsx: `if (savedPrompt && !store.prompt.input)`):
        // never clobber text typed meanwhile — the retracted prompt stays
        // recoverable from the Up/Down prompt history. Attachment/file-ref chips
        // are re-added regardless (recallDroppedPrompt): re-picking images costs
        // more than a chip mixed into a fresh draft, and history holds them too.
        if (input.isEmpty()) {
            input = draft
            onDraftChanged(draft)
            focusRequester.requestFocus()
        }
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
        val trimmed = input.trim()
        if (trimmed.isEmpty() && controller.attachments.isEmpty() && controller.fileReferences.isEmpty() && controller.pendingPrompt == null) return
        // "/new" is client-side navigation, not a prompt: the slash popup only inserts
        // it, so creating the session here keeps selection and send consistent.
        if (trimmed == "/new") {
            input = ""
            onDraftChanged("")
            DevEcoSessionActions.forProject(project).newSession()
            return
        }
        if (!controller.ready || controller.memoryLimitReached) return
        controller.sendPrompt(resolveMentions(trimmed))
        input = ""
        onDraftChanged("")
        focusRequester.requestFocus()
    }

    val sendEnabled = controller.ready && !controller.memoryLimitReached &&
        (input.isNotBlank() || controller.attachments.isNotEmpty() || controller.fileReferences.isNotEmpty() || controller.pendingPrompt != null)

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
        isResponding = controller.responding || controller.serverTurn,
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
