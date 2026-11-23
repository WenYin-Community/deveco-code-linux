package org.deveco.code.session.model.prompt

import org.deveco.code.session.model.conversation.ConversationInput
import org.deveco.code.session.model.conversation.ConversationItem
import org.deveco.code.session.model.conversation.ConversationThread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

internal class PromptLifecycleTest {
    @Test
    fun `history restore resubmits content with new lifecycle`() {
        val original = ConversationInput.fromPrompt(
            id = "USER-old",
            prompt = Prompt(listOf(PromptPart.Text("fix it"))),
            createdAt = 10,
            admittedSeq = 20,
            promotedSeq = 30,
        )
        val history = PromptHistory(
            ConversationThread("session").apply {
                append(ConversationItem.user(original))
            },
        )

        val restored = PromptDraft().apply {
            restore(history.navigate(-1)!!)
        }
        val resubmitted = ConversationInput.fromPrompt(
            id = "USER-new",
            prompt = restored.snapshot(),
            createdAt = 40,
        )

        assertEquals(original.prompt, resubmitted.prompt)
        assertNotEquals(original.id, resubmitted.id)
        assertEquals(40, resubmitted.createdAt)
        assertNull(resubmitted.admittedSeq)
        assertNull(resubmitted.promotedSeq)
    }
}
