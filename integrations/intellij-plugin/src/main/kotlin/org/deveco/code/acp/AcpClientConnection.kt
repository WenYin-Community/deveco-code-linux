package org.deveco.code.acp

import com.agentclientprotocol.annotations.UnstableApi
import com.agentclientprotocol.client.Client
import com.agentclientprotocol.client.ClientInfo
import com.agentclientprotocol.client.ClientOperationsFactory
import com.agentclientprotocol.client.ClientSession
import com.agentclientprotocol.common.ClientSessionOperations
import com.agentclientprotocol.common.Event
import com.agentclientprotocol.common.SessionCreationParameters
import com.agentclientprotocol.model.*
import com.agentclientprotocol.protocol.*
import com.agentclientprotocol.transport.StdioTransport
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ApplicationInfo
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.extensions.PluginId
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.produceIn
import kotlinx.coroutines.flow.toList
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.io.BufferedWriter
import java.io.File
import java.io.OutputStreamWriter
import java.nio.file.Paths
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import org.deveco.code.util.devecoStorageRoot

/**
 * One generation of the shared agent: subprocess, stdio bridge and loaded
 * sessions. Owned by [SharedAcpBackend]; [dispose] is idempotent because
 * direct teardown and the Disposer tree can both reach it.
 */
@OptIn(UnstableApi::class)
internal class AcpClientConnection(
    // OS-level spawn directory only — neutral, never a project directory
    // (Windows locks the process cwd against deletion). Per-session cwds are
    // passed to newSession()/loadSession() instead.
    private val spawnDirectory: String,
    private val sessionUpdateConsumer: (AcpSessionUpdate) -> Unit,
    private val permissionHandler: suspend (RequestPermissionRequest) -> RequestPermissionResponse?,
    private val elicitationHandler: (suspend (ElicitationRequest) -> ElicitationResponse?)? = null,
) : Disposable {
    private val log = Logger.getInstance(AcpClientConnection::class.java)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // Reached from both direct teardown and the Disposer tree; the second
    // arrival is a no-op.
    private val disposed = AtomicBoolean(false)

    companion object {
        private const val ACP_TIMEOUT_MS = 30_000L
        private const val ACP_NEW_SESSION_TIMEOUT_MS = 60_000L
        // Idle watchdog: a turn may stream for as long as the backend keeps
        // producing events; one silent this long is treated as hung. The CLI
        // forwards subagent tool events to the parent session, so a working
        // subagent keeps resetting this same window — a special (longer)
        // leash is not need.
        private const val ACP_PROMPT_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000L
        // Poll slice while the prompt flow is quiet; real-idle checks use the
        // unified last-life timestamp below.
        private const val IDLE_POLL_SLICE_MS = 5_000L

        // Bound for the session/cancel() sent when the idle watchdog fires.
        private const val CANCEL_ON_TIMEOUT_MS = 5_000L
        private const val PROCESS_EXIT_TIMEOUT_MS = 5_000L

        // Teardown cancel/close runs synchronously (on EDT during project
        // close) — tighter bound than interactive calls so a hung backend
        // cannot freeze the UI for a full minute per session.
        private const val ACP_SESSION_TEARDOWN_TIMEOUT_MS = 10_000L
    }
    private val sessions = ConcurrentHashMap<String, ClientSession>()
    private val sessionCwds = ConcurrentHashMap<String, String>()
    private val ideMcpHandles = ConcurrentHashMap<String, IdeMcpHandle>()
    private val cachedCommands = ConcurrentHashMap<String, List<Triple<String, String, String?>>>()
    private val cachedUsage = ConcurrentHashMap<String, Pair<Long, Long>>()
    private val cancelledSessions = ConcurrentHashMap.newKeySet<String>()

    // Sessions closed at protocol level on this connection. The SDK session
    // holder is deliberately kept (see sendSessionClose) so late session/update
    // notifications reach publish() instead of failing inside the SDK; this
    // marker drops them there, before they can resurrect cache entries nothing
    // will query again. Cleared on re-load: an archived session can be restored
    // and loaded again on the same connection.
    private val closedSessions = ConcurrentHashMap.newKeySet<String>()

    // Session IDs whose cached configOptions are stale (backend instance was
    // disposed by refreshInstance). The ACP process is still alive, so the
    // ClientSession objects stay in [sessions] — only their config cache is
    // stale. loadSession re-loads these sessions to fetch fresh configOptions.
    private val configStaleSessions = ConcurrentHashMap.newKeySet<String>()

    // Last notify-path activity per session. SDK 0.25.0 routes session/update
    // to Operations.notify OR the prompt flow (never both), so both paths must
    // count as life for the idle watchdog.
    private val lastNotifyAtMs = ConcurrentHashMap<String, Long>()

    // THINK (task/subagent) tool calls in flight, keyed "sessionId:toolCallId".
    // Diagnostics only (printed in the idle-timeout log); the leash itself is
    // uniform because subagent activity feeds the same window.
    private val pendingSubagentCalls = ConcurrentHashMap.newKeySet<String>()

    // Permission/elicitation requests currently rendered for the user. The
    // leash never fires while a question is on screen — the user decides.
    private val pendingUserRequests = ConcurrentHashMap.newKeySet<String>()

    @Volatile private var process: Process? = null
    @Volatile private var protocol: Protocol? = null
    @Volatile private var client: Client? = null
    @Volatile private var stdoutWriter: BufferedWriter? = null

    fun isAlive(): Boolean = process?.isAlive == true

    @Synchronized
    fun connect(command: String, arguments: List<String>, environment: Map<String, String> = emptyMap()) {
        if (client != null) return
        log.debug("Starting ACP agent: ${Paths.get(command).fileName} ${arguments.joinToString(" ")}")
        val child = spawnProcess(command, arguments, environment)
        val (writer, input) = createTransport(child)
        try {
            val nextClient = initializeClient(input, writer)
            process = child
            protocol = nextClient.protocol
            client = nextClient.client
        } catch (error: Throwable) {
            log.warn("ACP connect failed: ${error.message}", error)
            stdoutWriter?.let { runCatching { it.close() } }
            stdoutWriter = null
            child.destroy()
            if (error is LinkageError) {
                throw IllegalStateException("ACP runtime is incompatible with this IDE: ${error.message}", error)
            }
            throw error
        }
    }

    private fun spawnProcess(
        command: String,
        arguments: List<String>,
        environment: Map<String, String>,
    ): Process {
        val builder = ProcessBuilder(listOf(command) + arguments)
            .directory(File(spawnDirectory))
        val env = builder.environment()
        val configPath = PathManager.getConfigPath()
        val systemPath = PathManager.getSystemPath()
        env["XDG_CONFIG_HOME"] = configPath
        env["XDG_DATA_HOME"] = systemPath
        env["XDG_CACHE_HOME"] = systemPath
        env["XDG_STATE_HOME"] = systemPath

        // Runtime contract distinguishing the IDE integration from TUI and
        // generic ACP/HTTP clients.
        env["DEVECO_CLIENT"] = "intellij"
        env["DEVECO_RUNTIME_MODE"] = "deveco-studio"
        env["DEVECO_HOME"] = PathManager.getHomePath()
        env["DEVECO_STORAGE_ROOT"] = devecoStorageRoot.toString()
        env["DEVECO_SOURCE_TYPE"] = "DevEco-Code-Plugin"
        env["DEVECO_SOURCE_VERSION"] = ApplicationInfo.getInstance().fullVersion
        env["DEVECO_PLUGIN_VERSION"] = PluginManagerCore.getPlugin(
            PluginId.getId("org.deveco.code.deveco-code-jetbrains-plugin"),
        )?.version ?: "unknown"
        // DevEco Studio signs the agreements itself; a revision the CLI observed
        // before that could never be cleared in-process.
        //
        // Inheritance boundary: this env var propagates to all child processes
        // (agent shell tools, MCP servers, nested `deveco` invocations). This is
        // intentional — the entire subtree under the IDE should skip TMS signing.
        // If isolation is needed, clear it explicitly in the child's env.
        env["DEVECO_ALWAYS_ACCEPT_AGREEMENT"] = "true"
        // A host-inherited DEVECO_AUTH_CONTENT snapshot would shadow auth.json
        // on disk (auth "lost" after restart) — the backend must read the file.
        val inheritedAuth = env.remove("DEVECO_AUTH_CONTENT")
        if (inheritedAuth != null) {
            log.warn("Removed inherited DEVECO_AUTH_CONTENT from backend env (was shadowing auth.json)")
        }
        // Applied last: caller entries override host-inherited values (e.g. a
        // stale DEVECO_SERVER_PASSWORD from the user's shell).
        for ((key, value) in environment) {
            env[key] = value
        }
        // Make `/usr/bin/env node` resolvable when the IDE was launched from
        // the macOS GUI (no shell PATH inherited).
        DevEcoCodeDetector.configureRuntimeEnvironment(builder, File(command).toPath())
        val child = builder.start()
        log.debug("ACP agent process started: PID=${child.pid()}, alive=${child.isAlive}, storageRoot=${devecoStorageRoot.fileName}")
        return child
    }

    private data class TransportResult(val writer: BufferedWriter, val input: kotlinx.coroutines.flow.Flow<String>)

    private fun createTransport(child: Process): TransportResult {
        val writer = BufferedWriter(OutputStreamWriter(child.outputStream, Charsets.UTF_8))
        stdoutWriter = writer
        // Backend stderr is diagnostic only — queue waiting and 429 retries
        // now arrive as structured session.status events on the SSE stream
        // (see DevEcoHttpApi / SharedAcpBackend). Log stderr lines for
        // troubleshooting but do not parse them.
        scope.launch {
            child.errorStream.bufferedReader(Charsets.UTF_8).use { reader ->
                while (true) {
                    val raw = reader.readLine() ?: break
                    val line = raw.trim()
                    if (line.isEmpty()) continue
                    log.debug("ACP stderr: $line")
                }
            }
        }
        // Protocol payloads carry prompts, tool inputs/outputs, and MCP auth
        // tokens — debug keeps them out of idea.log unless the category is
        // enabled via Help | Diagnostic Tools | Debug Log Settings.
        val input = flow {
            child.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
                while (true) {
                    val raw = reader.readLine() ?: break
                    // One JSON-RPC object per line; non-JSON progress noise must not
                    // reach the SDK's parser (malformed-frame errors tear the stream).
                    var line = raw.trim()
                    if (line.isEmpty()) continue
                    if (line.startsWith('\ufeff')) line = line.substring(1).trimStart()
                    if (!line.startsWith("{")) {
                        // Non-JSON stdout lines are protocol noise; backend
                        // errors and queue states arrive on stderr (see the
                        // scope.launch above). Just skip them here.
                        log.debug("ACP << (skipped non-JSON stdout): $raw")
                        continue
                    }
                    log.debug("ACP << $line")
                    emit(line)
                }
            }
        }
        return TransportResult(writer, input)
    }

    private data class ClientResult(val client: Client, val protocol: Protocol)

    private fun initializeClient(input: kotlinx.coroutines.flow.Flow<String>, writer: BufferedWriter): ClientResult {
        val transport = StdioTransport(
            parentScope = scope,
            ioDispatcher = Dispatchers.IO,
            input = input,
            output = { line ->
                log.debug("ACP >> $line")
                writer.write(line)
                writer.newLine()
                writer.flush()
            },
            name = "OpenCode ACP",
        )
        val nextProtocol = Protocol(scope, transport).also { it.start() }
        val nextClient = Client(nextProtocol)
        log.info("Sending ACP initialize request...")
        runBlocking {
            withTimeout(ACP_TIMEOUT_MS) {
                nextClient.initialize(
                    ClientInfo(
                        implementation = Implementation("deveco-code", "1.0.0", "DevEco Code"),
                        capabilities = ClientCapabilities(
                            elicitation = ElicitationCapabilities(form = ElicitationFormCapabilities()),
                        ),
                    ),
                )
            }
        }
        log.info("ACP initialize succeeded, protocol version established")
        return ClientResult(nextClient, nextProtocol)
    }

    fun listSessions(cwd: String): List<SessionInfo> = runBlocking {
        withTimeout(ACP_TIMEOUT_MS) {
            val backend = requireClient().listSessions(cwd).toList()
            val backendIds = backend.map { it.sessionId.value }.toSet()
            // Local fallback sessions must be filtered by cwd — one project's
            // sessions must never leak into another project's list.
            val extra = sessions.values
                .filter { it.sessionId.value !in backendIds && sessionCwds[it.sessionId.value] == cwd }
                .map { session ->
                    SessionInfo(
                        sessionId = session.sessionId,
                        title = null,
                        cwd = cwd,
                        updatedAt = null,
                    )
                }
            backend + extra
        }
    }

    fun newSession(
        cwd: String,
        acquireIdeMcp: () -> IdeMcpHandle?,
        onSessionEstablished: (String) -> Unit,
    ): String = runBlocking {
        withTimeout(ACP_NEW_SESSION_TIMEOUT_MS) {
            val handle = acquireIdeMcp()
            val mcpServers = handle?.toMcpServer()?.let { listOf(it) } ?: emptyList()
            val session = requireClient().newSession(
                SessionCreationParameters(cwd, mcpServers),
                operationsFactory(onSessionEstablished),
            )
            val sid = session.sessionId.value
            sessions[sid] = session
            sessionCwds[sid] = cwd
            if (handle != null) ideMcpHandles[sid] = handle
            log.debug("newSession: created $sid in cwd=${Paths.get(cwd).fileName}; ideMcp=${if (handle != null) "on(${handle.endpoint.sseUrl})" else "off"}")
            sid
        }
    }

    fun loadSession(
        sessionId: String,
        cwd: String,
        acquireIdeMcp: () -> IdeMcpHandle?,
        replay: Boolean = false,
        onSessionEstablished: (String) -> Unit,
    ): List<SessionConfigOption> = runBlocking {
        withTimeout(ACP_TIMEOUT_MS) {
            // A config-stale session (marked by invalidateSessionCache after
            // refreshInstance) still holds a live ClientSession, but its
            // configOptions are stale. Re-load from the backend to refresh
            // them. The old ClientSession is replaced — not closed — because
            // the ACP session is still alive on the server; closing it would
            // make the session unavailable for the re-load. The same fresh
            // path serves replay=true: the backend replays the full history
            // on every session/load, and a caller whose message list is empty
            // (a re-opened editor tab) depends on that replay — the cached
            // branch skips the RPC and would leave it blank.
            val cached = sessions[sessionId]
            val session = if (cached != null && sessionId !in configStaleSessions && !replay) {
                cached
            } else {
                configStaleSessions.remove(sessionId)
                closedSessions.remove(sessionId)
                val handle = acquireIdeMcp()
                val mcpServers = handle?.toMcpServer()?.let { listOf(it) } ?: emptyList()
                val loaded = requireClient().loadSession(
                    SessionId(sessionId),
                    SessionCreationParameters(cwd, mcpServers),
                    operationsFactory(onSessionEstablished),
                )
                sessions[sessionId] = loaded
                sessionCwds[sessionId] = cwd
                if (handle != null) ideMcpHandles[sessionId] = handle
                log.debug("loadSession: ${if (cached != null) "re-" else ""}loaded $sessionId in cwd=${Paths.get(cwd).fileName}; ideMcp=${if (handle != null) "on(${handle.endpoint.sseUrl})" else "off"}")
                loaded
            }
            session.configOptions.value
        }
    }

    // Mark cached session configOptions as stale so the next loadSession call
    // re-fetches them from the backend. Called after disposeInstance /
    // refreshInstance to ensure stale configOptions (cached from a previous
    // loadSession) are not returned. Unlike clearing the sessions map, this
    // preserves live ClientSession references — prompt(), cancelPrompt(), and
    // dispose() continue to work.
    fun invalidateSessionCache() {
        configStaleSessions.addAll(sessions.keys)
    }

    /**
     * Sends a prompt; returns immediately — the turn runs as a coroutine in
     * [scope] and waiting suspends, so no thread is pinned. [onDone] receives
     * null on success, or the failure (idle-timeout IOException, backend
     * error, CancellationException for user cancel or teardown).
     */
    fun prompt(sessionId: String, text: String, onDone: (Throwable?) -> Unit) {
        startPrompt(sessionId, listOf(ContentBlock.Text(text)), onDone)
    }

    /** Overload of [prompt] for prompts with prebuilt content blocks (attachments). */
    fun prompt(sessionId: String, blocks: List<ContentBlock>, onDone: (Throwable?) -> Unit) {
        startPrompt(sessionId, blocks, onDone)
    }

    private fun startPrompt(sessionId: String, blocks: List<ContentBlock>, onDone: (Throwable?) -> Unit) {
        val session = sessions[sessionId]
        if (session == null) {
            onDone(IllegalStateException("ACP session is not loaded: $sessionId"))
            return
        }
        scope.launch {
            val error = try {
                runPromptTurn(session, sessionId, blocks)
            } catch (e: Throwable) {
                e // includes CancellationException (user cancel, teardown)
            }
            onDone(error)
        }
    }

    /** Sentinel carried out of the collection loop; see [runPromptTurn]. */
    private class PromptIdleTimeoutException(message: String) : java.io.IOException(message)

    /** Collects one prompt turn; each event resets the idle deadline. */
    private suspend fun runPromptTurn(
        session: ClientSession,
        sessionId: String,
        blocks: List<ContentBlock>,
    ): Throwable? {
        var promptResponse: com.agentclientprotocol.model.PromptResponse? = null
        var eventCount = 0
        // Unified life model: flow events and notify-path publishes both count.
        // A fresh stamp at turn start avoids inheriting stale leniency.
        var lastActivityAtMs = System.currentTimeMillis()
        lastNotifyAtMs[sessionId] = lastActivityAtMs
        // A stale cancel marker from an earlier lifecycle of this id must not
        // cancel this fresh prompt.
        cancelledSessions.remove(sessionId)
        try {
            coroutineScope {
                val events = session.prompt(blocks).produceIn(this)
                try {
                    while (true) {
                        val received = withTimeoutOrNull(IDLE_POLL_SLICE_MS) { events.receiveCatching() }
                        if (received == null) {
                            val now = System.currentTimeMillis()
                            val sinceLife = now - maxOf(lastActivityAtMs, lastNotifyAtMs[sessionId] ?: now)
                            // A card on screen means the user decides — but only a card
                            // of THIS session; a forgotten question elsewhere must not
                            // disable this turn's stall detection.
                            val leash =
                                if (pendingUserRequests.any { key ->
                                        key.startsWith("elicit-$sessionId-") || key.startsWith("perm-$sessionId-")
                                    }) {
                                    Long.MAX_VALUE
                                } else {
                                    ACP_PROMPT_IDLE_TIMEOUT_MS
                                }
                            if (sinceLife < leash) continue
                            log.warn(
                                "ACP prompt: idle timeout after ${sinceLife}ms, " +
                                    "events=$eventCount, sessionId=$sessionId, " +
                                    "subagents=${pendingSubagentCalls.size}, userCards=${pendingUserRequests.size}"
                            )
                            // Stop the backend turn: unsupervised, it would
                            // keep burning tokens and rendering ghost events
                            // after the error card.
                            val cancelled = runCatching { withTimeoutOrNull(CANCEL_ON_TIMEOUT_MS) { session.cancel() } }
                                .onFailure { log.warn("session.cancel() after idle timeout failed for $sessionId", it) }
                            if (cancelled.getOrNull() == null) {
                                // withTimeoutOrNull returns null instead of throwing — log the hang.
                                log.warn("session.cancel() after idle timeout did not complete within ${CANCEL_ON_TIMEOUT_MS}ms, sessionId=$sessionId")
                            }
                            throw PromptIdleTimeoutException(
                                "Session prompt timed out after ${sinceLife}ms without agent activity"
                            )
                        }
                        val event = received.getOrNull() ?: break // channel closed: turn complete
                        lastActivityAtMs = System.currentTimeMillis()
                        eventCount++
                        when (event) {
                            is Event.SessionUpdateEvent -> {
                                publish(SessionId(sessionId), event.update)
                            }
                            is Event.PromptResponseEvent -> {
                                promptResponse = event.response
                            }
                        }
                    }
                } finally {
                    events.cancel()
                }
            }
        } catch (e: PromptIdleTimeoutException) {
            return e
        } finally {
            lastNotifyAtMs.remove(sessionId)
            pendingSubagentCalls.removeIf { it.startsWith("$sessionId:") }
        }
        // Check cancellation before error handling: a user cancel that
        // arrived during the turn should not be reported as a backend error.
        if (cancelledSessions.remove(sessionId)) {
            return CancellationException("Session $sessionId was cancelled by user")
        }
        // SDK 0.25.0 routes session/update notifications to the notify() callback
        // on ClientSessionOperations, not to the prompt flow. The prompt flow only
        // delivers the PromptResponseEvent. The SessionController handles the
        // "no agent output" case by inspecting the message list after the turn.
        if (promptResponse == null) {
            return java.io.IOException("Prompt ended without a response from backend")
        }
        return null
    }

    fun setConfigOption(sessionId: String, configId: String, value: String): List<SessionConfigOption> = runBlocking {
        withTimeout(ACP_TIMEOUT_MS) {
            requireSession(sessionId).setConfigOption(
                SessionConfigId(configId),
                SessionConfigOptionValue.StringValue(value),
            ).configOptions
        }
    }

    fun setMode(sessionId: String, modeId: String) = runBlocking {
        withTimeout(ACP_TIMEOUT_MS) {
            requireSession(sessionId).setMode(SessionModeId(modeId))
        }
    }

    @Synchronized
    fun cancelPrompt(sessionId: String) {
        sessions[sessionId]?.let { session ->
            // Marker before cancel(): filters the SDK's cancel-time pseudo-event
            // at the publish() origin below.
            cancelledSessions.add(sessionId)
            runBlocking { session.cancel() }
        } ?: run {
            log.warn("cancelPrompt: session $sessionId NOT found in sessions map, cancel ignored")
        }
    }

    /**
     * Cancels any in-flight turn and closes the session at protocol level
     * (project detach, delete, archive). Failures are logged, not thrown —
     * [dispose] and the process kill remain the last line of defense.
     */
    @Synchronized
    fun closeSession(sessionId: String) = runBlocking {
        val session = sessions[sessionId]
        sessionCwds.remove(sessionId)
        ideMcpHandles.remove(sessionId)?.stop()
        cachedCommands.remove(sessionId)
        cachedUsage.remove(sessionId)
        if (session != null) {
            // Cancel first — closing alone may not terminate an executing turn.
            // The marker filters the SDK's cancel-time pseudo-event and makes
            // the in-flight prompt throw CancellationException.
            cancelledSessions.add(sessionId)
            runCatching { withTimeout(ACP_SESSION_TEARDOWN_TIMEOUT_MS) { session.cancel() } }
                .onFailure { log.warn("Failed to cancel session $sessionId before close", it) }
            runCatching { withTimeout(ACP_SESSION_TEARDOWN_TIMEOUT_MS) { sendSessionClose(sessionId) } }
                .onFailure { log.warn("Failed to close session $sessionId at protocol level", it) }
            sessions.remove(sessionId)
            closedSessions.add(sessionId)
        }
    }

    /**
     * True when the session was closed at protocol level on this connection
     * (delete/archive, detached project) and not re-loaded since. Lets callers
     * attribute a late prompt failure to their own teardown instead of an
     * IDE error: the backend legitimately fails the in-flight session/prompt
     * once the deleted session's rows are gone.
     */
    fun isSessionClosed(sessionId: String): Boolean = sessionId in closedSessions

    /**
     * Sends session/close without [ClientSession.close]'s client-side cleanup.
     * close() drops the SDK's internal session holder the moment the response
     * arrives, and a session/update still in flight for that session then
     * fails inside the SDK with AcpExpectedError("Session ... not found") —
     * which the IDE surfaces as an internal-error balloon when a session with
     * a live turn is deleted. Sending the same request directly keeps the
     * holder, so late updates reach publish() and are dropped as updates of a
     * closed session; the retained holder costs a few KB per closed session
     * until the connection is rebuilt. acp-jvm >= 0.32.0 ignores updates for
     * closed sessions itself, so after upgrading this can revert to close().
     */
    private suspend fun sendSessionClose(sessionId: String) {
        val wire = protocol ?: error("ACP client is not connected")
        AcpMethod.AgentMethods.SessionClose(wire, CloseSessionRequest(SessionId(sessionId)))
    }

    /**
     * Runs while the SDK processes the session/new (or session/load) response,
     * before any update can be dispatched (early ones are queued until then) —
     * the earliest race-free point to register the session's route.
     */
    private fun operationsFactory(onSessionEstablished: (String) -> Unit) = ClientOperationsFactory { sessionId, _: AcpCreatedSessionResponse ->
        onSessionEstablished(sessionId.value)
        Operations(sessionId)
    }

    private suspend fun handleElicitation(request: CreateElicitationRequest): CreateElicitationResponse {
        val handler = elicitationHandler
            ?: return CreateElicitationResponse(action = ElicitationAction.Decline)
        val elicitation = extractElicitation(request)
            ?: return CreateElicitationResponse(action = ElicitationAction.Decline)
        val requestKey = "elicit-${elicitation.sessionId}-${System.nanoTime()}"
        pendingUserRequests.add(requestKey)
        try {
            val response = handler.invoke(elicitation)
            if (response == null || !response.accepted) {
                return CreateElicitationResponse(action = ElicitationAction.Decline)
            }
            return CreateElicitationResponse(
                action = ElicitationAction.Accept(
                    response.answers.mapNotNull { (key, answers) ->
                        val field = elicitation.fields.firstOrNull { it.key == key }
                            ?: return@mapNotNull null
                        val value = if (field.multiple) {
                            ElicitationContentValue.StringArrayValue(answers)
                        } else {
                            ElicitationContentValue.StringValue(answers.firstOrNull().orEmpty())
                        }
                        key to value
                    }.toMap(),
                ),
            )
        } finally {
            pendingUserRequests.remove(requestKey)
        }
    }

    private inner class Operations(private val sessionId: SessionId) : ClientSessionOperations {
        override suspend fun createElicitation(
            request: CreateElicitationRequest,
        ): CreateElicitationResponse = handleElicitation(request)

        override suspend fun completeElicitation(notification: CompleteElicitationNotification) {
            log.info("Ignoring elicitation/complete notification, elicitationId=${notification.elicitationId.value}")
        }

        override suspend fun requestPermissions(
            toolCall: SessionUpdate.ToolCallUpdate,
            permissions: List<PermissionOption>,
            _meta: kotlinx.serialization.json.JsonElement?,
        ): RequestPermissionResponse {
            val requestKey = "perm-${sessionId.value}-${System.nanoTime()}"
            pendingUserRequests.add(requestKey)
            try {
                return permissionHandler(
                    RequestPermissionRequest(sessionId, toolCall, permissions, _meta),
                ) ?: RequestPermissionResponse(RequestPermissionOutcome.Cancelled)
            } finally {
                pendingUserRequests.remove(requestKey)
            }
        }

        override suspend fun notify(
            notification: SessionUpdate,
            _meta: kotlinx.serialization.json.JsonElement?,
        ) = publish(sessionId, notification)
    }

    private fun extractElicitation(request: CreateElicitationRequest): ElicitationRequest? {
        val scope = request.scope as? ElicitationScope.Session ?: return null
        val form = request.mode as? ElicitationMode.Form ?: return null
        val required = form.requestedSchema.required.orEmpty().toSet()
        val metaFields = ((request._meta as? JsonObject)
            ?.get("deveco.question") as? JsonObject)
            ?.get("fields") as? JsonArray
        val metadata = metaFields.orEmpty()
            .mapNotNull { it as? JsonObject }
            .mapNotNull { field -> field["key"]?.jsonPrimitive?.contentOrNull?.let { it to field } }
            .toMap()
        val fields = form.requestedSchema.properties.mapNotNull { (key, property) ->
            val meta = metadata[key]
            val metaOptions = (meta?.get("options") as? JsonArray).orEmpty()
                .mapNotNull { it as? JsonObject }
                .mapNotNull { option ->
                    val value = option["value"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                    ElicitationOption(
                        value = value,
                        label = option["label"]?.jsonPrimitive?.contentOrNull ?: value,
                        description = option["description"]?.jsonPrimitive?.contentOrNull,
                    )
                }
            when (property) {
                is ElicitationPropertySchema.StringProperty -> ElicitationField(
                    key = key,
                    title = property.title ?: key,
                    question = property.description ?: property.title ?: request.message,
                    options = metaOptions.ifEmpty {
                        property.oneOf?.map { ElicitationOption(it.value, it.title) }
                            ?: property.enumValues?.map { ElicitationOption(it, it) }
                            ?: emptyList()
                    },
                    multiple = false,
                    required = key in required,
                    allowCustom = meta?.get("custom")?.jsonPrimitive?.booleanOrNull
                        ?: (property.enumValues == null && property.oneOf == null),
                )
                is ElicitationPropertySchema.ArrayProperty -> ElicitationField(
                    key = key,
                    title = property.title ?: key,
                    question = property.description ?: property.title ?: request.message,
                    options = metaOptions.ifEmpty {
                        when (val items = property.items) {
                            is MultiSelectItems.Titled -> items.items.options.map {
                                ElicitationOption(it.value, it.title)
                            }
                            is MultiSelectItems.Untitled -> items.items.values.map {
                                ElicitationOption(it, it)
                            }
                        }
                    },
                    multiple = true,
                    required = key in required,
                    allowCustom = meta?.get("custom")?.jsonPrimitive?.booleanOrNull ?: false,
                )
                else -> null
            }
        }
        if (fields.isEmpty()) return null
        return ElicitationRequest(
            sessionId = scope.sessionId.value,
            title = form.requestedSchema.title ?: request.message,
            fields = fields,
        )
    }

    private fun publish(sessionId: SessionId, update: SessionUpdate) {
        // Late update for a session closed at protocol level: dropped here
        // (see sendSessionClose) before it can resurrect cache entries.
        if (sessionId.value in closedSessions) {
            log.debug("publish: dropping late update for closed session ${sessionId.value}: ${update::class.simpleName}")
            return
        }
        // Suppress the SDK's cancel-time UsageUpdate(used=0) pseudo-event at
        // the origin, before it zeroes usedTokens in the store.
        if (update is SessionUpdate.UsageUpdate && update.used == 0L && cancelledSessions.contains(sessionId.value)) {
            log.info("publish: suppressing cancelled-flow UsageUpdate(used=0, size=${update.size}) for sessionId=${sessionId.value}")
            return
        }
        if (update is SessionUpdate.ToolCallUpdate) {
            trackSubagentCall(sessionId.value, update)
        }
        lastNotifyAtMs[sessionId.value] = System.currentTimeMillis()
        if (update is SessionUpdate.AvailableCommandsUpdate) {
            cachedCommands[sessionId.value] = update.availableCommands.map {
                Triple(it.name, it.description, sourceOf(it._meta))
            }
        }
        if (update is SessionUpdate.UsageUpdate) {
            cachedUsage[sessionId.value] = update.used to update.size
        }
        sessionUpdateConsumer(AcpSessionUpdate(sessionId, update))
    }

    // THINK (task) tool call bookkeeping for the timeout log; terminal status
    // (or a kind-less update) frees the slot.
    private fun trackSubagentCall(sid: String, update: SessionUpdate.ToolCallUpdate) {
        val key = "$sid:${update.toolCallId.value}"
        when (update.status) {
            ToolCallStatus.PENDING, ToolCallStatus.IN_PROGRESS ->
                if (update.kind == ToolKind.THINK) pendingSubagentCalls.add(key)
            else -> pendingSubagentCalls.remove(key)
        }
    }

    fun getAvailableCommands(sessionId: String): List<Triple<String, String, String?>> =
        cachedCommands[sessionId] ?: emptyList()

    private fun sourceOf(meta: kotlinx.serialization.json.JsonElement?): String? =
        (meta as? kotlinx.serialization.json.JsonObject)
            ?.get("source")?.let { it as? kotlinx.serialization.json.JsonPrimitive }?.contentOrNull

    fun getCachedUsage(sessionId: String): Pair<Long, Long>? =
        cachedUsage[sessionId]

    private fun requireClient(): Client {
        val c = client ?: error("ACP client is not connected")
        if (process?.isAlive == false) error("ACP agent process has exited")
        return c
    }
    private fun requireSession(sessionId: String): ClientSession =
        sessions[sessionId] ?: error("ACP session is not loaded: $sessionId")
    @Synchronized
    override fun dispose() {
        if (disposed.get()) return
        disposed.set(true)
        // Cancel and close all sessions before killing the process — a turn
        // left executing would continue unsupervised. Bounded; the kill below
        // is the last line of defense.
        sessions.forEach { (sessionId, session) ->
            cancelledSessions.add(sessionId)
            runCatching { runBlocking { withTimeout(ACP_SESSION_TEARDOWN_TIMEOUT_MS) { session.cancel() } } }
                .onFailure { log.warn("Failed to cancel session $sessionId during connection close", it) }
            runCatching { runBlocking { withTimeout(ACP_SESSION_TEARDOWN_TIMEOUT_MS) { sendSessionClose(sessionId) } } }
                .onFailure { log.warn("Failed to close session $sessionId during connection close", it) }
        }
        ideMcpHandles.values.forEach { runCatching { it.stop() } }
        ideMcpHandles.clear()
        sessions.clear()
        sessionCwds.clear()
        cachedCommands.clear()
        cachedUsage.clear()
        lastNotifyAtMs.clear()
        pendingSubagentCalls.clear()
        pendingUserRequests.clear()
        closedSessions.clear()
        client = null
        protocol?.close()
        protocol = null
        val p = process
        process = null
        scope.cancel()
        stdoutWriter?.let { runCatching { it.close() } }
        stdoutWriter = null
        if (p != null) terminateProcessAsync(p)
    }

    private fun terminateProcessAsync(p: Process) {
        // Don't call p.destroy() immediately — on Windows it maps to
        // TerminateProcess (hard kill), denying the backend a chance to
        // release Flock locks and flush state. The stdin writer and ACP
        // protocol were already closed by dispose(); the backend should
        // detect EOF and exit gracefully. Force-kill only if it hangs.
        ApplicationManager.getApplication().executeOnPooledThread {
            if (!p.waitFor(PROCESS_EXIT_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                log.warn("ACP agent pid=${p.pid()} did not exit within ${PROCESS_EXIT_TIMEOUT_MS}ms, force-destroying")
                p.destroyForcibly()
            }
        }
    }
}
