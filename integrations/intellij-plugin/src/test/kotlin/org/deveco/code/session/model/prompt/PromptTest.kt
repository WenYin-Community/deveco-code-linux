package org.deveco.code.session.model.prompt

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

internal class PromptTest {
    @Test
    fun `text only prompt does not require materialization`() {
        val prompt = PromptDraft().apply { text = "fix the test" }.snapshot()

        assertFalse(prompt.requiresMaterialization)
    }

    @Test
    fun `file attachment does not require materialization`() {
        val prompt = PromptDraft().apply {
            addFileAttachment("/tmp/notes.txt", "notes.txt")
        }.snapshot()

        assertFalse(prompt.requiresMaterialization)
    }

    @Test
    fun `uncached image requires materialization`() {
        val prompt = Prompt(
            listOf(
                PromptPart.Image(
                    path = "/tmp/image.png",
                    name = "image.png",
                    mimeType = "image/png",
                ),
            ),
        )

        assertTrue(prompt.requiresMaterialization)
    }

    @Test
    fun `cached image does not require materialization`() {
        val prompt = Prompt(
            listOf(
                PromptPart.Image(
                    path = "/does/not/exist.png",
                    name = "prepared.png",
                    mimeType = "image/jpeg",
                    initialBase64Content = "AQID",
                ),
            ),
        )

        assertFalse(prompt.requiresMaterialization)
    }
}
