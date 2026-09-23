package org.deveco.code.session

import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import org.deveco.code.util.PluginStateFiles

@Service(Service.Level.PROJECT)
internal class TokenUsageStore(private val project: Project) {

    data class UsageEntry(
        var sessionId: String = "",
        var usedTokens: Long = 0L,
        var totalTokens: Long = 0L,
        var customTokenLimit: Long = 0L,
    )

    data class State(var entries: MutableList<UsageEntry> = mutableListOf())

    private val state = PluginStateFiles.readJson(project, "token-usage.json", State::class.java) ?: State()
    private val log = Logger.getInstance(TokenUsageStore::class.java)

    // Pooled-thread reads (session load) vs EDT writes; the lock also guards markDirty's
    // Gson serialization.
    private val lock = Any()

    fun getUsage(sessionId: String): Triple<Long, Long, Long>? = synchronized(lock) {
        val entry = state.entries.firstOrNull { it.sessionId == sessionId }
        if (entry != null && (entry.usedTokens > 0 || entry.totalTokens > 0 || entry.customTokenLimit > 0)) {
            Triple(entry.usedTokens, entry.totalTokens, entry.customTokenLimit)
        } else {
            null
        }
    }

    fun saveUsage(sessionId: String, usedTokens: Long, totalTokens: Long) = synchronized(lock) {
        val existing = state.entries.firstOrNull { it.sessionId == sessionId }
        if (existing != null) {
            existing.usedTokens = usedTokens
            existing.totalTokens = totalTokens
        } else {
            state.entries.add(UsageEntry(sessionId, usedTokens, totalTokens))
        }
        markDirty()
    }

    fun saveCustomLimit(sessionId: String, customLimit: Long) = synchronized(lock) {
        val existing = state.entries.firstOrNull { it.sessionId == sessionId }
        if (existing != null) {
            existing.customTokenLimit = customLimit
        } else {
            state.entries.add(UsageEntry(sessionId, 0L, 0L, customLimit))
        }
        markDirty()
    }

    fun clearUsage(sessionId: String) = synchronized(lock) {
        state.entries.removeAll { it.sessionId == sessionId }
        markDirty()
    }

    private fun markDirty() {
        runCatching { PluginStateFiles.writeJson(project, "token-usage.json", state) }
            .onFailure { log.warn("Failed to persist token usage", it) }
    }

    companion object {
        fun getInstance(project: Project): TokenUsageStore = project.getService(TokenUsageStore::class.java)
    }
}
