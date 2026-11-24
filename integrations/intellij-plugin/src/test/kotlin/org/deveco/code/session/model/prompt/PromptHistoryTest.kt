package org.deveco.code.session.model.prompt

import org.deveco.code.session.model.FileReference
import org.deveco.code.session.model.conversation.ConversationInput
import org.deveco.code.session.model.conversation.ConversationItem
import org.deveco.code.session.model.conversation.ConversationThread
import org.deveco.code.session.model.prompt.toFileReferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

internal class PromptHistoryTest {
    @Test
    fun `empty history has no navigation target`() {
        val history = PromptHistory(ConversationThread("session"))

        assertNull(history.navigate(-1))
        assertNull(history.navigate(1))
    }

    @Test
    fun `history derives visible user messages newest first`() {
        val conversation = ConversationThread("session")
        conversation.append(user("user-1", "oldest"))
        conversation.append(user("hidden", "internal", internalOnly = true))
        conversation.append(user("user-2", "newest"))
        val history = PromptHistory(conversation)

        assertEquals(listOf("newest", "oldest"), history.submittedPrompts.map { it.text })
        assertEquals("newest", history.navigate(-1)?.text)
        assertEquals("oldest", history.navigate(-1)?.text)
        assertEquals("newest", history.navigate(1)?.text)
        assertNull(history.navigate(1))
    }

    @Test
    fun `consecutive duplicates share one history entry`() {
        val conversation = ConversationThread("session")
        conversation.append(user("user-1", "repeat"))
        conversation.append(user("user-2", "repeat"))
        val history = PromptHistory(conversation)

        assertEquals(listOf("repeat"), history.submittedPrompts.map { it.text })
    }

    @Test
    fun `history keeps the newest fifty submitted prompts`() {
        val conversation = ConversationThread("session")
        repeat(51) { conversation.append(user("user-$it", "prompt-$it")) }
        val history = PromptHistory(conversation)

        assertEquals(50, history.submittedPrompts.size)
        assertEquals("prompt-50", history.submittedPrompts.first().text)
        assertEquals("prompt-1", history.submittedPrompts.last().text)
    }

    @Test
    fun `file reference path text is removed while selected text remains canonical`() {
        val path = java.nio.file.Path.of("src/Main.kt").toAbsolutePath().toString()
        val draft = PromptDraft().apply {
            text = "review @$path carefully"
            addEditorSelection(path, 1, 3, "snapshot")
        }
        val prompt = draft.snapshot()
        val conversation = ConversationThread("session").apply {
            append(user("user-1", prompt))
        }

        val stored = PromptHistory(conversation).submittedPrompts.single()

        assertEquals("review  carefully", stored.text)
        assertEquals(
            FileReference(path, 1, 3, "snapshot"),
            stored.toFileReferences().single(),
        )
    }

    @Test
    fun `image payload remains available after history restore`() {
        val prompt = Prompt(
            listOf(
                PromptPart.Image(
                    path = "/tmp/screen.png",
                    mimeType = "image/png",
                    name = "screen.png",
                ),
            ),
        )
        val conversation = ConversationThread("session").apply {
            append(user("user-1", prompt))
        }

        val stored = PromptHistory(conversation).submittedPrompts.single()

        assertEquals(prompt, stored)
        assertEquals("screen.png", (stored.attachmentParts.single() as PromptPart.Image).name)
    }

    @Test
    fun `history stores a complete command and user draft as ordinary prompt text`() {
        val prompt = PromptDraft().apply { text = "/review\n\nuser" }.snapshot()
        val conversation = ConversationThread("session").apply {
            append(user("user-1", prompt))
        }
        val restored = PromptDraft().apply {
            restore(PromptHistory(conversation).navigate(-1)!!)
        }

        assertEquals("/review\n\nuser", restored.text)
    }

    @Test
    fun `history excludes assistant-only parts from a visible prompt`() {
        val prompt = Prompt(
            listOf(
                PromptPart.Text("visible"),
                PromptPart.Text("model context", PromptAudience.ASSISTANT),
            ),
        )
        val conversation = ConversationThread("session").apply {
            append(user("user-1", prompt))
        }

        val stored = PromptHistory(conversation).submittedPrompts.single()

        assertEquals("visible", stored.text)
        assertEquals(listOf(PromptPart.Text("visible")), stored.parts)
    }

    @Test
    fun `replacing one user message replaces its history entry`() {
        val conversation = ConversationThread("session")
        conversation.append(user("message-1", "first"))
        conversation.replaceMessageAt("message-1", user("message-1", "first\n\nsecond"))

        val history = PromptHistory(conversation)

        assertEquals(1, history.submittedPrompts.size)
        assertEquals("first\n\nsecond", history.submittedPrompts.single().text)
    }

    private fun user(id: String, text: String, internalOnly: Boolean = false): ConversationItem.User =
        ConversationItem.user(
            input = ConversationInput.text(id = id, text = text, createdAt = 0),
            internalOnly = internalOnly,
        )

    private fun user(id: String, prompt: Prompt): ConversationItem.User = ConversationItem.user(
        input = ConversationInput.fromPrompt(id = id, prompt = prompt, createdAt = 0),
    )
}
