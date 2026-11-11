package org.deveco.code.action

import java.util.concurrent.atomic.AtomicBoolean

/**
 * Creation guard for a staged bridge delivery: claimed when the delivery begins and
 * released only when its handoff is consumed, superseded or settled by timeout.
 *
 * Deliberately separate from [DevEcoSessionActions.busy]: the sidebar's list state writes
 * `busy = false` through every state update, and those writes must not release a
 * delivery whose handoff is still waiting for its editor. There is no code path from the
 * UI state to this guard — that separation is what makes it safe, not any test.
 *
 * All operations are atomic and thread-safe: the claim happens on the EDT, while the
 * consumption release may run on the async editor-loading thread and the settlement
 * release on the scheduler thread.
 */
internal class HandoffDeliveryGuard {
    private val held = AtomicBoolean(false)

    /** Claims the guard for a new delivery; false means one is already in flight. */
    fun begin(): Boolean = held.compareAndSet(false, true)

    /** Releases the guard; idempotent, and only ever called for the handoff it was held for. */
    fun release() {
        held.set(false)
    }

    val inFlight: Boolean
        get() = held.get()
}
