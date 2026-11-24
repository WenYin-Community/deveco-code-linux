package org.deveco.code.action

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HandoffDeliveryGuardTest {

    @Test
    fun `begin claims the guard once until released`() {
        val guard = HandoffDeliveryGuard()
        assertTrue(guard.begin())
        assertTrue(guard.inFlight)
        assertFalse("a delivery already in flight rejects the next claim", guard.begin())
    }

    @Test
    fun `release allows the next delivery to begin`() {
        val guard = HandoffDeliveryGuard()
        guard.begin()
        guard.release()
        assertFalse(guard.inFlight)
        assertTrue(guard.begin())
    }

    @Test
    fun `release is idempotent`() {
        val guard = HandoffDeliveryGuard()
        guard.begin()
        guard.release()
        guard.release()
        assertTrue("a stale late release must not hold the next claim", guard.begin())
    }

    @Test
    fun `release without begin does not hold a later claim`() {
        val guard = HandoffDeliveryGuard()
        guard.release()
        assertTrue(guard.begin())
    }
}
