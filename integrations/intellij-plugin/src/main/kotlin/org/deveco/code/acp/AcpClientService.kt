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
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import kotlinx.coroutines.CancellationException
import org.deveco.code.session.SessionStorage
import org.deveco.code.sidebar.AgentInfo
import org.deveco.code.sidebar.McpServerInfo
import org.deveco.code.sidebar.OpencodeConfig
import org.deveco.code.sidebar.SessionStatusTracker
import org.deveco.code.sidebar.SkillInfo
import org.deveco.code.util.opencodeConfigDir
import java.io.IOException
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList

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
 */
@Service(Service.Level.PROJECT)
@OptIn(UnstableApi::class)
class AcpClientService(private val project: Project) : Disposable {

    companion object {
        private val log = Logger.getInstance(AcpClientService::class.java)
    }

    private val shared = ApplicationManager.getApplication().getService(SharedAcpBackend::class.java)

    private val sessionListeners = CopyOnWriteArrayList<(AcpSessionUpdate) -> Unit>()
    private val permissionHandlers =
        CopyOnWriteArrayList<(RequestPermissionRequest) -> RequestPermissionResponse?>()

    // Lives on the shared backend so mutations are serialized across projects.
    internal val backendMutationLock get() = shared.backendMutationLock

    private val sessionStatusTracker = SessionStatusTracker()

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

    fun setOnRunningChanged(callback: () -> Unit) {
        sessionStatusTracker.onChanged = callback
    }

    fun setOnSessionDone(callback: (String) -> Unit) {
        sessionStatusTracker.onSessionDone = callback
    }

    @Volatile
    private var onAbnormalChanged: ((String) -> Unit)? = null

    fun setOnAbnormalChanged(callback: (String) -> Unit) {
        onAbnormalChanged = callback
    }

    fun cancelSession(sessionId: String) {
        shared.cancelPromptIfLive(sessionId)
    }

    fun listAgents(): List<AgentInfo> = configReader().listAgents()

    fun listMcpServers(): List<McpServerInfo> = configReader().listMcpServers()

    fun listSkills(): List<SkillInfo> = configReader().listSkills()

    fun loadSidebarData(): Triple<List<AgentInfo>, List<McpServerInfo>, List<SkillInfo>> {
        val reader = configReader()
        return Triple(reader.listAgents(), reader.listMcpServers(), reader.listSkills())
    }

    private fun configReader(): OpencodeConfig = OpencodeConfig(
        opencodeConfigDir,
        Path.of(workingDirectory()),
        // Studio-mode project config dir from the backend; falls back to null
        // (legacy worktree .deveco scan) when the backend is unreachable.
        runCatching { shared.httpApi()?.paths(workingDirectory())?.projectConfig }.getOrNull()
            ?.let(Path::of),
    )

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
        return shared.ensureConnection()
    }

    fun connectionState(): SharedAcpBackend.ConnectionState = shared.connectionState()

    fun statusText(): String = shared.statusText()

    fun reconnect(): Boolean = shared.reconnect()

    @Synchronized
    fun disconnect() {
        val token = attachment ?: return
        attachment = null
        Disposer.dispose(token)
    }

    fun listSessions(): List<SessionInfo> {
        val sessions = requireClient().listSessions(workingDirectory())
        log.info("listSessions: ${sessions.size} sessions for cwd=${workingDirectory()}")
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

    internal fun availableProviders(): List<DevEcoHttpApi.ProviderInfo> {
        if (shared.httpApi() == null) log.warn("availableProviders: httpApi is null (service not connected)")
        val result = shared.httpApi()?.availableProviders(workingDirectory()).orEmpty()
        log.info("availableProviders: returned ${result.size} providers: ${result.map { "${it.id}(${it.name})" }}")
        return result
    }

    internal fun availableProviderModels(providerId: String): List<DevEcoHttpApi.ProviderModelInfo> =
        shared.httpApi()?.availableProviderModels(providerId, workingDirectory()).orEmpty()

    internal fun customProviderIds(): Set<String> =
        shared.httpApi()?.customProviderIds().orEmpty()

    internal fun connectProvider(
        providerId: String,
        apiKey: String?,
        models: List<DevEcoHttpApi.ProviderModelInfo> = emptyList(),
    ) {
        val api = requireHttpApi()
        log.info(
            "connectProvider: providerId=$providerId apiKey=${if (apiKey != null) "(set)" else "null"} models=${models.size} workingDir=${workingDirectory()}",
        )
        api.connectProvider(providerId, apiKey, workingDirectory(), models)
        log.info("connectProvider: completed successfully for $providerId")
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
        log.info("deleteAuthentication: DELETE /auth/$providerId")
        api.deleteAuthentication(providerId)
        log.info("deleteAuthentication: completed for $providerId")
    }

    internal fun storeApiKey(providerId: String, apiKey: String) {
        requireHttpApi().storeApiKey(providerId, apiKey)
    }

    internal fun deleteProviderModel(providerId: String, modelId: String) {
        requireHttpApi().deleteProviderModel(providerId, modelId, workingDirectory())
    }

    internal fun skillEntries(): List<DevEcoHttpApi.SkillEntry> = shared.httpApi()?.skills(workingDirectory()).orEmpty()

    internal fun setSkillEnabled(name: String, scope: DevEcoHttpApi.SkillScope, enabled: Boolean) {
        requireHttpApi().setSkillEnabled(name, scope, enabled, workingDirectory())
    }

    internal fun sessionDiff(sessionId: String): List<DevEcoHttpApi.FileEditDiff> =
        shared.httpApi()?.sessionDiff(sessionId, workingDirectory()).orEmpty()

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
        log.info("refreshInstance: disposing instance for ${workingDirectory()}")
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

    fun addPermissionHandler(handler: (RequestPermissionRequest) -> RequestPermissionResponse?) {
        permissionHandlers.add(handler)
    }

    fun removePermissionHandler(handler: (RequestPermissionRequest) -> RequestPermissionResponse?) {
        permissionHandlers.remove(handler)
    }

    fun loadSession(sessionId: String): List<SessionConfigOption> =
        shared.loadSessionFor(this, sessionId, workingDirectory()) { ideMcpSession.acquire() }

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
                    onAbnormalChanged?.invoke(sessionId)
                }

                failed -> {
                    SessionStorage.markAbnormal(project, sessionId)
                    onAbnormalChanged?.invoke(sessionId)
                }
            }
            onDone(error)
        }
    }

    fun setSessionConfigOption(sessionId: String, configId: String, value: String) =
        requireClient().setConfigOption(sessionId, configId, value)

    fun setSessionMode(sessionId: String, modeId: String) = requireClient().setMode(sessionId, modeId)

    private fun requireClient(): AcpClientConnection = shared.requireConnection()

    private fun requireHttpApi(): DevEcoHttpApi =
        shared.httpApi() ?: throw IllegalStateException("DevEco Code HTTP server is not available")

    private fun workingDirectory(): String = project.basePath?.let { java.nio.file.Path.of(it).toString() }
        ?: throw IllegalStateException("The project has no working directory")

    internal fun publishSessionUpdate(notification: AcpSessionUpdate) {
        for (listener in sessionListeners) {
            try {
                listener(notification)
            } catch (e: RuntimeException) {
                log.warn("Session update listener failed", e)
            }
        }
    }

    internal fun requestPermission(request: RequestPermissionRequest): RequestPermissionResponse {
        for (handler in permissionHandlers) {
            val response = handler(request)
            if (response != null) return response
        }
        return RequestPermissionResponse(RequestPermissionOutcome.Cancelled)
    }

    override fun dispose() {
        // Children (attachment, IDE MCP session) are disposed by the tree first.
    }
}
