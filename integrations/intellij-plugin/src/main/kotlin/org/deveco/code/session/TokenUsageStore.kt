package org.deveco.code.session

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import org.deveco.code.util.PluginStateFiles
import java.util.concurrent.atomic.AtomicBoolean

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

    // Pooled-thread reads (session load) vs EDT writes. The lock only guards the
    // in-memory state; persistence runs on a pooled thread outside the lock so
    // high-frequency token updates never block the EDT on disk IO.
    private val lock = Any()
    private val dirty = AtomicBoolean(false)
    private val flushScheduled = AtomicBoolean(false)

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
        dirty.set(true)
        scheduleFlush()
    }

    /** Coalescing background writer: bursts of updates collapse into one write per round. */
    private fun scheduleFlush() {
        if (!flushScheduled.compareAndSet(false, true)) return
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                while (dirty.compareAndSet(true, false)) {
                    val snapshot = synchronized(lock) { State(state.entries.map { it.copy() }.toMutableList()) }
                    runCatching { PluginStateFiles.writeJson(project, "token-usage.json", snapshot) }
                        .onFailure { log.warn("Failed to persist token usage", it) }
                }
            } finally {
                flushScheduled.set(false)
            }
            // A markDirty() racing with the flag reset above must not lose its write.
            if (dirty.get()) scheduleFlush()
        }
    }

    companion object {
        fun getInstance(project: Project): TokenUsageStore = project.getService(TokenUsageStore::class.java)
    }
}
