package org.deveco.code.session.usage

import org.deveco.code.session.model.configuration.SessionConfiguration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

internal class TokenUsageTest {
    @Test
    fun `restore keeps usage and custom limit`() {
        val usage = TokenUsage(SessionConfiguration())

        usage.restore(used = 80L, total = 200L, customLimit = 100L)

        assertEquals(80L, usage.usedTokens)
        assertEquals(200L, usage.totalTokens)
        assertEquals(100L, usage.customTokenLimit)
        assertEquals(100L, usage.effectiveTotalTokens)
    }

    @Test
    fun `custom limit takes precedence over server total`() {
        val usage = TokenUsage(SessionConfiguration(tokenLimit = 50L))

        usage.restore(used = 40L, total = 100L, customLimit = 0L)

        assertEquals(50L, usage.effectiveTotalTokens)
    }

    @Test
    fun `zero used update does not overwrite prior usage but does update total`() {
        val usage = TokenUsage(SessionConfiguration())
        usage.restore(used = 10L, total = 100L, customLimit = 0L)

        assertFalse(usage.accept(used = 0L, size = 200L))
        assertEquals(10L, usage.usedTokens)
        assertEquals(200L, usage.totalTokens)
    }

    @Test
    fun `memory limit enters and clears from accepted usage`() {
        val usage = TokenUsage(SessionConfiguration())

        assertTrue(usage.accept(used = 100L, size = 100L))
        assertTrue(usage.memoryLimitReached)

        assertTrue(usage.accept(used = 50L, size = 100L))
        assertFalse(usage.memoryLimitReached)
    }

    @Test
    fun `changing custom limit recalculates memory limit`() {
        val usage = TokenUsage(SessionConfiguration())
        usage.restore(used = 80L, total = 100L, customLimit = 0L)
        assertFalse(usage.memoryLimitReached)

        usage.setCustomLimit(50L)
        assertTrue(usage.memoryLimitReached)

        usage.setCustomLimit(200L)
        assertFalse(usage.memoryLimitReached)
    }

    @Test
    fun `clear resets usage limit and memory state`() {
        val usage = TokenUsage(SessionConfiguration())
        usage.restore(used = 100L, total = 100L, customLimit = 80L)

        usage.clear()

        assertEquals(0L, usage.usedTokens)
        assertEquals(0L, usage.totalTokens)
        assertEquals(0L, usage.customTokenLimit)
        assertEquals(0L, usage.effectiveTotalTokens)
        assertFalse(usage.memoryLimitReached)
    }
}
