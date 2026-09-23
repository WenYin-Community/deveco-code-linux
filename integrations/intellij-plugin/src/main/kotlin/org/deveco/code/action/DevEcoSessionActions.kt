package org.deveco.code.action

import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import org.deveco.code.session.model.FileReference

@Service(Service.Level.PROJECT)
class DevEcoSessionActions {
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

    /** File reference to display as a chip in the composer (e.g., from "Jump to Chat" action). */
    @Volatile
    internal var pendingFileReference: FileReference? = null

    /** Last session ID targeted by a "Jump to DevEco Code" action, for sticky reuse. */
    @Volatile
    var lastJumpSessionId: String? = null

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
