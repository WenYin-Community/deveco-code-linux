package org.deveco.code.action

import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import org.deveco.code.acp.AcpClientService
import org.deveco.code.session.SessionStorage
import org.deveco.code.session.SessionViewStateStore
import org.deveco.code.session.editor.SessionFileEditor
import org.deveco.code.session.editor.SessionVirtualFile
import org.deveco.code.session.model.FileReference
import org.deveco.code.sessions.SessionOps
import org.deveco.code.sessions.ui.SessionItem
import org.deveco.code.sessions.ui.SessionsUiState

class DevEcoSessionActions(private val project: Project) {
    @Volatile
    var newSessionHandler: (() -> Unit)? = null

    @Volatile
    var stopSessionHandler: ((String) -> Unit)? = null

    @Volatile
    var promptSentHandler: ((String, String?) -> Unit)? = null

    /** Handler to jump to (reuse) an existing session with a file reference. */
    @Volatile
    internal var jumpToSessionHandler: ((String, FileReference) -> Unit)? = null

    @Volatile
    var busy: Boolean = false

    /** Draft text to pre-fill in the next new session (e.g., from "Jump to Chat" action). */
    @Volatile
    var pendingDraft: String? = null

    /** Full prompt to send instead of the draft preview (consumed once on first send). */
    @Volatile
    var pendingFullPrompt: String? = null

    /** Prompt to automatically send after session is created (consumed once). */
    @Volatile
    var autoSendPrompt: String? = null

    /** File reference to display as a chip in the composer (e.g., from "Jump to Chat" action). */
    @Volatile
    internal var pendingFileReference: FileReference? = null

    /** Last session ID targeted by a "Jump to DevEco Code" action, for sticky reuse. */
    @Volatile
    var lastJumpSessionId: String? = null

    /** Live sidebar list-state callbacks; null while the tool window composition is disposed. */
    @Volatile
    internal var uiOnStateChange: (((SessionsUiState) -> SessionsUiState) -> Unit)? = null

    @Volatile
    internal var uiOnRefresh: (() -> Unit)? = null

    // Project-level session operations: /new and the other action handlers must work
    // while the sidebar tool window is hidden — its Compose UI used to own them and is
    // disposed then. The sidebar subscribes its list state while composed (see
    // rememberSessionHandlers); until then the headless mirror below keeps busy tracking.
    internal val ops: SessionOps by lazy {
        SessionOps(
            project = project,
            service = project.getService(AcpClientService::class.java),
            viewStateStore = project.getService(SessionViewStateStore::class.java),
            sessionActions = this,
            workingDir = project.basePath ?: "",
        )
    }

    @Volatile
    private var headlessState = SessionsUiState()

    private val effectiveOnStateChange: ((SessionsUiState) -> SessionsUiState) -> Unit = { f ->
        val ui = uiOnStateChange
        if (ui != null) {
            ui { current ->
                val newState = f(current)
                if (!newState.busy) busy = false
                newState
            }
        } else {
            val newState = f(headlessState)
            headlessState = newState
            if (!newState.busy) busy = false
        }
    }

    private val effectiveOnRefresh: () -> Unit = { uiOnRefresh?.invoke() }

    init {
        newSessionHandler = {
            val existingHandled = ops.createNewSession(
                onStateChange = effectiveOnStateChange,
                onRefresh = effectiveOnRefresh,
            )
            if (existingHandled) {
                // If the reused session's tab is already open, init didn't consume
                // pendingFileReference — add it directly to the live controller.
                val pendingRef = pendingFileReference
                if (pendingRef != null) {
                    val mgr = FileEditorManager.getInstance(project)
                    val editor = mgr.openFiles.filterIsInstance<SessionVirtualFile>()
                        .flatMap { mgr.getEditors(it).toList() }
                        .filterIsInstance<SessionFileEditor>()
                        .firstOrNull()
                    if (editor != null) {
                        editor.controller.addFileReference(pendingRef)
                        pendingFileReference = null
                    }
                }
                busy = false
            }
        }
        stopSessionHandler = { id -> ops.stopSession(id) }
        jumpToSessionHandler = { sessionId, fileRef ->
            ops.jumpToSession(
                sessionId = sessionId,
                fileRef = fileRef,
                onStateChange = effectiveOnStateChange,
                onRefresh = effectiveOnRefresh,
            )
        }
        promptSentHandler = { sessionId, title ->
            ops.markInteracted(sessionId)
            if (title != null) {
                SessionStorage.setCustomTitle(project, sessionId, title)
            }
            val now = java.time.LocalDateTime.now().toString()
            effectiveOnStateChange { current ->
                current.copy(
                    sessions = current.sessions.map { item ->
                        if (item.info.sessionId.value == sessionId)
                            SessionItem(
                                info = item.info.copy(
                                    title = title ?: item.info.title,
                                    updatedAt = now,
                                ),
                                favorite = item.favorite,
                            )
                        else item
                    },
                )
            }
        }
    }

    fun newSession() {
        if (busy) return
        val handler = newSessionHandler ?: return
        busy = true
        try {
            handler.invoke()
        } catch (error: Throwable) {
            busy = false
            throw error
        }
    }

    fun stopSession(sessionId: String) {
        stopSessionHandler?.invoke(sessionId)
    }

    fun promptSent(sessionId: String, title: String?) {
        promptSentHandler?.invoke(sessionId, title)
    }

    companion object {
        fun forProject(project: Project): DevEcoSessionActions = project.getService(DevEcoSessionActions::class.java)
    }
}
