package org.deveco.code.session.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

internal class SessionUpdateQueueTest {
    @Test
    fun `queue preserves fifo and drains in bounded batches`() {
        val fixture = Fixture(maxPerTurn = 2)
        fixture.queue.enqueue { fixture.events.add("one") }
        fixture.queue.enqueue { fixture.events.add("two") }
        fixture.queue.enqueue { fixture.events.add("three") }

        assertEquals(1, fixture.scheduled.size)
        fixture.runNextBatch()
        assertEquals(listOf("one", "two"), fixture.events)
        assertEquals(1, fixture.scheduled.size)

        fixture.runNextBatch()
        assertEquals(listOf("one", "two", "three"), fixture.events)
    }

    @Test
    fun `failing action does not wedge later actions`() {
        val fixture = Fixture(maxPerTurn = 1)
        fixture.queue.enqueue { error("boom") }
        fixture.queue.enqueue { fixture.events.add("after") }

        fixture.runNextBatch()
        assertTrue(fixture.events.isEmpty())
        assertEquals(1, fixture.failures.size)

        fixture.runNextBatch()
        assertEquals(listOf("after"), fixture.events)
    }

    @Test
    fun `disposed queue clears pending work and resets scheduling`() {
        val fixture = Fixture()
        fixture.queue.enqueue { fixture.events.add("stale") }
        fixture.disposed = true

        fixture.runNextBatch()
        assertTrue(fixture.events.isEmpty())

        fixture.disposed = false
        fixture.queue.enqueue { fixture.events.add("fresh") }
        assertEquals(1, fixture.scheduled.size)
        fixture.runNextBatch()
        assertEquals(listOf("fresh"), fixture.events)
    }

    @Test
    fun `explicit clear drops queued actions`() {
        val fixture = Fixture()
        fixture.queue.enqueue { fixture.events.add("stale") }

        fixture.queue.clear()
        fixture.runNextBatch()

        assertTrue(fixture.events.isEmpty())
    }

    private class Fixture(maxPerTurn: Int = 64) {
        val events = mutableListOf<String>()
        val failures = mutableListOf<String>()
        val scheduled = mutableListOf<() -> Unit>()
        var disposed = false

        val queue = SessionUpdateQueue(
            isDisposed = { disposed },
            schedule = { scheduled.add(it) },
            reportFailure = { message, _ -> failures.add(message) },
            maxPerTurn = maxPerTurn,
        )

        fun runNextBatch() {
            scheduled.removeAt(0)()
        }
    }
}
