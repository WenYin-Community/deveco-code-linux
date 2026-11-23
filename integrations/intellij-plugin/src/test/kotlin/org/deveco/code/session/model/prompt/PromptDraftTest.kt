package org.deveco.code.session.model.prompt

import org.deveco.code.session.model.FileReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

internal class PromptDraftTest {
    @Test
    fun `file attachment and file reference use the same context part`() {
        val draft = PromptDraft()
        val reference = FileReference("/tmp/Main.kt", 1, 3, "selected")

        draft.addImageAttachment("/tmp/first.png", "first.png", "image/png")
        draft.addFileAttachment("/tmp/second.txt", "second.txt")
        draft.removeAttachmentAt(0)
        draft.addFileReference(reference)

        assertTrue(draft.attachments.isEmpty())
        assertEquals(
            listOf("/tmp/second.txt", "/tmp/Main.kt"),
            draft.fileReferences.map { it.path },
        )
        assertTrue(draft.parts.all { it is PromptPart.ResourceLink || it is PromptPart.Resource })
        assertEquals(2, draft.parts.size)

        draft.clearFileReferences()
        assertTrue(draft.fileReferences.isEmpty())
    }

    @Test
    fun `restore preserves context part order and part types`() {
        val source = PromptDraft().apply {
            text = "restored"
            addFileAttachment("/tmp/one.txt", "one.txt")
            addEditorSelection("/tmp/Selected.kt", 2, 5, "unsaved")
            addFileMention("src/Main.kt")
            addImageAttachment("/tmp/two.png", "two.png", "image/png")
        }
        val prompt = source.snapshot()
        val draft = PromptDraft()

        draft.restore(prompt)

        assertEquals("restored", draft.text)
        assertEquals(prompt.contextParts, draft.parts.toList())
        assertEquals(
            listOf("ResourceLink", "Text", "ResourceLink", "Image"),
            draft.parts.map { it::class.simpleName },
        )
        val selection = draft.parts.filterIsInstance<PromptPart.Resource.Text>().single()
        assertEquals("unsaved", selection.text)
        assertEquals("L2-L5", java.net.URI(selection.uri).rawFragment)
    }

    @Test
    fun `restore derives file references directly from submitted parts`() {
        val source = PromptDraft().apply {
            addFileAttachment("/tmp/notes.txt", "notes.txt")
            addFileMention("src/Main.kt")
        }
        val draft = PromptDraft()

        draft.restore(source.snapshot())

        assertTrue(draft.attachments.isEmpty())
        assertEquals(listOf("notes.txt", "Main.kt"), draft.fileReferences.map { it.fileName })
    }

    @Test
    fun `snapshot captures one complete draft without reading disk`() {
        val draft = PromptDraft().apply {
            text = "/review\n\nreview"
            addEditorSelection("src/Main.kt", 2, 4, "unsaved editor text")
            addFileAttachment("/tmp/notes.txt", "notes.txt")
        }

        val prompt = draft.snapshot()

        assertEquals("/review\n\nreview", prompt.text)
        assertEquals(listOf("/review\n\nreview"), prompt.parts.filterIsInstance<PromptPart.Text>().map { it.text })
        assertEquals(listOf("Main.kt", "notes.txt"), draft.fileReferences.map { it.fileName })
        val selection = prompt.parts.filterIsInstance<PromptPart.Resource.Text>().single()
        assertEquals("unsaved editor text", selection.text)
        assertTrue(prompt.parts.any { it is PromptPart.ResourceLink })
    }

    @Test
    fun `prepared image base64 is retained in the canonical prompt part`() {
        val draft = PromptDraft()
        val image = draft.addImageAttachment("/tmp/prepared.png", "prepared.png", "image/png")

        assertEquals(null, image.cachedBase64Content)
        draft.updateImageThumbnail("/tmp/prepared.png", byteArrayOf(1))
        image.seedBase64Content("AQID", "image/jpeg")

        val draftImage = draft.attachments.single() as PromptPart.Image
        val snapshotImage = draft.snapshot().attachmentParts.single() as PromptPart.Image
        assertEquals("AQID", draftImage.cachedBase64Content)
        assertEquals("AQID", snapshotImage.cachedBase64Content)
        assertTrue(draft.hasAttachments)
        assertEquals("image/jpeg", draftImage.mimeTypeForSend)
        assertTrue(draft.attachmentThumbnail("/tmp/prepared.png")!!.contentEquals(byteArrayOf(1)))
    }

    @Test
    fun `image attachment never becomes a file reference`() {
        val draft = PromptDraft().apply {
            addImageAttachment("/tmp/startIcon.png", "startIcon.png", "image/png")
        }

        assertTrue(draft.parts.single() is PromptPart.Image)
        assertTrue(draft.attachments.single() is PromptPart.Image)
        assertTrue(draft.fileReferences.isEmpty())
    }

    @Test
    fun `failed image attachment can be removed by path`() {
        val draft = PromptDraft().apply {
            addImageAttachment("/tmp/failed.png", "failed.png", "image/png")
        }

        assertTrue(draft.removeAttachmentByPath("/tmp/failed.png"))
        assertTrue(draft.attachments.isEmpty())
        assertFalse(draft.hasAttachments)
        assertFalse(draft.removeAttachmentByPath("/tmp/failed.png"))
    }

    @Test
    fun `attachment parts distinguish images resources and range references`() {
        val prompt = Prompt(
            listOf(
                PromptPart.Image("/tmp/image.png", "image.png", "image/png"),
                PromptPart.Resource.Text("file:///tmp/notes.txt", "notes"),
                PromptPart.Resource.Text("file:///tmp/Main.kt#L1-L2", "selection"),
                PromptPart.ResourceLink("file:///tmp/Other.kt", "Other.kt"),
            ),
        )

        assertEquals(2, prompt.attachmentParts.size)
        assertTrue(prompt.attachmentParts.first() is PromptPart.Image)
        assertTrue(prompt.attachmentParts.last() is PromptPart.Resource.Text)
    }
}
