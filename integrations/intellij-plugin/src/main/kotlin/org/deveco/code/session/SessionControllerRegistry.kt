package org.deveco.code.session

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import org.deveco.code.acp.AcpClientService
import java.util.concurrent.ConcurrentHashMap

/**
 * Project-level registry of live [SessionController]s by session ID. Keeps a controller
 * alive headless while the backend still generates for its session after the editor tab
 * closed (switching sessions closes all other session tabs), so an in-flight response
 * keeps being received and persisted. The next editor for the session re-attaches to
 * the same controller instead of creating a fresh one, which previously lost the
 * response tail and the responding state.
 */
@Service(Service.Level.PROJECT)
internal class SessionControllerRegistry(private val project: Project) : Disposable {

    private val controllers = ConcurrentHashMap<String, SessionController>()

    // Open editors attached to each controller; the controller is only a release
    // candidate when the last editor detaches (split view opens it twice).
    private val attachCounts = ConcurrentHashMap<String, Int>()

    private fun service(): AcpClientService = project.getService(AcpClientService::class.java)

    /**
     * Returns the live controller for [sessionId], re-attaching a headless one,
     * creating it via [factory] when absent. The caller must call
     * [start][SessionController.start] (idempotent).
     */
    fun acquire(sessionId: String, factory: () -> SessionController): SessionController {
        attachCounts.merge(sessionId, 1, Int::plus)
        val existing = controllers[sessionId]
        if (existing != null) {
            existing.markAttached()
            return existing
        }
        val created = controllers.computeIfAbsent(sessionId) { factory() }
        created.markAttached()
        return created
    }

    /**
     * Called when an editor closes. While the session is still generating (or a prompt
     * round-trip is between send and trackPrompt), the controller stays registered
     * headless and disposes itself once its turn finishes.
     */
    fun release(controller: SessionController) {
        val sessionId = controller.sessionId
        if (controllers[sessionId] !== controller) return
        // Another editor is still showing this controller (split view): stay attached.
        val remaining = attachCounts.computeIfPresent(sessionId) { _, count -> count - 1 } ?: 0
        if (remaining > 0) return
        attachCounts.remove(sessionId)
        val turnInFlight = service().isSessionRunning(sessionId) || controller.isTurnActive
        controller.markDetached {
            ApplicationManager.getApplication().invokeLater { disposeIfDetached(sessionId) }
        }
        if (!turnInFlight) {
            // The turn may have finished between the check above and markDetached (so the
            // markDetached callback will never fire), or its final updateUi may still be
            // queued on the EDT. Dispose on the EDT rather than here: queued persistence
            // flushes first, and disposeIfDetached no-ops if an editor re-attached.
            ApplicationManager.getApplication().invokeLater { disposeIfDetached(sessionId) }
        }
    }

    private fun disposeIfDetached(sessionId: String) {
        val controller = controllers[sessionId] ?: return
        if (!controller.detached || controller.isTurnActive || service().isSessionRunning(sessionId)) return
        if (controllers.remove(sessionId, controller)) controller.dispose()
    }

    override fun dispose() {
        controllers.values.forEach { it.dispose() }
        controllers.clear()
        attachCounts.clear()
    }

    companion object {
        fun getInstance(project: Project): SessionControllerRegistry =
            project.getService(SessionControllerRegistry::class.java)
    }
}
