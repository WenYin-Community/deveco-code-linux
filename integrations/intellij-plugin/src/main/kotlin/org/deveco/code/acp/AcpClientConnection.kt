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
import com.agentclientprotocol.protocol.Protocol
import com.agentclientprotocol.transport.StdioTransport
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ApplicationInfo
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.diagnostic.Logger
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.produceIn
import kotlinx.coroutines.flow.toList
import kotlinx.serialization.json.contentOrNull
import java.io.BufferedWriter
import java.io.File
import java.io.OutputStreamWriter
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
    private val permissionHandler: (RequestPermissionRequest) -> RequestPermissionResponse?,
) : Disposable {
    private val log = Logger.getInstance(AcpClientConnection::class.java)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // Reached from both direct teardown and the Disposer tree; the second
    // arrival is a no-op.
    private val disposed = AtomicBoolean(false)

    // Backend errors arrive on stdout without a session id; attribution is
    // best-effort. The sequence number rejects errors older than the prompt;
    // the CAS clear makes each error single-consumer. Cross-prompt
    // misattribution remains possible — stdout does not say which turn erred.
    private val backendErrorSeq = AtomicLong(0)
    private val backendErrorSlot = AtomicReference<Pair<Long, String>?>()

    companion object {
        private const val ACP_TIMEOUT_MS = 30_000L
        private const val ACP_NEW_SESSION_TIMEOUT_MS = 60_000L
        // Idle watchdog: a turn may stream for as long as the backend keeps
        // producing events; one silent this long is treated as hung.
        private const val ACP_PROMPT_IDLE_TIMEOUT_MS = 10 * 60 * 1000L

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

    // Session IDs whose cached configOptions are stale (backend instance was
    // disposed by refreshInstance). The ACP process is still alive, so the
    // ClientSession objects stay in [sessions] — only their config cache is
    // stale. loadSession re-loads these sessions to fetch fresh configOptions.
    private val configStaleSessions = ConcurrentHashMap.newKeySet<String>()

    @Volatile private var process: Process? = null
    @Volatile private var protocol: Protocol? = null
    @Volatile private var client: Client? = null
    @Volatile private var stdoutWriter: BufferedWriter? = null

    fun isAlive(): Boolean = process?.isAlive == true

    @Synchronized
    fun connect(command: String, arguments: List<String>, environment: Map<String, String> = emptyMap()) {
        if (client != null) return
        log.info("Starting ACP agent: $command ${arguments.joinToString(" ")}")
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
        log.info("ACP agent process started: PID=${child.pid()}, alive=${child.isAlive}, storageRoot=$devecoStorageRoot")
        return child
    }

    private data class TransportResult(val writer: BufferedWriter, val input: kotlinx.coroutines.flow.Flow<String>)

    private fun createTransport(child: Process): TransportResult {
        val writer = BufferedWriter(OutputStreamWriter(child.outputStream, Charsets.UTF_8))
        stdoutWriter = writer
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
                        if (line.contains("error=", true) || line.contains("stream error", true)) {
                            val errorText = line.substringAfter("error=", "")
                                .removeSurrounding("\"").trim()
                            if (errorText.isNotBlank()) {
                                backendErrorSlot.set(backendErrorSeq.incrementAndGet() to errorText)
                            }
                        }
                        log.info("ACP << (skipped non-JSON stdout): $raw")
                        continue
                    }
                    log.info("ACP << $line")
                    emit(line)
                }
            }
        }
        scope.launch {
            child.errorStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
                lines.forEach { log.info("OpenCode: $it") }
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
                log.info("ACP >> $line")
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
            log.info("newSession: created $sid in cwd=$cwd; ideMcp=${if (handle != null) "on(${handle.endpoint.sseUrl})" else "off"}")
            sid
        }
    }

    fun loadSession(
        sessionId: String,
        cwd: String,
        acquireIdeMcp: () -> IdeMcpHandle?,
        onSessionEstablished: (String) -> Unit,
    ): List<SessionConfigOption> = runBlocking {
        withTimeout(ACP_TIMEOUT_MS) {
            // A config-stale session (marked by invalidateSessionCache after
            // refreshInstance) still holds a live ClientSession, but its
            // configOptions are stale. Re-load from the backend to refresh
            // them. The old ClientSession is replaced — not closed — because
            // the ACP session is still alive on the server; closing it would
            // make the session unavailable for the re-load.
            val cached = sessions[sessionId]
            val session = if (cached != null && sessionId !in configStaleSessions) {
                cached
            } else {
                configStaleSessions.remove(sessionId)
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
                log.info("loadSession: ${if (cached != null) "re-" else ""}loaded $sessionId in cwd=$cwd; ideMcp=${if (handle != null) "on(${handle.endpoint.sseUrl})" else "off"}")
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
        var hadSessionUpdates = false
        var promptResponse: com.agentclientprotocol.model.PromptResponse? = null
        var eventCount = 0
        // Only errors recorded after this point may be attributed to this prompt.
        val errorSeqAtStart = backendErrorSlot.get()?.first ?: 0L
        // A stale cancel marker from an earlier lifecycle of this id must not
        // cancel this fresh prompt.
        cancelledSessions.remove(sessionId)
        try {
            coroutineScope {
                val events = session.prompt(blocks).produceIn(this)
                try {
                    while (true) {
                        val received = withTimeoutOrNull(ACP_PROMPT_IDLE_TIMEOUT_MS) { events.receiveCatching() }
                        if (received == null) {
                            log.warn(
                                "ACP prompt: idle timeout after ${ACP_PROMPT_IDLE_TIMEOUT_MS}ms, " +
                                    "events=$eventCount, hadUpdates=$hadSessionUpdates, sessionId=$sessionId"
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
                                "Session prompt timed out after ${ACP_PROMPT_IDLE_TIMEOUT_MS}ms without agent activity"
                            )
                        }
                        val event = received.getOrNull() ?: break // channel closed: turn complete
                        eventCount++
                        when (event) {
                            is Event.SessionUpdateEvent -> {
                                hadSessionUpdates = true
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
        }
        if (!hadSessionUpdates) {
            log.warn("ACP prompt: NO session updates received — backend returned PromptResponse without any streaming events. stopReason=${promptResponse?.stopReason} sessionId=$sessionId")
        }
        // If no agent output was produced, throw with the backend's error
        // message (captured from non-JSON stdout) so the user sees the
        // actual cause (e.g. "Model access denied", "API key not provided").
        val hadAgentOutput = hadSessionUpdates && eventCount > 1
        if (!hadAgentOutput) {
            consumeBackendError(errorSeqAtStart)?.let { err ->
                return java.io.IOException("Backend error: $err")
            }
        }
        if (cancelledSessions.remove(sessionId)) {
            return CancellationException("Session $sessionId was cancelled by user")
        }
        return null
    }

    fun setConfigOption(sessionId: String, configId: String, value: String) = runBlocking {
        withTimeout(ACP_TIMEOUT_MS) {
            requireSession(sessionId).setConfigOption(
                SessionConfigId(configId),
                SessionConfigOptionValue.StringValue(value),
            )
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
            runCatching { withTimeout(ACP_SESSION_TEARDOWN_TIMEOUT_MS) { session.close() } }
                .onFailure { log.warn("Failed to close session $sessionId at protocol level", it) }
            sessions.remove(sessionId)
        }
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

    private inner class Operations(private val sessionId: SessionId) : ClientSessionOperations {
        override suspend fun requestPermissions(
            toolCall: SessionUpdate.ToolCallUpdate,
            permissions: List<PermissionOption>,
            _meta: kotlinx.serialization.json.JsonElement?,
        ): RequestPermissionResponse = permissionHandler(
            RequestPermissionRequest(sessionId, toolCall, permissions, _meta),
        ) ?: RequestPermissionResponse(RequestPermissionOutcome.Cancelled)

        override suspend fun notify(
            notification: SessionUpdate,
            _meta: kotlinx.serialization.json.JsonElement?,
        ) = publish(sessionId, notification)
    }

    private fun publish(sessionId: SessionId, update: SessionUpdate) {
        // Suppress the SDK's cancel-time UsageUpdate(used=0) pseudo-event at
        // the origin, before it zeroes usedTokens in the store.
        if (update is SessionUpdate.UsageUpdate && update.used == 0L && cancelledSessions.contains(sessionId.value)) {
            log.info("publish: suppressing cancelled-flow UsageUpdate(used=0, size=${update.size}) for sessionId=${sessionId.value}")
            return
        }
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

    fun getAvailableCommands(sessionId: String): List<Triple<String, String, String?>> =
        cachedCommands[sessionId] ?: emptyList()

    /** Claims the backend error recorded after [errorSeqAtStart], if any, for exactly one caller. */
    private fun consumeBackendError(errorSeqAtStart: Long): String? {
        while (true) {
            val current = backendErrorSlot.get() ?: return null
            if (current.first <= errorSeqAtStart) return null
            if (backendErrorSlot.compareAndSet(current, null)) return current.second
        }
    }

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
            runCatching { runBlocking { withTimeout(ACP_SESSION_TEARDOWN_TIMEOUT_MS) { session.close() } } }
                .onFailure { log.warn("Failed to close session $sessionId during connection close", it) }
        }
        ideMcpHandles.values.forEach { runCatching { it.stop() } }
        ideMcpHandles.clear()
        sessions.clear()
        sessionCwds.clear()
        cachedCommands.clear()
        cachedUsage.clear()
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
        p.destroy()
        ApplicationManager.getApplication().executeOnPooledThread {
            if (!p.waitFor(PROCESS_EXIT_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                log.warn("ACP agent pid=${p.pid()} did not exit within ${PROCESS_EXIT_TIMEOUT_MS}ms, force-destroying")
                p.destroyForcibly()
            }
        }
    }
}
