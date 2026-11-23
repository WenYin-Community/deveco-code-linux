package org.deveco.code.session.usage

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

internal class TurnTimingTest {
    @Test
    fun `dispatched duration becomes current and last duration`() {
        var now = 1_000L
        val timing = TurnTiming { now }
        timing.begin()

        now = 1_750L
        assertEquals(750L, timing.currentDuration())
        assertEquals(750L, timing.finish(dispatched = true))
        assertEquals(750L, timing.lastDuration)
        assertEquals(750L, timing.currentDuration())
    }

    @Test
    fun `dropped prompt does not replace last duration`() {
        var now = 1_000L
        val timing = TurnTiming { now }
        timing.begin()
        now = 1_400L
        timing.finish(dispatched = true)

        timing.begin()
        now = 2_000L

        assertNull(timing.finish(dispatched = false))
        assertEquals(400L, timing.lastDuration)
    }
}
