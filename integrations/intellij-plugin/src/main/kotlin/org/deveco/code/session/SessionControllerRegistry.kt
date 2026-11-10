package org.deveco.code.session

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Condition
import org.deveco.code.acp.AcpClientService
import java.util.concurrent.ConcurrentHashMap

/**
 * Project-level registry of live [SessionController]s by session ID. Keeps a controller
 * alive headless after its editor tab closes so that an in-flight response keeps being
 * received and persisted, and so switching back re-attaches to the same controller instead
 * of replaying the whole conversation from the backend (which flashes the list empty→filled).
 *
 * Caching is opt-in per close. A session switch closes the outgoing tab via [markSwitchCloses]
 * and that controller joins a FIFO cache bounded by [MAX_CACHED_SESSIONS]; switching back then
 * reuses it. Starting a new session (the toolbar button or the /new command) is a navigation, so
 * it also caches the outgoing session. A user closing the tab directly (X / Ctrl+W) does NOT
 * cache: the controller is disposed (once idle, so a generating turn still persists its tail),
 * and reopening rebuilds and reloads from the backend.
 *
 * The oldest idle cached entry is disposed once the cap is exceeded. A controller still
 * generating is never evicted. A controller that never completed a backend load is not cached
 * either (see [retain]), so a failed load still retries on reopen. Delete and archive drop a
 * session eagerly via [evict].
 *
 * Known limitation: the cache is not invalidated when the shared ACP backend reconnects
 * (a new subprocess generation) or when a session is deleted by another client. In those
 * cases a cached controller can show stale content until it ages out or the IDE restarts;
 * the pre-cache code self-corrected because every reopen replayed from the backend. Wiring
 * a connection-generation invalidation hook is left as a follow-up. Closing a tab with the
 * X (a user close) always disposes and forces a reload on reopen, which is the immediate
 * workaround for a stale cached session. A cached (detached) controller also auto-cancels
 * permission/elicitation requests, since it has no UI to render them on — this only bites a
 * headless session the backend starts a turn for, which idle cached sessions are not.
 */
internal class SessionControllerRegistry(private val project: Project) : Disposable {

    private val log = Logger.getInstance(SessionControllerRegistry::class.java)

    // Set first in dispose(). After a plugin uninstall/disable the project container no
    // longer resolves AcpClientService, so every deferred entry point must stop before
    // calling service() — an unguarded lookup NPEs once the plugin's services are
    // unregistered, and the interrupted teardown leaks references that pin the plugin
    // classloader (dynamic unload then reports the plugin as not unload-safe).
    @Volatile
    private var disposed = false

    // Expired condition handed to invokeLater: the platform discards the submission when
    // this returns true (true == expired), so work queued while disposed never runs
    // against torn-down services.
    private val expired: Condition<Any> = Condition { disposed }

    private val controllers = ConcurrentHashMap<String, SessionController>()

    // Open editors attached to each controller; the controller is only a release
    // candidate when the last editor detaches (split view opens it twice).
    private val attachCounts = ConcurrentHashMap<String, Int>()

    // FIFO order of detached (cached) session IDs, oldest first. Only touched on the EDT
    // (acquire/release/evict all run there; retain/prune are dispatched via invokeLater).
    private val retention = ArrayDeque<String>()

    // Session IDs whose tab is being closed by a session switch (cache) rather than by the
    // user (dispose). Populated by [markSwitchCloses] right before the switch closes those
    // tabs and consumed by [release]. A set (not a time-window flag) so it is correct even
    // if the platform defers editor disposal past the switch call. EDT-confined.
    private val switchCloseIds = HashSet<String>()

    private fun service(): AcpClientService = project.getService(AcpClientService::class.java)

    // Bare-invokeLater equivalent: same defaultModalityState, same queue, so FIFO ordering
    // against the controller's own invokeLater submissions (e.g. the headless completion
    // persistence flush must run before disposeDetached tears the controller down) is
    // preserved — but the submission is dropped once this registry is disposed.
    private fun post(action: () -> Unit) {
        ApplicationManager.getApplication().invokeLater({ action() }, ModalityState.defaultModalityState(), expired)
    }

    /**
     * Records [ids] as switch-initiated tab closes so the next [release] for each caches its
     * controller instead of disposing it. Call immediately before closing those tabs. Replaces
     * any previous marks, bounding staleness to a single switch.
     */
    fun markSwitchCloses(ids: Collection<String>) {
        switchCloseIds.clear()
        switchCloseIds.addAll(ids)
    }

    /**
     * Returns the live controller for [sessionId], re-attaching a headless one,
     * creating it via [factory] when absent. The caller must call
     * [start][SessionController.start] (idempotent).
     */
    fun acquire(sessionId: String, factory: () -> SessionController): SessionController {
        attachCounts.merge(sessionId, 1, Int::plus)
        val existing = controllers[sessionId]
        if (existing != null) {
            // Re-attaching a cached controller: it is live again, not a cache candidate.
            retention.remove(sessionId)
            existing.markAttached()
            return existing
        }
        val created = controllers.computeIfAbsent(sessionId) { factory() }
        created.markAttached()
        return created
    }

    /**
     * Called when an editor closes. A switch-initiated close (marked via [markSwitchCloses])
     * keeps the controller headless in the FIFO cache for fast reuse. A user-initiated close
     * disposes it instead, so an explicitly-closed session is not kept in memory; a turn still
     * in flight delays that disposal until it finishes so its response tail is still persisted.
     */
    fun release(controller: SessionController) {
        val sessionId = controller.sessionId
        if (controllers[sessionId] !== controller) return
        // Another editor is still showing this controller (split view): stay attached.
        val remaining = attachCounts.computeIfPresent(sessionId) { _, count -> count - 1 } ?: 0
        if (remaining > 0) return
        attachCounts.remove(sessionId)
        if (switchCloseIds.remove(sessionId)) {
            controller.markDetached {
                // A turn finished while headless: the controller is now idle, so re-prune in
                // case it aged past the cap while it was protected from eviction.
                post { prune() }
            }
            // Retain on the EDT rather than here so any queued persistence flushes first, and
            // retain no-ops if an editor re-attached before this runs.
            post { retain(sessionId) }
            return
        }
        // User closed the tab: do not cache. Dispose once idle (see disposeDetached).
        controller.markDetached {
            post { disposeDetached(sessionId) }
        }
        post { disposeDetached(sessionId) }
    }

    /**
     * Drops a session from the cache and disposes its controller unconditionally (ignoring
     * the cap and any in-flight turn). Preconditions: call on the EDT, after the session's
     * editor tab is closed (so [release] already detached it and decremented [attachCounts]).
     * Intended for teardown — delete and archive. Archive is UI-gated to non-running sessions
     * (the context menu swaps it for stop-and-delete while a turn is active); delete tears the
     * controller down regardless, which is the desired outcome.
     */
    fun evict(sessionId: String) {
        retention.remove(sessionId)
        attachCounts.remove(sessionId)
        controllers.remove(sessionId)?.dispose()
    }

    private fun retain(sessionId: String) {
        if (disposed) return
        val controller = controllers[sessionId] ?: return
        // An editor re-attached between release and this EDT turn: leave it live.
        if (!controller.detached) return
        // Never cache a controller that did not complete a backend load (it failed after
        // retries, or was still loading when its tab closed). start() is idempotent, so a
        // cached one would be served as-is on reopen with no retry and prompts blocked while
        // ready=false. Dispose it to restore the pre-cache "close and reopen to reload" path.
        if (!controller.isLoaded) {
            if (controllers.remove(sessionId, controller)) controller.dispose()
            return
        }
        // Move to the most-recent end so the cap keeps the last N used conversations.
        retention.remove(sessionId)
        retention.addLast(sessionId)
        prune()
    }

    private fun prune() {
        if (disposed) return
        while (retention.size > MAX_CACHED_SESSIONS) {
            val oldest = retention.firstOrNull { isEvictable(it) } ?: return
            retention.remove(oldest)
            val controller = controllers[oldest] ?: continue
            if (controllers.remove(oldest, controller)) controller.dispose()
        }
    }

    // Disposes a user-closed controller once it is idle. A turn still in flight keeps it
    // headless until it finishes (the markDetached callback re-runs this) so its response
    // tail is still received and persisted before teardown.
    private fun disposeDetached(sessionId: String) {
        if (disposed) return
        val controller = controllers[sessionId] ?: return
        if (!controller.detached || controller.isTurnActive || service().isSessionRunning(sessionId)) return
        retention.remove(sessionId)
        if (controllers.remove(sessionId, controller)) controller.dispose()
    }

    // A cached controller that is still generating must survive to persist its response tail.
    private fun isEvictable(sessionId: String): Boolean {
        val controller = controllers[sessionId] ?: return false
        return !controller.isTurnActive && !service().isSessionRunning(sessionId)
    }

    override fun dispose() {
        // Stop deferred work first, then detach every reference before running user code:
        // an exception from any controller's dispose() must not leave entries behind (a
        // populated map pins the plugin classloader and turns a plugin uninstall into a
        // "not unload-safe" leak).
        disposed = true
        val toDispose = controllers.values.toList()
        controllers.clear()
        attachCounts.clear()
        retention.clear()
        switchCloseIds.clear()
        for (controller in toDispose) {
            try {
                controller.dispose()
            } catch (e: Exception) {
                log.warn("Failed to dispose session controller ${controller.sessionId}", e)
            }
        }
    }

    companion object {
        // Number of recently-used conversations kept loaded headless to avoid a backend
        // replay (and the resulting UI flicker) on every session switch.
        private const val MAX_CACHED_SESSIONS = 10

        fun getInstance(project: Project): SessionControllerRegistry =
            project.getService(SessionControllerRegistry::class.java)
    }
}
