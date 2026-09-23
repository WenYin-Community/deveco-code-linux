package org.deveco.code.sidebar

import java.util.concurrent.ConcurrentHashMap

class SessionStatusTracker {

    @Volatile
    var onChanged: (() -> Unit)? = null

    @Volatile
    var onSessionDone: ((String) -> Unit)? = null
    private val running: ConcurrentHashMap<String, Long> = ConcurrentHashMap()
    private val lastDurations = ConcurrentHashMap<String, Long>()

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

    fun isRunning(sessionId: String?): Boolean = sessionId != null && running.containsKey(sessionId)

    fun startedAt(sessionId: String?): Long? = sessionId?.let { running[it] }

    fun snapshot(): Map<String, Long> = running.toMap()

    fun lastDuration(sessionId: String?): Long? = sessionId?.let { lastDurations[it] }

    fun lastDurationSnapshot(): Map<String, Long> = lastDurations.toMap()
}
