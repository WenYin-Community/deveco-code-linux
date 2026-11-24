package org.deveco.code.session.usage

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.setValue

@Stable
internal class TurnTiming(private val now: () -> Long = System::currentTimeMillis) {
    var lastDuration by mutableLongStateOf(0L)
        private set

    @Volatile
    private var startedAtMs = 0L

    fun begin() {
        startedAtMs = now()
    }

    fun currentDuration(): Long = if (startedAtMs > 0) now() - startedAtMs else lastDuration

    fun finish(dispatched: Boolean): Long? {
        val start = startedAtMs
        startedAtMs = 0
        if (!dispatched || start <= 0) return null
        val duration = now() - start
        if (duration <= 0) return null
        lastDuration = duration
        return duration
    }
}
