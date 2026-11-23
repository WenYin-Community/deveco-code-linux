package org.deveco.code.session.usage

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.deveco.code.session.model.configuration.SessionConfiguration

@Stable
internal class TokenUsage(private val configuration: SessionConfiguration) {
    var usedTokens by mutableLongStateOf(0L)
        private set
    var totalTokens by mutableLongStateOf(0L)
        private set
    var memoryLimitReached by mutableStateOf(false)
        private set

    val customTokenLimit: Long
        get() = configuration.tokenLimit

    val effectiveTotalTokens: Long
        get() = if (customTokenLimit > 0) customTokenLimit else totalTokens

    fun accept(used: Long, size: Long): Boolean {
        if (used == 0L && usedTokens > 0L) {
            if (size > 0L) totalTokens = size
            return false
        }
        usedTokens = used
        totalTokens = size
        recalculateMemoryLimit()
        return true
    }

    fun setCustomLimit(limit: Long) {
        configuration.tokenLimit = limit
        recalculateMemoryLimit()
    }

    fun restore(used: Long, total: Long, customLimit: Long) {
        usedTokens = used
        totalTokens = total
        if (customLimit > 0) configuration.tokenLimit = customLimit
        recalculateMemoryLimit()
    }

    fun recalculateMemoryLimit() {
        val effectiveTotal = effectiveTotalTokens
        memoryLimitReached = effectiveTotal > 0 &&
            usedTokens > 0 &&
            usedTokens.toDouble() / effectiveTotal.toDouble() >= 1.0
    }

    fun clear() {
        usedTokens = 0L
        totalTokens = 0L
        configuration.tokenLimit = 0L
        memoryLimitReached = false
    }
}
