package org.deveco.code.sidebar

import java.util.concurrent.ConcurrentHashMap

class SessionStatusTracker {

    @Volatile
    var onChanged: (() -> Unit)? = null

    @Volatile
    var onSessionDone: ((String) -> Unit)? = null
    private val running: ConcurrentHashMap<String, Long> = ConcurrentHashMap()
    private val lastDurations = ConcurrentHashMap<String, Long>()

    // Roots whose turn ended but a background subagent still runs; and roots
    // executing a server-side turn no client RPC tracks (the re-prompt a
    // background completion notice triggers). Both feed the sidebar's aggregate
    // running state only.
    private val subagents = ConcurrentHashMap.newKeySet<String>()
    private val serverTurns = ConcurrentHashMap.newKeySet<String>()

    fun markRunning(sessionId: String?) {
        if (sessionId != null) {
            running[sessionId] = System.currentTimeMillis()
            onChanged?.invoke()
        }
    }

    fun markDone(sessionId: String?) {
        if (sessionId != null) {
            val start = running[sessionId]
            if (start != null) {
                lastDurations[sessionId] = System.currentTimeMillis() - start
            }
            running.remove(sessionId)
            onChanged?.invoke()
            onSessionDone?.invoke(sessionId)
        }
    }

    fun setSubagentRunning(sessionId: String?, active: Boolean) {
        if (sessionId == null) return
        val changed = if (active) subagents.add(sessionId) else subagents.remove(sessionId)
        if (changed) onChanged?.invoke()
    }

    fun setServerTurn(sessionId: String?, active: Boolean) {
        if (sessionId == null) return
        val changed = if (active) serverTurns.add(sessionId) else serverTurns.remove(sessionId)
        if (changed) onChanged?.invoke()
    }

    fun hasServerTurn(sessionId: String?): Boolean = sessionId != null && serverTurns.contains(sessionId)

    /** Everything that keeps a session "running" beyond a client prompt. */
    fun extraRunningIds(): Set<String> = subagents + serverTurns

    fun subagentSnapshot(): Set<String> = subagents.toSet()

    fun serverTurnSnapshot(): Set<String> = serverTurns.toSet()

    /**
     * Prompt round-trip only. [isRunning] deliberately stays prompt-only too:
     * headless-controller disposal keys off it and would leak if a detached
     * subagent kept it busy forever — the sidebar unions [extraRunningIds].
     */
    fun isPromptInFlight(sessionId: String?): Boolean = sessionId != null && running.containsKey(sessionId)

    fun isRunning(sessionId: String?): Boolean = sessionId != null && running.containsKey(sessionId)

    fun startedAt(sessionId: String?): Long? = sessionId?.let { running[it] }

    fun snapshot(): Map<String, Long> = running.toMap()

    fun lastDuration(sessionId: String?): Long? = sessionId?.let { lastDurations[it] }

    fun lastDurationSnapshot(): Map<String, Long> = lastDurations.toMap()
}
