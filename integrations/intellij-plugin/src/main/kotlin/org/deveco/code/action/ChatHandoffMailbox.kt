package org.deveco.code.action

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference

/**
 * Stage-and-take mailbox for [PendingChatHandoff]s.
 *
 * Keyed entries are isolated per session: a jump or bridge delivery for one session can
 * never clobber another session's handoff, whatever order the writers run in. The
 * next-session slot addresses whichever session a creation flow produces (Quick Chat, a
 * jump whose target was deleted) — that flow promotes the slot to a keyed entry once the
 * id exists and before the tab opens, so the constructed editor finds a keyed handoff.
 *
 * All operations are atomic; [take] hands each handoff to exactly one consumer, so two
 * editors binding the same session (a split view) cannot both deliver it.
 */
internal class ChatHandoffMailbox {
    private val handoffs = ConcurrentHashMap<String, PendingChatHandoff>()
    private val nextSessionHandoff = AtomicReference<PendingChatHandoff?>()

    /** Stages [handoff] for [sessionId]; returns the superseded handoff, if any. */
    fun stage(sessionId: String, handoff: PendingChatHandoff): PendingChatHandoff? = handoffs.put(sessionId, handoff)

    /** Stages [handoff] for whichever session the next creation produces. */
    fun stageNext(handoff: PendingChatHandoff) {
        nextSessionHandoff.set(handoff)
    }

    /** Promotes the next-session slot to a keyed entry for [sessionId], before its editor exists. */
    fun rekeyNext(sessionId: String) {
        val pending = nextSessionHandoff.get() ?: return
        if (nextSessionHandoff.compareAndSet(pending, null)) handoffs[sessionId] = pending
    }

    /** Takes the handoff for [sessionId], falling back to the next-session slot. */
    fun take(sessionId: String): PendingChatHandoff? = handoffs.remove(sessionId) ?: nextSessionHandoff.getAndSet(null)

    /** Takes the next-session handoff regardless of which session it will target. */
    fun takeNext(): PendingChatHandoff? = nextSessionHandoff.getAndSet(null)

    /** Removes [handoff] for [sessionId] only if it is still the staged instance. */
    fun remove(sessionId: String, handoff: PendingChatHandoff): Boolean = handoffs.remove(sessionId, handoff)
}
