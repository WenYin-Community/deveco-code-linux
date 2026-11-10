package org.deveco.code.session.model

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class EffortDefaultTest {

    @Test
    fun `reads the forwarded default effort from option meta`() {
        assertEquals("high", forwardedDefaultEffort(buildJsonObject { put("defaultEffort", "high") }))
    }

    @Test
    fun `ignores absent or non-string forwarded defaults`() {
        assertNull(forwardedDefaultEffort(null))
        assertNull(forwardedDefaultEffort(buildJsonObject { }))
        assertNull(forwardedDefaultEffort(buildJsonObject { put("defaultEffort", 3) }))
    }

    @Test
    fun `applies the default when the current tier is ACP's first-tier fallback`() {
        assertEquals("high", defaultEffortToApply(listOf("low", "high", "max"), "low", "high"))
    }

    @Test
    fun `applies the default when the current tier is the default sentinel`() {
        assertEquals("high", defaultEffortToApply(listOf("low", "high", "default"), "default", "high"))
    }

    @Test
    fun `applies the default when the current tier is stale`() {
        assertEquals("high", defaultEffortToApply(listOf("low", "high", "max"), "missing", "high"))
    }

    @Test
    fun `applies the default to a new session even when the current tier is non-first`() {
        assertEquals("high", defaultEffortToApply(listOf("low", "high", "max"), "max", "high", isNewSession = true))
    }

    @Test
    fun `keeps an explicit non-first tier restored from history`() {
        assertNull(defaultEffortToApply(listOf("low", "high", "max"), "max", "high"))
    }

    @Test
    fun `does not rewrite when the current tier already matches`() {
        assertNull(defaultEffortToApply(listOf("low", "high"), "high", "high"))
    }

    @Test
    fun `ignores a forwarded default the model does not offer`() {
        assertNull(defaultEffortToApply(listOf("low", "max"), "low", "high"))
    }

    @Test
    fun `does nothing without a forwarded default`() {
        assertNull(defaultEffortToApply(listOf("low", "high"), "low", null))
    }
}
