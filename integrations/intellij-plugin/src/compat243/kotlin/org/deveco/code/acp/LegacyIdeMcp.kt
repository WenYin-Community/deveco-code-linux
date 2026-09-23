package org.deveco.code.acp

import com.agentclientprotocol.model.McpServer
import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project

// Studio 243 has no built-in IDE MCP server. Backend tools and external MCP
// configuration continue to work; this build never links the newer IDE types.
internal class IdeMcpSession(@Suppress("UNUSED_PARAMETER") project: Project) : Disposable {
    fun acquire(): IdeMcpHandle? = null
    override fun dispose() = Unit
}

class IdeMcpEndpoint(val port: Int) {
    val sseUrl: String get() = "http://127.0.0.1:$port/sse"
}

class IdeMcpHandle internal constructor(val endpoint: IdeMcpEndpoint) {
    fun toMcpServer(): McpServer = error("IDE MCP is unavailable on platform 243")
    fun stop() = Unit
}
