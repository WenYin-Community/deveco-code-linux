package org.deveco.code.acp

import com.agentclientprotocol.annotations.UnstableApi
import com.agentclientprotocol.model.RequestPermissionRequest
import com.agentclientprotocol.model.RequestPermissionResponse
import com.agentclientprotocol.model.SessionConfigOption
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.util.Disposer
import org.deveco.code.util.devecoStorageRoot
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.nio.file.Files
import java.nio.file.Path
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Per-connection credentials for the backend HTTP endpoint's basic auth. */
private data class ServerCredentials(val username: String, val password: String)

/**
 * Application-level owner of the single shared `deveco acp` subprocess.
 *
 * The backend accepts one ACP connection per process but keys its session and
 * config state per cwd, so one process serves every open project. Each
 * project's [AcpClientService] attaches here: the connection, HTTP sidecar and
 * process lifetime are shared; per-project state stays on the facades.
 * Lifecycle is expressed in the Disposer tree — connections are children of
 * this service, facades hold [Attachment] handles as their own children.
 */
@Service(Service.Level.APP)
@OptIn(UnstableApi::class)
class SharedAcpBackend : Disposable {

    companion object {
        private val log = Logger.getInstance(SharedAcpBackend::class.java)
        private val IS_WINDOWS = System.getProperty("os.name").startsWith("Windows")

        // Loopback only — the backend must never bind any other host.
        private const val HTTP_HOST = "127.0.0.1"
        private const val USERNAME_RANDOM_BYTES = 16
        private const val PASSWORD_RANDOM_BYTES = 32

        private fun findAvailablePort(): Int {
            ServerSocket(0, 0, InetAddress.getByName(HTTP_HOST)).use { return it.localPort }
        }

        private fun secureToken(random: SecureRandom, bytes: Int): String {
            val buffer = ByteArray(bytes)
            random.nextBytes(buffer)
            return Base64.getUrlEncoder().withoutPadding().encodeToString(buffer)
        }

        /**
         * Removes stale deveco lock files before spawn: Bun v1.3.14 (deveco.exe)
         * panics in DeleteFile on a leftover lock from a previous run.
         */
        private fun cleanupStaleLocks() {
            if (!IS_WINDOWS) return
            val locksDir = devecoStorageRoot.resolve("state/locks").toFile()
            if (!locksDir.isDirectory) return
            // Only remove locks stale per Flock semantics (heartbeat/meta mtime
            // older than 60s) — indiscriminate deletion breaks live holders.
            val staleMs = 60_000L
            val now = System.currentTimeMillis()
            locksDir.listFiles { f -> f.name.endsWith(".lock") }?.forEach { lock ->
                val heartbeat = java.io.File(lock, "heartbeat")
                val meta = java.io.File(lock, "meta.json")
                val stamp = when {
                    heartbeat.isFile -> heartbeat.lastModified()
                    meta.isFile -> meta.lastModified()
                    else -> lock.lastModified()
                }
                if (now - stamp <= staleMs) return@forEach
                if (!lock.deleteRecursively()) {
                    log.warn("Could not delete stale lock: ${lock.absolutePath}")
                } else {
                    log.info("Deleted stale lock: ${lock.absolutePath}")
                }
            }
        }
    }

    enum class ConnectionState { STOPPED, CONNECTING, READY, FAILED }

    private val connectionRef = AtomicReference<AcpClientConnection>()

    @Volatile
    private var httpPort: Int = 0

    @Volatile
    private var httpApi: DevEcoHttpApi? = null

    @Volatile
    private var connectionState: ConnectionState = ConnectionState.STOPPED

    @Volatile
    private var statusText: String = "Not connected"

    /** facade → its [Attachment]; a non-empty map keeps the process alive. */
    private val attachments = LinkedHashMap<AcpClientService, Attachment>()

    /** sessionId → owning facade; demultiplexes session updates and permission requests. */
    private val routes = ConcurrentHashMap<String, AcpClientService>()

    // One HTTP sidecar → one lock for backend mutations across projects;
    // AcpClientService.backendMutationLock delegates here.
    internal val backendMutationLock = Any()

    /**
     * One facade's claim, registered by the facade as its own Disposer child.
     * Disposing detaches the facade; the last one out stops the process.
     */
    internal inner class Attachment(private val facade: AcpClientService) : Disposable {
        private val disposed = AtomicBoolean(false)

        override fun dispose() {
            if (disposed.compareAndSet(false, true)) {
                detach(facade)
            }
        }
    }

    /** Registers [facade] and returns its claim; idempotent. Pair with [ensureConnection]. */
    internal fun attach(facade: AcpClientService): Attachment = synchronized(this) {
        attachments.getOrPut(facade) { Attachment(facade) }
    }

    /**
     * Detaches [facade]: its sessions are cancelled and closed synchronously —
     * project close blocks until done, so no agent work survives the dispose.
     * The process dies only when the last facade detaches.
     */
    private fun detach(facade: AcpClientService) {
        var retired: AcpClientConnection? = null
        synchronized(this) {
            if (attachments.remove(facade) == null) return@synchronized
            // Drop the routes first so late updates and permission requests can
            // never reach a disposed project.
            val sessionIds = routes.entries.filter { it.value === facade }.map { it.key }
            sessionIds.forEach { routes.remove(it, facade) }
            if (attachments.isEmpty()) {
                retired = retireConnectionLocked()
                return@synchronized
            }
            val connection = connectionRef.get() ?: return@synchronized
            if (!connection.isAlive() || sessionIds.isEmpty()) return@synchronized
            // closeSession cancels the in-flight turn and closes the session,
            // bounded by timeouts so a hung backend cannot freeze close forever.
            sessionIds.forEach { id ->
                runCatching { connection.closeSession(id) }
                    .onFailure { log.warn("Failed to stop and close session $id of detached project", it) }
            }
        }
        disposeConnection(retired)
    }

    /** Reuses the live connection, replaces a dead one, or spawns the process. */
    fun ensureConnection(): Boolean {
        var fresh: AcpClientConnection? = null
        var retired: AcpClientConnection? = null
        val connected = synchronized(this) {
            val existing = connectionRef.get()
            if (existing != null && existing.isAlive()) {
                true
            } else {
                if (existing != null) retired = retireConnectionLocked()
                fresh = connectLocked()
                fresh != null
            }
        }
        registerChild(fresh)
        disposeConnection(retired)
        return connected
    }

    fun reconnect(): Boolean {
        var fresh: AcpClientConnection? = null
        var retired: AcpClientConnection? = null
        val reconnected = synchronized(this) {
            retired = retireConnectionLocked()
            if (attachments.isEmpty()) {
                false
            } else {
                fresh = connectLocked()
                fresh != null
            }
        }
        registerChild(fresh)
        disposeConnection(retired)
        return reconnected
    }

    /**
     * Never spawn with a project directory as cwd: on Windows the process cwd
     * locks that directory against deletion. The storage root costs one
     * eagerly-bootstrapped ambient instance that is never a session cwd.
     */
    private fun neutralSpawnDirectory(): String = try {
        Files.createDirectories(devecoStorageRoot).toString()
    } catch (e: IOException) {
        log.warn("Could not create spawn directory $devecoStorageRoot, using IDE system dir", e)
        PathManager.getSystemPath()
    }

    private fun connectLocked(): AcpClientConnection? {
        val originalCl = Thread.currentThread().contextClassLoader
        connectionState = ConnectionState.CONNECTING
        statusText = "Connecting to DevEco Code…"
        try {
            Thread.currentThread().contextClassLoader = SharedAcpBackend::class.java.classLoader
            val spawnDirectory = neutralSpawnDirectory()
            val command = try {
                resolveAgentCommand()
            } catch (e: Exception) {
                log.warn("No usable DevEco Code CLI available", e)
                connectionState = ConnectionState.FAILED
                statusText = "DevEco Code unavailable: ${e.message ?: e.javaClass.simpleName}"
                return null
            }
            try {
                val detection = DevEcoCodeDetector.validateAcp(Path.of(command))
                log.info("DevEco Code validated: ${detection.version} at $command")
            } catch (e: DevEcoCodeDetector.AcpUnavailableException) {
                // Advisory: let ACP connect and surface real protocol errors rather
                // than hiding all sessions on an unfamiliar CLI shape.
                log.warn("DevEco Code ACP validation failed, proceeding anyway: ${e.message}")
            }
            // The port is picked before spawn and raced for by the backend's bind;
            // retry once with a fresh port if that race is lost.
            var lastError: Exception? = null
            repeat(2) {
                val candidatePort = findAvailablePort()
                val bridge = AcpClientConnection(
                    spawnDirectory,
                    ::publishSessionUpdate,
                    ::requestPermission,
                )
                cleanupStaleLocks()
                // Fresh per-connection credentials, handed over via the env vars
                // `deveco acp` reads on startup: a random token keeps other local
                // processes out of the sidecar.
                val random = SecureRandom()
                val credentials = ServerCredentials(
                    username = "deveco_" + secureToken(random, USERNAME_RANDOM_BYTES),
                    password = secureToken(random, PASSWORD_RANDOM_BYTES),
                )
                try {
                    bridge.connect(
                        command,
                        listOf("acp", "--hostname", HTTP_HOST, "--port", candidatePort.toString(), "--print-logs"),
                        mapOf(
                            "DEVECO_SERVER_USERNAME" to credentials.username,
                            "DEVECO_SERVER_PASSWORD" to credentials.password,
                            "DEVECO_DISABLE_MEMORY" to "true",
                        ),
                    )
                    httpPort = candidatePort
                    httpApi = DevEcoHttpApi(
                        "http://$HTTP_HOST:$candidatePort",
                        credentials.username,
                        credentials.password,
                    )
                    connectionRef.set(bridge)
                    connectionState = ConnectionState.READY
                    statusText = "Connected · session endpoint http://$HTTP_HOST:$candidatePort"
                    log.info(
                        "Shared ACP backend connected to agent: $command; HTTP endpoint: http://$HTTP_HOST:$candidatePort; spawnDirectory=$spawnDirectory",
                    )
                    return bridge
                } catch (e: Exception) {
                    lastError = e
                    log.warn("ACP connect attempt failed (port=$candidatePort): ${e.message}", e)
                    runCatching { bridge.dispose() }
                }
            }
            log.warn("Failed to connect shared ACP backend to agent: $command", lastError)
            connectionState = ConnectionState.FAILED
            statusText = "DevEco Code unavailable: ${lastError?.message ?: lastError?.javaClass?.simpleName}"
            return null
        } finally {
            Thread.currentThread().contextClassLoader = originalCl
        }
    }

    /**
     * Clears connection state; the caller disposes the retired connection
     * outside this service's monitor.
     */
    @Synchronized
    private fun retireConnectionLocked(): AcpClientConnection? {
        routes.clear()
        val connection = connectionRef.getAndSet(null)
        httpPort = 0
        httpApi = null
        connectionState = ConnectionState.STOPPED
        statusText = "Not connected"
        return connection
    }

    /**
     * Registers a connection as a Disposer child of this service. Must run
     * outside this service's monitor: dispose callbacks run under the tree
     * lock and re-enter the monitor, so the reverse order could deadlock.
     * Retired connections are disposed directly instead; their lingering tree
     * nodes become no-ops at backend disposal ([AcpClientConnection.dispose]
     * is idempotent).
     */
    private fun registerChild(child: AcpClientConnection?) {
        if (child == null) return
        try {
            Disposer.register(this, child)
        } catch (e: Exception) {
            // The backend is being disposed concurrently, so the connection
            // cannot join the tree — close it directly instead.
            log.warn("Shared ACP backend disposed while connecting", e)
            disposeConnection(child)
        }
    }

    private fun disposeConnection(connection: AcpClientConnection?) {
        if (connection == null) return
        runCatching { connection.dispose() }
            .onFailure { log.warn("Error closing shared ACP connection", it) }
    }

    fun newSessionFor(facade: AcpClientService, cwd: String, acquireIdeMcp: () -> IdeMcpHandle?): String =
        // Routed from the operations factory, before the SDK can dispatch the
        // session's first update — registering after the call would drop
        // early updates as unrouted.
        requireConnection().newSession(cwd, acquireIdeMcp) { routes[it] = facade }

    fun loadSessionFor(
        facade: AcpClientService,
        sessionId: String,
        cwd: String,
        acquireIdeMcp: () -> IdeMcpHandle?,
    ): List<SessionConfigOption> {
        val options = requireConnection().loadSession(sessionId, cwd, acquireIdeMcp) { routes[sessionId] = facade }
        // Refresh covers the already-loaded case, where the factory hook doesn't run.
        routes[sessionId] = facade
        return options
    }

    /** Closes the ACP runtime of [sessionId] and forgets its route; throws when disconnected. */
    fun closeSession(sessionId: String) {
        // Route first (as in closeSessionIfLive): a failed close must not leave a stale route.
        routes.remove(sessionId)
        requireConnection().closeSession(sessionId)
    }

    /** Tolerant variant for teardown paths: no-op when the backend is not connected. */
    fun closeSessionIfLive(sessionId: String) {
        val connection = liveConnection() ?: return
        routes.remove(sessionId)
        connection.closeSession(sessionId)
    }

    fun cancelPromptIfLive(sessionId: String) {
        liveConnection()?.cancelPrompt(sessionId)
    }

    fun isConnected(): Boolean = connectionRef.get()?.isAlive() == true

    fun connectionState(): ConnectionState = connectionState

    fun statusText(): String = statusText

    internal fun httpApi(): DevEcoHttpApi? = httpApi

    internal fun requireConnection(): AcpClientConnection {
        val connection = connectionRef.get() ?: throw IllegalStateException("ACP client is not connected")
        if (!connection.isAlive()) throw IllegalStateException("ACP agent process has exited")
        return connection
    }

    internal fun liveConnection(): AcpClientConnection? = connectionRef.get()?.takeIf { it.isAlive() }

    private fun publishSessionUpdate(update: AcpSessionUpdate) {
        val facade = routes[update.sessionId.value]
        if (facade == null) {
            log.info(
                "ACP update for unrouted session ${update.sessionId.value} (closed or owner detached): " +
                    update.update::class.simpleName,
            )
            return
        }
        facade.publishSessionUpdate(update)
    }

    private fun requestPermission(request: RequestPermissionRequest): RequestPermissionResponse? {
        val facade = routes[request.sessionId.value]
        if (facade == null) {
            log.warn("Permission request for unrouted session ${request.sessionId.value}; cancelling")
            return null
        }
        return facade.requestPermission(request)
    }

    /** The plugin-bundled CLI is the only supported agent binary; there are no PATH or env-var fallbacks. */
    private fun resolveAgentCommand(): String = try {
        val bundled = CliBinaryExtractor.extract()
        log.info("Using bundled CLI: $bundled")
        bundled
    } catch (e: Exception) {
        throw IllegalStateException(
            "Bundled DevEco Code CLI is unavailable: ${e.message ?: e.javaClass.simpleName}",
            e,
        )
    }

    override fun dispose() {
        // Tree children are disposed before this runs; disposing is idempotent.
        disposeConnection(retireConnectionLocked())
    }
}
