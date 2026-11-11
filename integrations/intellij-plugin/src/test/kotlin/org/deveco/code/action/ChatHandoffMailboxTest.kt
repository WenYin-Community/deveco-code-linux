package org.deveco.code.action

import org.deveco.code.session.model.FileReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatHandoffMailboxTest {

    private fun ref(path: String) = FileReference(path = path, startLine = 1, endLine = 2)

    @Test
    fun `keyed handoffs are isolated per session and taken once`() {
        val mailbox = ChatHandoffMailbox()
        val forA = PendingChatHandoff(fileReference = ref("a"))
        val forB = PendingChatHandoff(fullPrompt = "prompt")
        mailbox.stage("A", forA)
        mailbox.stage("B", forB)

        assertSame(forA, mailbox.take("A"))
        assertNull("a handoff is taken exactly once", mailbox.take("A"))
        assertSame(forB, mailbox.take("B"))
    }

    @Test
    fun `take falls back to the next-session slot only when the session has no keyed handoff`() {
        val mailbox = ChatHandoffMailbox()
        val next = PendingChatHandoff(fileReference = ref("next"))
        val keyed = PendingChatHandoff(fullPrompt = "prompt")
        mailbox.stageNext(next)
        mailbox.stage("A", keyed)

        assertSame("the keyed handoff wins and leaves the slot alone", keyed, mailbox.take("A"))
        assertSame(next, mailbox.take("B"))
        assertNull(mailbox.take("B"))
    }

    @Test
    fun `rekey promotes the next-session slot to a keyed entry`() {
        val mailbox = ChatHandoffMailbox()
        val next = PendingChatHandoff(fileReference = ref("next"))
        mailbox.stageNext(next)

        mailbox.rekeyNext("created")

        assertSame(next, mailbox.take("created"))
        assertNull("the slot no longer hands the handoff to an unrelated editor", mailbox.take("other"))
    }

    @Test
    fun `stage returns the superseded handoff`() {
        val mailbox = ChatHandoffMailbox()
        val first = PendingChatHandoff(fullPrompt = "first")
        val second = PendingChatHandoff(fullPrompt = "second")
        mailbox.stage("A", first)

        assertSame(first, mailbox.stage("A", second))
        assertSame(second, mailbox.take("A"))
    }

    @Test
    fun `remove clears only the still-staged instance`() {
        val mailbox = ChatHandoffMailbox()
        val original = PendingChatHandoff(fullPrompt = "original")
        val replacement = PendingChatHandoff(fullPrompt = "replacement")
        mailbox.stage("A", original)
        mailbox.stage("A", replacement)

        assertFalse("a superseded instance is no longer removable", mailbox.remove("A", original))
        assertTrue(mailbox.remove("A", replacement))
        assertNull(mailbox.take("A"))
    }
}
