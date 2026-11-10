package org.deveco.code.acp

import com.agentclientprotocol.annotations.UnstableApi
import com.agentclientprotocol.model.ContentBlock
import com.agentclientprotocol.model.RequestPermissionOutcome
import com.agentclientprotocol.model.RequestPermissionRequest
import com.agentclientprotocol.model.RequestPermissionResponse
import com.agentclientprotocol.model.SessionConfigOption
import com.agentclientprotocol.model.SessionInfo
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import kotlinx.coroutines.CancellationException
import org.deveco.code.session.SessionStorage
import org.deveco.code.sidebar.SessionStatusTracker
import java.io.IOException
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Project-level facade over the shared [SharedAcpBackend].
 *
 * One `deveco acp` subprocess per IDE is owned by the app-level backend and
 * shared across all open projects; this service keeps what is genuinely
 * per-project (listeners, permission handlers, status tracking, the IDE MCP
 * endpoint, this project's working directory) and delegates every connection
 * operation to the shared backend, which routes session updates and permission
 * requests back here by session id.
 *
 * Also a Disposer anchor: the IDE MCP session and the backend attachment are
 * its children, torn down by the tree on project close — dispose() is empty.
 *
 * Declared as a projectService in plugin.xml (not a light service): see the
 * service declarations there for the dynamic-reload rationale.
 */
@OptIn(UnstableApi::class)
class AcpClientService(private val project: Project) : Disposable {

    companion object {
        private val log = Logger.getInstance(AcpClientService::class.java)
    }

    private val shared = ApplicationManager.getApplication().getService(SharedAcpBackend::class.java)

    private val sessionListeners = CopyOnWriteArrayList<(AcpSessionUpdate) -> Unit>()
    private val queuePositionListeners =
        CopyOnWriteArrayList<(String, SessionStatusInfo) -> Unit>()
    private val permissionHandlers =
        CopyOnWriteArrayList<suspend (RequestPermissionRequest) -> RequestPermissionResponse?>()
    private val elicitationHandlers =
        CopyOnWriteArrayList<suspend (ElicitationRequest) -> ElicitationResponse?>()

    // Lives on the shared backend so mutations are serialized across projects.
    internal val backendMutationLock get() = shared.backendMutationLock

    private val sessionStatusTracker = SessionStatusTracker()

    // child session id → parent, learned from dispatch updates and resyncs; the
    // status stream carries child ids only, so this is the routing table.
    private val childParents = ConcurrentHashMap<String, String>()
    private val busyChildren = ConcurrentHashMap.newKeySet<String>()

    // Settled since last seen busy; idle events and resync repairs overlap.
    private val settledChildren = ConcurrentHashMap.newKeySet<String>()

    // Children whose idle arrived while a descendant still ran; the last
    // descendant's settle drains them, so no partial result merges early.
    private val deferredSettles = ConcurrentHashMap.newKeySet<String>()

    // Sessions proven to have no parent, so their busy events must not trigger
    // resyncs; never cleared — an idle session is absent from the busy-only
    // probe by design, and clearing would unlearn every not-currently-busy root.
    private val rootOnlySessions = ConcurrentHashMap.newKeySet<String>()

    private val backgroundSettledHandlers = CopyOnWriteArrayList<(String, String, String?) -> Unit>()

    /** Called when a background subagent leaves the backend's busy set. */
    fun addBackgroundSettledHandler(handler: (childSessionId: String, state: String, finalText: String?) -> Unit) {
        backgroundSettledHandlers.add(handler)
    }

    fun removeBackgroundSettledHandler(
        handler: (childSessionId: String, state: String, finalText: String?) -> Unit,
    ) {
        backgroundSettledHandlers.remove(handler)
    }

    private val ideMcpSession = IdeMcpSession(project)

    init {
        Disposer.register(this, ideMcpSession)
    }

    /** This project's claim on the shared backend; null while disconnected. */
    private var attachment: SharedAcpBackend.Attachment? = null

    fun isSessionRunning(sessionId: String): Boolean = sessionStatusTracker.isRunning(sessionId)

    fun startedAt(sessionId: String): Long? = sessionStatusTracker.startedAt(sessionId)

    fun runningSnapshot(): Map<String, Long> = sessionStatusTracker.snapshot()

    fun lastDurationSnapshot(): Map<String, Long> = sessionStatusTracker.lastDurationSnapshot()

    // Multi-subscriber: every window's session list registers; a single-slot
    // setter let the last-composed window steal updates and freeze the others.
    private val runningChangedListeners = CopyOnWriteArrayList<() -> Unit>()
    private val sessionDoneListeners = CopyOnWriteArrayList<(String) -> Unit>()
    private val abnormalChangedListeners = CopyOnWriteArrayList<(String) -> Unit>()

    init {
        sessionStatusTracker.onChanged = { runningChangedListeners.toList().forEach { it() } }
        sessionStatusTracker.onSessionDone = { id -> sessionDoneListeners.toList().forEach { it(id) } }
    }

    fun addOnRunningChanged(callback: () -> Unit) {
        runningChangedListeners.add(callback)
    }

    fun removeOnRunningChanged(callback: () -> Unit) {
        runningChangedListeners.remove(callback)
    }

    fun addOnSessionDone(callback: (String) -> Unit) {
        sessionDoneListeners.add(callback)
    }

    fun removeOnSessionDone(callback: (String) -> Unit) {
        sessionDoneListeners.remove(callback)
    }

    fun addOnAbnormalChanged(callback: (String) -> Unit) {
        abnormalChangedListeners.add(callback)
    }

    fun removeOnAbnormalChanged(callback: (String) -> Unit) {
        abnormalChangedListeners.remove(callback)
    }

    private fun publishAbnormalChanged(sessionId: String) {
        abnormalChangedListeners.toList().forEach { it(sessionId) }
    }

    fun cancelSession(sessionId: String) {
        shared.cancelPromptIfLive(sessionId)
    }

    /**
     * True when the session was closed at protocol level (e.g. by delete)
     * and not re-loaded since; used to attribute late prompt failures to
     * teardown instead of surfacing them as IDE errors.
     */
    internal fun isSessionClosed(sessionId: String): Boolean = shared.isSessionClosed(sessionId)

    @Synchronized
    fun connect(): Boolean {
        if (attachment == null) {
            val token = shared.attach(this)
            try {
                // Parented on this service — project disposal detaches even if
                // disconnect() is never called.
                Disposer.register(this, token)
                attachment = token
            } catch (e: Exception) {
                // The project was disposed while attaching — drop the claim.
                token.dispose()
                log.warn("Cannot attach to the shared ACP backend", e)
                return false
            }
        }
        val connected = shared.ensureConnection()
        // The stream resyncs when it opens, which happens on the first project
        // only; a project attaching later needs its own pass. resyncSubagents
        // is async and self-serializing onto the status worker.
        if (connected) resyncSubagents()
        return connected
    }

    fun connectionState(): SharedAcpBackend.ConnectionState = shared.connectionState()

    fun statusText(): String = shared.statusText()

    fun reconnect(): Boolean {
        cachedCommands = emptyList()
        return shared.reconnect()
    }

    @Synchronized
    fun disconnect() {
        cachedCommands = emptyList()
        val token = attachment ?: return
        attachment = null
        Disposer.dispose(token)
    }

    fun listSessions(): List<SessionInfo> {
        val sessions = requireClient().listSessions(workingDirectory())
        log.debug("listSessions: ${sessions.size} sessions for cwd=${Path.of(workingDirectory()).fileName}")
        return sessions
    }

    fun activeSessionIds(): Set<String>? {
        val api = shared.httpApi() ?: return null
        return try {
            api.activeSessionIds(workingDirectory())
        } catch (e: Exception) {
            log.warn("Failed to fetch active session ids", e)
            null
        }
    }

    internal fun archiveSession(sessionId: String) {
        val api = requireHttpApi()
        api.archiveSession(sessionId, workingDirectory(), System.currentTimeMillis())
        runCatching { shared.closeSessionIfLive(sessionId) }
            .onFailure { log.warn("Archived session but failed to close its ACP runtime $sessionId", it) }
    }

    internal fun unarchiveSession(sessionId: String) {
        requireHttpApi().unarchiveSession(sessionId, workingDirectory())
    }

    internal fun mcpServerStatuses(): List<DevEcoHttpApi.McpServerStatus> =
        shared.httpApi()?.mcpServers(workingDirectory()).orEmpty()

    internal fun setMcpServerEnabled(name: String, enabled: Boolean) {
        requireHttpApi().setMcpServerEnabled(name, workingDirectory(), enabled)
    }

    internal fun addMcpServer(name: String, config: kotlinx.serialization.json.JsonObject) {
        requireHttpApi().addMcpServer(name, config, workingDirectory())
    }

    internal fun modelCatalog(): List<DevEcoHttpApi.ModelInfo> = shared.httpApi()?.models(workingDirectory()).orEmpty()

    // Readiness probe forwarded to DevEcoHttpApi.isHealthy(). Null httpApi
    // (service not connected) folds to false, matching modelCatalog()'s null
    // fold to emptyList above.
    internal fun isHealthy(): Boolean = shared.httpApi()?.isHealthy() ?: false

    internal fun availableProviders(): List<DevEcoHttpApi.ProviderInfo> {
        if (shared.httpApi() == null) log.warn("availableProviders: httpApi is null (service not connected)")
        val result = shared.httpApi()?.availableProviders(workingDirectory()).orEmpty()
        log.debug("availableProviders: returned ${result.size} providers: ${result.map { "${it.id}(${it.name})" }}")
        return result
    }

    internal fun availableProviderModels(providerId: String): List<DevEcoHttpApi.ProviderModelInfo> =
        shared.httpApi()?.availableProviderModels(providerId, workingDirectory()).orEmpty()

    internal fun customProviderIds(): Set<String> = shared.httpApi()?.customProviderIds().orEmpty()

    internal fun customProviderNpms(): Map<String, String> = shared.httpApi()?.customProviderNpms().orEmpty()

    /** Reverse-request ownership follows the window whose editor the user opened last. */
    internal fun claimSession(sessionId: String) {
        shared.claimRoute(this, sessionId)
    }

    internal fun pendingQuestions(): List<DevEcoHttpApi.PendingQuestion> =
        runCatching { shared.httpApi()?.pendingQuestions(workingDirectory()).orEmpty() }.getOrDefault(emptyList())

    internal fun replyQuestion(requestID: String, answers: List<List<String>>) {
        runCatching { shared.httpApi()?.replyQuestion(requestID, answers, workingDirectory()) }
            .onFailure { log.warn("question reply failed: requestID=$requestID", it) }
    }

    internal fun rejectQuestion(requestID: String) {
        runCatching { shared.httpApi()?.rejectQuestion(requestID, workingDirectory()) }
            .onFailure { log.warn("question reject failed: requestID=$requestID", it) }
    }

    internal fun connectProvider(
        providerId: String,
        apiKey: String?,
        models: List<DevEcoHttpApi.ProviderModelInfo> = emptyList(),
    ) {
        val api = requireHttpApi()
        log.debug(
            "connectProvider: providerId=$providerId apiKey=${if (apiKey != null) "(set)" else "null"} models=${models.size} workingDir=${Path.of(workingDirectory()).fileName}",
        )
        api.connectProvider(providerId, apiKey, workingDirectory(), models)
        log.debug("connectProvider: completed successfully for $providerId")
    }

    internal fun addCustomProvider(provider: DevEcoHttpApi.CustomProvider) {
        requireHttpApi().addCustomProvider(provider, workingDirectory())
    }

    internal fun deleteProvider(providerId: String) {
        requireHttpApi().deleteProvider(providerId, workingDirectory())
    }

    internal fun removeAuthentication(providerId: String) {
        requireHttpApi().removeAuthentication(providerId, workingDirectory())
    }

    internal fun deleteAuthentication(providerId: String) {
        val api = requireHttpApi()
        log.debug("deleteAuthentication: DELETE /auth/$providerId")
        api.deleteAuthentication(providerId)
        log.debug("deleteAuthentication: completed for $providerId")
    }

    internal fun storeApiKey(providerId: String, apiKey: String) {
        requireHttpApi().storeApiKey(providerId, apiKey)
    }

    internal fun deleteProviderModel(providerId: String, modelId: String) {
        requireHttpApi().deleteProviderModel(providerId, modelId, workingDirectory())
    }

    internal fun skillEntries(): List<DevEcoHttpApi.SkillEntry> = shared.httpApi()?.skills(workingDirectory()).orEmpty()

    // Last successful /command fetch for this project. Cached here rather than in a
    // single SessionController so a fresh session can classify its first prompt even
    // before its own asynchronous refresh lands.
    @Volatile
    private var cachedCommands: List<DevEcoHttpApi.CommandEntry> = emptyList()

    internal fun commandEntries(): List<DevEcoHttpApi.CommandEntry> {
        val entries = shared.httpApi()?.commands(workingDirectory()).orEmpty()
        // Keep the last non-empty snapshot: a transient HTTP failure must not wipe
        // the classification used by sends that race with the next refresh.
        if (entries.isNotEmpty()) cachedCommands = entries
        return entries
    }

    internal fun cachedCommandEntries(): List<DevEcoHttpApi.CommandEntry> = cachedCommands

    internal fun setSkillEnabled(name: String, scope: DevEcoHttpApi.SkillScope, enabled: Boolean) {
        requireHttpApi().setSkillEnabled(name, scope, enabled, workingDirectory())
    }

    internal fun sessionDiff(sessionId: String): List<DevEcoHttpApi.FileEditDiff> =
        shared.httpApi()?.sessionDiff(sessionId, workingDirectory()).orEmpty()

    internal fun sessionMessages(sessionId: String): List<DevEcoHttpApi.SessionMessageTime> =
        shared.httpApi()?.sessionMessages(sessionId, workingDirectory()).orEmpty()

    internal fun deleteMessage(sessionId: String, messageId: String): Boolean =
        shared.httpApi()?.deleteMessage(sessionId, messageId, workingDirectory()) ?: false

    fun isConnected(): Boolean = shared.isConnected()

    /** Migration support: working directory string for source detection. */
    internal fun migrationWorkingDirectory(): String = workingDirectory()

    /** Migration support: backend-reported paths (config/projectConfig/worktree). */
    internal fun migrationPaths(): DevEcoHttpApi.CodePaths? = shared.httpApi()?.paths(workingDirectory())

    /** Migration support: HTTP façade; throws when the backend is unavailable. */
    internal fun migrationHttpApi(): DevEcoHttpApi = requireHttpApi()

    internal fun skillPaths(): DevEcoHttpApi.CodePaths? = shared.httpApi()?.paths(workingDirectory())

    internal fun refreshInstance() {
        val api = requireHttpApi()
        cachedCommands = emptyList()
        log.debug("refreshInstance: disposing instance for ${Path.of(workingDirectory()).fileName}")
        api.disposeInstance(workingDirectory())
        // Invalidate the ACP client's session config cache so the next
        // loadSession call fetches fresh configOptions from the backend.
        requireClient().invalidateSessionCache()
        log.info("refreshInstance: completed")
    }

    internal fun mcpMarketplaceList(page: Int, pageSize: Int, keyword: String?): MatrixMcpMarketplace.Page =
        MatrixMcpMarketplace.list(page, pageSize, keyword)

    internal fun mcpMarketplaceDetails(id: String): MatrixMcpMarketplace.Item = MatrixMcpMarketplace.details(id)

    internal fun addMarketplaceMcp(marketplaceId: String): String {
        val item = MatrixMcpMarketplace.details(marketplaceId)
        val installed = MatrixMcpMarketplace.configuration(item)
        addMcpServer(installed.name, installed.config)
        return installed.name
    }

    internal fun addSessionListener(listener: (AcpSessionUpdate) -> Unit) {
        sessionListeners.add(listener)
    }

    internal fun removeSessionListener(listener: (AcpSessionUpdate) -> Unit) {
        sessionListeners.remove(listener)
    }

    internal fun addQueuePositionListener(listener: (String, SessionStatusInfo) -> Unit) {
        queuePositionListeners.add(listener)
    }

    internal fun removeQueuePositionListener(listener: (String, SessionStatusInfo) -> Unit) {
        queuePositionListeners.remove(listener)
    }

    internal fun publishSessionStatus(sessionId: String, status: SessionStatusInfo) {
        for (listener in queuePositionListeners) {
            try {
                listener(sessionId, status)
            } catch (e: RuntimeException) {
                log.warn("Session status listener failed", e)
            }
        }
    }

    fun addPermissionHandler(handler: suspend (RequestPermissionRequest) -> RequestPermissionResponse?) {
        permissionHandlers.add(handler)
    }

    fun removePermissionHandler(handler: suspend (RequestPermissionRequest) -> RequestPermissionResponse?) {
        permissionHandlers.remove(handler)
    }

    // replay=true re-sends session/load even when the connection has the session cached,
    // because the backend replays the full history on every load — callers whose message
    // list is empty (a re-opened editor tab) depend on that replay for their content.
    fun loadSession(sessionId: String, replay: Boolean = false): List<SessionConfigOption> =
        shared.loadSessionFor(this, sessionId, workingDirectory(), { ideMcpSession.acquire() }, replay)

    internal fun getAvailableCommands(sessionId: String): List<org.deveco.code.session.model.CommandChoice> =
        requireClient().getAvailableCommands(sessionId)
            .map {
                org.deveco.code.session.model.CommandChoice(
                    it.first,
                    it.second,
                    org.deveco.code.session.model.CommandKindInference.infer(it.first, it.third),
                )
            }

    internal fun getCachedUsage(sessionId: String): Pair<Long, Long>? = requireClient().getCachedUsage(sessionId)

    fun unloadSession(sessionId: String) {
        shared.closeSessionIfLive(sessionId)
    }

    private val newSessionIds = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    fun newSession(): String {
        val start = System.currentTimeMillis()
        val id = shared.newSessionFor(this, workingDirectory()) { ideMcpSession.acquire() }
        newSessionIds.add(id)
        log.info("newSession: created $id in ${System.currentTimeMillis() - start}ms")
        return id
    }

    fun isNewSession(sessionId: String): Boolean = newSessionIds.remove(sessionId)

    fun deleteSession(sessionId: String) {
        val api = requireHttpApi()

        try {
            shared.closeSession(sessionId)
            if (!api.deleteSession(sessionId, workingDirectory())) {
                throw IllegalStateException("DevEco did not delete session $sessionId")
            }
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            throw IllegalStateException("Session deletion was interrupted", e)
        } catch (e: IOException) {
            throw IllegalStateException("Failed to call OpenCode HTTP API", e)
        }
    }

    /** Sends a prompt and reports the outcome via [onDone] (null = success); never blocks. */
    fun prompt(sessionId: String, text: String, onDone: (Throwable?) -> Unit) {
        promptTracked(sessionId, onDone) { connection, done -> connection.prompt(sessionId, text, done) }
    }

    /** Overload of [prompt] for prompts with prebuilt content blocks (attachments). */
    fun prompt(sessionId: String, blocks: List<ContentBlock>, onDone: (Throwable?) -> Unit) {
        promptTracked(sessionId, onDone) { connection, done -> connection.prompt(sessionId, blocks, done) }
    }

    private fun promptTracked(
        sessionId: String,
        onDone: (Throwable?) -> Unit,
        invoke: (AcpClientConnection, (Throwable?) -> Unit) -> Unit,
    ) {
        // Backend-down failures are reported through onDone (callers are on
        // the EDT) and still tracked, so the session is marked abnormal.
        val connection = try {
            requireClient()
        } catch (e: Throwable) {
            trackPrompt(sessionId, onDone) { done -> done(e) }
            return
        }
        trackPrompt(sessionId, onDone) { done -> invoke(connection, done) }
    }

    private fun trackPrompt(sessionId: String, onDone: (Throwable?) -> Unit, invoke: ((Throwable?) -> Unit) -> Unit) {
        sessionStatusTracker.markRunning(sessionId)
        invoke { error ->
            var succeeded = false
            var failed = false
            when (error) {
                null -> succeeded = true

                is CancellationException -> {}

                // user stop — neither success nor failure
                else -> failed = true
            }
            sessionStatusTracker.markDone(sessionId)
            val duration = sessionStatusTracker.lastDuration(sessionId)
            log.info("prompt: done for $sessionId, duration=${duration}ms, succeeded=$succeeded failed=$failed")
            duration?.let { SessionStorage.saveLastDuration(project, sessionId, it) }
            // A successful round recovers a previously-abnormal session so it
            // no longer shows the abnormal state/icon. A failed round marks it
            // abnormal. A cancelled round (user stop) is neither — leave the
            // prior state unchanged.
            when {
                succeeded -> {
                    SessionStorage.clearAbnormal(project, sessionId)
                    publishAbnormalChanged(sessionId)
                }

                failed -> {
                    SessionStorage.markAbnormal(project, sessionId)
                    publishAbnormalChanged(sessionId)
                }
            }
            onDone(error)
        }
    }

    fun setSessionConfigOption(sessionId: String, configId: String, value: String): List<SessionConfigOption> =
        requireClient().setConfigOption(sessionId, configId, value)

    fun setSessionMode(sessionId: String, modeId: String) = requireClient().setMode(sessionId, modeId)

    private fun requireClient(): AcpClientConnection = shared.requireConnection()

    private fun requireHttpApi(): DevEcoHttpApi =
        shared.httpApi() ?: throw IllegalStateException("DevEco Code HTTP server is not available")

    private fun workingDirectory(): String = project.basePath?.let { java.nio.file.Path.of(it).toString() }
        ?: throw IllegalStateException("The project has no working directory")

    /** Learned at dispatch: the status stream identifies children, not roots. */
    internal fun noteSubagentDispatch(parentSessionId: String, childSessionId: String) {
        childParents[childSessionId] = parentSessionId
    }

    /** Driven by the backend's session.status stream; see [SharedAcpBackend]. */
    internal fun onSessionStatusEvent(sessionId: String, status: SessionStatusInfo) {
        val active = status.type != "idle"
        val parent = childParents[sessionId]
        if (parent == null && !rootOnlySessions.contains(sessionId)) {
            // Dispatched while no tab was open, or from another client: routing
            // needs the parent edge, and the probe is HTTP — async, so this
            // event cannot use its result. Drop it; the probe's busy-set repair
            // re-derives whatever it carried.
            resyncSubagents()
            return
        }
        if (parent == null) {
            // Root session: surface retry/busy/idle transitions to the notice bar.
            publishSessionStatus(sessionId, status)
            // A root executing a server-side turn no client RPC tracks, i.e. the
            // re-prompt a background completion notice triggers; our own turns
            // are already covered by the prompt tracker.
            if (!sessionStatusTracker.isPromptInFlight(sessionId)) sessionStatusTracker.setServerTurn(sessionId, active)
            return
        }
        if (active) {
            busyChildren.add(sessionId)
            settledChildren.remove(sessionId)
            deferredSettles.remove(sessionId)
            sessionStatusTracker.setSubagentRunning(rootOf(sessionId), true)
            return
        }
        settleChild(sessionId)
    }

    /** The root session a child belongs to; subagents can nest. */
    private fun rootOf(sessionId: String): String {
        var current = sessionId
        var hop = 0
        while (hop++ < 10) {
            val parent = childParents[current] ?: return current
            current = parent
        }
        return current
    }

    /** Idempotent per busy→idle episode: the idle event and a resync repair overlap. */
    private fun settleChild(childSessionId: String) {
        if (!settledChildren.add(childSessionId)) return
        busyChildren.remove(childSessionId)
        // A child whose descendants still run is not finished: settling now would
        // merge a partial result into its card. The last descendant's settle
        // drains it.
        if (hasBusyDescendant(childSessionId)) {
            deferredSettles.add(childSessionId)
            return
        }
        finishSettle(childSessionId)
        drainDeferredSettles()
    }

    private fun finishSettle(childSessionId: String) {
        val root = rootOf(childSessionId)
        if (busyChildren.none { rootOf(it) == root }) sessionStatusTracker.setSubagentRunning(root, false)
        // The final-state read is blocking HTTP: keep it off the status worker
        // so one slow child cannot delay other sessions' events.
        ApplicationManager.getApplication().executeOnPooledThread {
            if (project.isDisposed) return@executeOnPooledThread
            val outcome = runCatching { shared.httpApi()?.sessionFinalAssistant(childSessionId, workingDirectory()) }
                .onFailure { log.debug("Failed to read finished subagent output", it) }
                .getOrNull()
            // A resumed task reuses the jobId and re-busies this same child;
            // merging the stale outcome would kill the new run's card.
            if (childSessionId in busyChildren) return@executeOnPooledThread
            for (handler in backgroundSettledHandlers) handler(childSessionId, outcome?.state ?: "completed", outcome?.body)
        }
    }

    private fun drainDeferredSettles() {
        val ready = deferredSettles.filterNot { hasBusyDescendant(it) }
        deferredSettles.removeAll(ready.toSet())
        ready.forEach { finishSettle(it) }
    }

    /** True while any known child below [sessionId] is still busy. */
    private fun hasBusyDescendant(sessionId: String): Boolean =
        busyChildren.any { hasAncestor(it, sessionId) }

    private fun hasAncestor(candidate: String, ancestor: String): Boolean {
        var current = candidate
        var hop = 0
        while (hop++ < 10) {
            val parent = childParents[current] ?: return false
            if (parent == ancestor) return true
            current = parent
        }
        return false
    }

    /**
     * Replay-time repair for background cards: the backend defers a settled
     * task's completion notice to the next user prompt after an abort, so a
     * restarted IDE replays only the dispatch "running" receipt and the card
     * spins forever. Children the backend still reports busy keep running (the
     * status stream settles them); the rest get one final-state read.
     */
    fun reconcileBackgroundCards(childSessionIds: Set<String>) {
        if (project.isDisposed || childSessionIds.isEmpty()) return
        ApplicationManager.getApplication().executeOnPooledThread {
            val busy = runCatching { shared.httpApi()?.sessionsWithBusySubagents(workingDirectory())?.busy }
                .onFailure { log.debug("Background subagent resync failed", it) }
                .getOrNull() ?: return@executeOnPooledThread
            for (child in childSessionIds) {
                if (child in busy) continue
                val outcome = runCatching { shared.httpApi()?.sessionFinalAssistant(child, workingDirectory()) }
                    .onFailure { log.debug("Failed to read finished subagent output", it) }
                    .getOrNull()
                // A resumed task re-busies the child while the read is in flight.
                if (child in busyChildren) continue
                for (handler in backgroundSettledHandlers) handler(child, outcome?.state ?: "completed", outcome?.body)
            }
        }
    }

    // One probe in the air at a time; concurrent triggers coalesce into it.
    private val resyncInFlight = AtomicBoolean(false)

    /**
     * Reconciles after (re)connecting and on first sight of an unknown session.
     * The probe is HTTP: it runs on a pooled thread — a slow one must not
     * head-of-line block the ordered status worker — and its result is applied
     * back on the worker, ordered with live events.
     */
    internal fun resyncSubagents() {
        if (project.isDisposed || !resyncInFlight.compareAndSet(false, true)) return
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val probe = runCatching { shared.httpApi()?.sessionsWithBusySubagents(workingDirectory()) }
                    .onFailure { log.debug("Background subagent resync failed", it) }
                    .getOrNull()
                shared.postStatusTask { applyResync(probe) }
            } finally {
                resyncInFlight.set(false)
            }
        }
    }

    /** Runs on the status worker; [probe] is null when the probe itself failed. */
    private fun applyResync(probe: DevEcoHttpApi.SubagentProbe?) {
        if (probe == null) return
        childParents.putAll(probe.parents)
        val reabsorbed = probe.busy.filter { probe.parents.containsKey(it) }
        busyChildren.addAll(reabsorbed)
        // A reabsorbed child may carry settled/deferred marks from an earlier
        // episode (its busy event was lost across the stream gap); mirror the
        // busy branch so its next idle can settle it instead of spinning.
        reabsorbed.forEach {
            settledChildren.remove(it)
            deferredSettles.remove(it)
        }
        // A truncated page list makes the busy set incomplete: the additive
        // learning above is safe, but repairs keyed on "absent means finished"
        // would stop sessions that are simply beyond the last page.
        if (probe.truncated) return
        // Roots stay in rootOnlySessions for good, so each session is probed at
        // most once; an idle session is absent from the busy-only probe by
        // design, and clearing would unlearn every not-currently-busy root.
        rootOnlySessions.addAll(probe.busy.filter { !probe.parents.containsKey(it) })
        // Children that went idle while no event reached us (stream gap, or a
        // resync landing between their busy and idle event) still owe a settle.
        val vanished = busyChildren - probe.busy
        busyChildren.retainAll(probe.busy)
        for (id in vanished) settleChild(id)
        // Repair the aggregate running state the stream may have missed.
        for (id in sessionStatusTracker.subagentSnapshot() + probe.roots) {
            sessionStatusTracker.setSubagentRunning(id, id in probe.roots)
        }
        for (id in sessionStatusTracker.serverTurnSnapshot()) {
            if (id !in probe.busy) sessionStatusTracker.setServerTurn(id, false)
        }
        for (id in probe.busy) {
            if (id in probe.parents || sessionStatusTracker.isPromptInFlight(id)) continue
            sessionStatusTracker.setServerTurn(id, true)
        }
    }

    /** Sidebar aggregate: sessions running beyond a client prompt. */
    fun extraRunningIds(): Set<String> = sessionStatusTracker.extraRunningIds()

    /** True while a server-side turn (a background notice re-prompt) runs for the session. */
    fun hasServerTurn(sessionId: String): Boolean = sessionStatusTracker.hasServerTurn(sessionId)

    /**
     * Null-safe [workingDirectory] for routing stream events. Canonicalized once:
     * the backend reports realpath'd directories (/tmp as /private/tmp on macOS),
     * so raw string equality would miss symlinked project prefixes.
     */
    internal val projectDirectory: String?
        get() = canonicalDirectory ?: project.basePath?.let {
            runCatching { java.io.File(it).canonicalPath }.getOrDefault(it)
        }?.also { canonicalDirectory = it }

    @Volatile
    private var canonicalDirectory: String? = null

    internal fun publishSessionUpdate(notification: AcpSessionUpdate) {
        for (listener in sessionListeners) {
            try {
                listener(notification)
            } catch (e: RuntimeException) {
                log.warn("Session update listener failed", e)
            }
        }
    }

    internal suspend fun requestPermission(request: RequestPermissionRequest): RequestPermissionResponse {
        for (handler in permissionHandlers) {
            val response = handler(request)
            if (response != null) return response
        }
        return RequestPermissionResponse(RequestPermissionOutcome.Cancelled)
    }

    internal suspend fun requestElicitation(request: ElicitationRequest): ElicitationResponse {
        for (handler in elicitationHandlers) {
            val response = handler(request)
            if (response != null) return response
        }
        return ElicitationResponse(answers = emptyMap(), accepted = false)
    }

    internal fun addElicitationHandler(handler: suspend (ElicitationRequest) -> ElicitationResponse?) {
        elicitationHandlers.add(handler)
    }

    internal fun removeElicitationHandler(handler: suspend (ElicitationRequest) -> ElicitationResponse?) {
        elicitationHandlers.remove(handler)
    }

    internal fun registerQuestionCompleter(sessionId: String, completer: (List<List<String>>?) -> Unit): () -> Unit =
        shared.registerQuestionCompleter(sessionId, completer)

    internal fun completeQuestion(sessionId: String, answers: List<List<String>>?): Boolean =
        shared.completeQuestion(sessionId, answers)

    override fun dispose() {
        // Children (attachment, IDE MCP session) are disposed by the tree first.
    }
}
