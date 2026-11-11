package org.deveco.code.action

import com.intellij.openapi.project.Project
import org.deveco.code.acp.AcpClientService
import org.deveco.code.session.SessionStorage
import org.deveco.code.session.SessionViewStateStore
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

    // Toolbar creation guard: set by newSession(), cleared by sidebar state updates
    // (every list refresh ends with busy = false) and by its own failure paths. It spans
    // only the toolbar's own creation flow — bridge deliveries hold [deliveryGuard]
    // instead, precisely because this flag's lifetime is not theirs to own.
    @Volatile
    var busy: Boolean = false

    // Creation guard for a staged bridge delivery, claimed at dispatch and released by
    // the handoff lifecycle alone (consumption, supersession, settlement, pre-staging
    // failure). Separate from [busy] by construction: the sidebar's state writes can
    // clear busy mid-delivery, but no code path from them reaches this guard.
    internal val deliveryGuard = HandoffDeliveryGuard()

    // Staged handoffs, keyed by their target session. Keyed entries are isolated: a jump
    // or bridge delivery for one session never clobbers another's. The next-session slot
    // addresses whichever session a creation flow produces (Quick Chat, a jump whose
    // target was deleted) and is promoted to a keyed entry by that flow before its tab opens.
    private val handoffs = ChatHandoffMailbox()

    /** Last session ID targeted by a "Jump to DevEco Code" action, for sticky reuse. */
    @Volatile
    var lastJumpSessionId: String? = null

    /** Live sidebar list-state callbacks; null while the tool window composition is disposed. */
    @Volatile
    internal var uiOnStateChange: (((SessionsUiState) -> SessionsUiState) -> Unit)? = null

    @Volatile
    internal var uiOnRefresh: (() -> Unit)? = null

    /** Stages [handoff] for the editor that binds [sessionId]. */
    internal fun stageHandoff(sessionId: String, handoff: PendingChatHandoff) {
        // A superseded bridge delivery held the delivery guard until consumption; the
        // replacing handoff will not release it, so release it here.
        if (handoffs.stage(sessionId, handoff)?.releaseGuardOnConsume == true) deliveryGuard.release()
    }

    /** Stages [handoff] for whichever session the next creation produces. */
    internal fun stageNextSessionHandoff(handoff: PendingChatHandoff) = handoffs.stageNext(handoff)

    /** Drops the next-session handoff; for callers that know no creation will consume it. */
    internal fun removeNextSessionHandoff() {
        handoffs.takeNext()
    }

    /** Promotes the next-session slot to a keyed entry once the created session id is known. */
    internal fun rekeyNextSessionHandoff(sessionId: String) = handoffs.rekeyNext(sessionId)

    /** Atomically takes the handoff staged for [sessionId], next-session slot as fallback. */
    internal fun takeHandoff(sessionId: String): PendingChatHandoff? = handoffs.take(sessionId)

    /** Removes [handoff] for [sessionId] only if it is still the staged instance. */
    internal fun removeHandoff(sessionId: String, handoff: PendingChatHandoff): Boolean =
        handoffs.remove(sessionId, handoff)

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
            ops.createNewSession(
                onStateChange = effectiveOnStateChange,
                onRefresh = effectiveOnRefresh,
            )
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
                        if (item.info.sessionId.value == sessionId) {
                            SessionItem(
                                info = item.info.copy(
                                    title = title ?: item.info.title,
                                    updatedAt = now,
                                ),
                                favorite = item.favorite,
                            )
                        } else {
                            item
                        }
                    },
                )
            }
        }
    }

    /**
     * Runs the new-session handler under the creation guards: rejected while a toolbar
     * creation is already in flight or while a bridge delivery is staged and unconsumed,
     * and when no handler is registered (the tool window is not composed yet); a staged
     * next-session handoff then simply waits for a later creation to consume it.
     */
    fun newSession(): Boolean {
        if (busy || deliveryGuard.inFlight) return false
        val handler = newSessionHandler ?: return false
        busy = true
        try {
            handler.invoke()
        } catch (error: Throwable) {
            busy = false
            throw error
        }
        return true
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
