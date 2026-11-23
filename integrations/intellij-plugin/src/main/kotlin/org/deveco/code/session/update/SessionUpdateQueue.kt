package org.deveco.code.session.update

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.diagnostic.Logger
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean

internal class SessionUpdateQueue(
    private val isDisposed: () -> Boolean,
    private val schedule: ((() -> Unit) -> Unit) = { action ->
        // A one-argument invokeLater from a background thread is non-modal and
        // would be deferred behind IDE dialogs. This queue only mutates snapshot
        // state, so draining during modality is safe.
        ApplicationManager.getApplication().invokeLater(action, ModalityState.any())
    },
    private val reportFailure: (String, Exception) -> Unit = { message, error ->
        Logger.getInstance(SessionUpdateQueue::class.java).error(message, error)
    },
    private val maxPerTurn: Int = 64,
) {
    private val pending = ConcurrentLinkedQueue<() -> Unit>()
    private val drainScheduled = AtomicBoolean(false)

    fun enqueue(action: () -> Unit) {
        pending.add(action)
        scheduleDrain()
    }

    fun clear() {
        pending.clear()
    }

    private fun scheduleDrain() {
        if (!drainScheduled.compareAndSet(false, true)) return
        schedule(::drain)
    }

    private fun drain() {
        if (isDisposed()) {
            pending.clear()
            drainScheduled.set(false)
            return
        }
        repeat(maxPerTurn) {
            val action = pending.poll() ?: return@repeat
            // One failing action must not leave drainScheduled stuck, which would
            // permanently block every subsequent update for this session.
            try {
                action()
            } catch (error: Exception) {
                reportFailure("Session update action failed", error)
            }
        }
        drainScheduled.set(false)
        if (pending.isNotEmpty()) scheduleDrain()
    }
}
