package org.deveco.code.sidebar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

/**
 * Unit tests for [SessionStatusTracker]: prompt round-trips (markRunning →
 * markDone with duration recording and listener notification), the
 * aggregate-only running sets (subagents/server turns live in
 * extraRunningIds but never in isRunning), change notification only on real
 * changes, and null-id no-ops.
 */
class SessionStatusTrackerTest {

    @Test
    fun testMarkRunningTracksStartAndNotifies() {
        val tracker = SessionStatusTracker()
        val changes = AtomicInteger()
        tracker.onChanged = { changes.incrementAndGet() }

        tracker.markRunning("s1")

        assertTrue(tracker.isRunning("s1"))
        assertTrue(tracker.isPromptInFlight("s1"))
        assertNotNull(tracker.startedAt("s1"))
        assertTrue(tracker.snapshot().containsKey("s1"))
        assertEquals(1, changes.get())
    }

    @Test
    fun testMarkDoneClearsRunningRecordsDurationAndNotifies() {
        val tracker = SessionStatusTracker()
        val done = mutableListOf<String>()
        tracker.onSessionDone = { done.add(it) }

        tracker.markRunning("s1")
        tracker.markDone("s1")

        assertFalse(tracker.isRunning("s1"))
        assertNull(tracker.startedAt("s1"))
        assertNotNull(tracker.lastDuration("s1"))
        assertTrue(tracker.lastDurationSnapshot().containsKey("s1"))
        assertEquals(listOf("s1"), done)
    }

    @Test
    fun testMarkDoneForUnknownSessionNotifiesWithoutDuration() {
        val tracker = SessionStatusTracker()
        val done = mutableListOf<String>()
        tracker.onSessionDone = { done.add(it) }

        tracker.markDone("ghost")

        assertEquals(listOf("ghost"), done)
        assertNull(tracker.lastDuration("ghost"))
    }

    @Test
    fun testNullSessionIdsAreIgnored() {
        val tracker = SessionStatusTracker()
        val changes = AtomicInteger()
        val done = AtomicInteger()
        tracker.onChanged = { changes.incrementAndGet() }
        tracker.onSessionDone = { done.incrementAndGet() }

        tracker.markRunning(null)
        tracker.markDone(null)
        tracker.setSubagentRunning(null, true)
        tracker.setServerTurn(null, true)

        assertEquals(0, changes.get())
        assertEquals(0, done.get())
        assertTrue(tracker.extraRunningIds().isEmpty())
        assertFalse(tracker.isRunning(null))
    }

    @Test
    fun testSubagentsAndServerTurnsFeedOnlyTheAggregateRunningSet() {
        val tracker = SessionStatusTracker()

        tracker.setSubagentRunning("s2", true)
        tracker.setServerTurn("s3", true)

        assertEquals(setOf("s2", "s3"), tracker.extraRunningIds())
        assertEquals(setOf("s2"), tracker.subagentSnapshot())
        assertEquals(setOf("s3"), tracker.serverTurnSnapshot())
        assertTrue(tracker.hasServerTurn("s3"))
        // Aggregate-only: neither keeps the prompt-running state busy.
        assertFalse(tracker.isRunning("s2"))
        assertFalse(tracker.isRunning("s3"))
    }

    @Test
    fun testRedundantExtraRunningUpdatesDoNotNotify() {
        val tracker = SessionStatusTracker()
        val changes = AtomicInteger()
        tracker.onChanged = { changes.incrementAndGet() }

        tracker.setSubagentRunning("s2", true)
        tracker.setSubagentRunning("s2", true)
        tracker.setServerTurn("s3", true)
        tracker.setServerTurn("s3", true)

        assertEquals(2, changes.get())
    }

    @Test
    fun testClearingExtraRunningRemovesThem() {
        val tracker = SessionStatusTracker()

        tracker.setSubagentRunning("s2", true)
        tracker.setServerTurn("s3", true)
        tracker.setSubagentRunning("s2", false)
        tracker.setServerTurn("s3", false)

        assertTrue(tracker.extraRunningIds().isEmpty())
        assertFalse(tracker.hasServerTurn("s3"))
    }

    @Test
    fun testSessionsRunConcurrently() {
        val tracker = SessionStatusTracker()

        tracker.markRunning("s1")
        tracker.markRunning("s2")
        tracker.markDone("s1")

        assertFalse(tracker.isRunning("s1"))
        assertTrue(tracker.isRunning("s2"))
        assertEquals(setOf("s2"), tracker.snapshot().keys)
    }
}
