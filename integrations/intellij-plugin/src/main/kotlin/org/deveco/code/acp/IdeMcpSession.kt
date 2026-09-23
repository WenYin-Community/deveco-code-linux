package org.deveco.code.acp

import com.agentclientprotocol.model.HttpHeader
import com.agentclientprotocol.model.McpServer
import com.intellij.mcpserver.impl.McpServerService
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

class IdeMcpEndpoint(val port: Int, val tokenName: String, val token: String) {
    val sseUrl: String get() = "http://127.0.0.1:$port/sse"
}

class IdeMcpHandle internal constructor(val endpoint: IdeMcpEndpoint, private val job: Job) {

    fun toMcpServer(): McpServer = McpServer.Sse(
        name = SERVER_NAME,
        url = endpoint.sseUrl,
        headers = listOf(HttpHeader(endpoint.tokenName, endpoint.token)),
    )

    fun stop() {
        job.cancel()
    }

    private companion object {
        const val SERVER_NAME = "Deveco Studio"
    }
}

/**
 * Per-project owner of the IDE MCP endpoint, registered as a Disposer child of
 * [AcpClientService]; disposing cancels the scope and all live handle jobs.
 */
internal class IdeMcpSession(private val project: Project) : Disposable {

    private val log = Logger.getInstance(IdeMcpSession::class.java)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun acquire(): IdeMcpHandle? {
        val deferred = CompletableDeferred<IdeMcpEndpoint>()
        val job = scope.launch {
            try {
                val svc = acquireService()
                if (svc == null) {
                    deferred.completeExceptionally(
                        IllegalStateException("McpServerService is not available (is com.intellij.mcpServer bundled?)"),
                    )
                    return@launch
                }
                val options = createSessionOptions(
                    McpServerService.AskCommandExecutionMode.RESPECT_GLOBAL_SETTINGS,
                )
                svc.authorizedSession(options) { port, tokenName, token ->
                    val endpoint = IdeMcpEndpoint(port, tokenName, token)
                    deferred.complete(endpoint)
                    log.info("IDE MCP session up: port=$port tokenName=$tokenName")
                    awaitCancellation()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                log.warn("IDE MCP session failed to start", e)
                deferred.completeExceptionally(e)
            }
        }
        return try {
            val endpoint = runBlocking { withTimeout(START_TIMEOUT_MS) { deferred.await() } }
            IdeMcpHandle(endpoint, job)
        } catch (e: Throwable) {
            log.warn("IDE MCP acquire failed or timed out", e)
            job.cancel()
            null
        }
    }

    override fun dispose() {
        scope.cancel()
    }

    private fun createSessionOptions(
        mode: McpServerService.AskCommandExecutionMode,
    ): McpServerService.McpSessionOptions {
        val optionsClass = McpServerService.McpSessionOptions::class.java
        val modeClass = McpServerService.AskCommandExecutionMode::class.java
        try {
            val ctor = optionsClass.getDeclaredConstructor(modeClass)
            return ctor.newInstance(mode)
        } catch (_: NoSuchMethodException) {
        }
        try {
            val filterInterface = Class.forName("com.intellij.mcpserver.McpToolFilter")
            val ctor = optionsClass.getDeclaredConstructor(modeClass, filterInterface)
            val allowAllClass = Class.forName("com.intellij.mcpserver.McpToolFilter\$AllowAll")
            val allowAllInstance = allowAllClass.getField("INSTANCE").get(null)
            return ctor.newInstance(mode, allowAllInstance)
        } catch (_: Exception) {
        }
        throw NoSuchMethodError(
            "No compatible McpSessionOptions constructor found; " +
                "expected (AskCommandExecutionMode) or (AskCommandExecutionMode, McpToolFilter)",
        )
    }

    private fun acquireService(): McpServerService? {
        val app = ApplicationManager.getApplication()
        app.getService(McpServerService::class.java)?.let { return it }
        return project.getService(McpServerService::class.java)
    }

    companion object {
        private const val START_TIMEOUT_MS = 15_000L
    }
}
