package org.deveco.code.session.model.prompt

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Path

internal class PromptUriTest {
    @Test
    fun `single line and range fragments round trip`() {
        val path = Path.of("/tmp/project/Main.kt")

        assertEquals(
            10..10,
            promptLineRange(pathToPromptUri(path.toString(), 10..10)),
        )
        assertEquals(
            10..20,
            promptLineRange(pathToPromptUri(path.toString(), 10..20)),
        )
        assertNull(promptLineRange(pathToPromptUri(path.toString())))
    }

    @Test
    fun `invalid fragments do not produce a range`() {
        assertNull(promptLineRange("file:///tmp/Main.kt#invalid"))
        assertNull(promptLineRange("file:///tmp/Main.kt#L20-L10"))
        assertNull(promptLineRange("file:///tmp/Main.kt#L0"))
        assertNull(promptLineRange("file:///tmp/Main.kt#Lfoo"))
        assertNull(promptLineRange("file:///tmp/Main.kt#L10-"))
    }

    @Test
    fun `spaces and literal hash in filename are encoded and path round trips`() {
        val path = Path.of("/tmp/project/file #name.kt").toAbsolutePath()

        val uri = pathToPromptUri(path.toString(), 2..4)

        assertEquals("L2-L4", java.net.URI(uri).rawFragment)
        assertTrue(java.net.URI(uri).rawPath.contains("%23"))
        assertEquals(path.toString(), promptUriToPath(uri))
    }

    @Test
    fun `column-aware fragments parse their line range`() {
        assertEquals(
            10..20,
            promptLineRange("file:///tmp/Main.kt#L10C3-L20C8"),
        )
    }

    @Test
    fun `windows paths become file URIs and round trip`() {
        val path = """C:\project\Main.kt"""
        val uri = pathToPromptUri(path, 10..20)

        assertEquals("file:///C:/project/Main.kt#L10-L20", uri)
        assertEquals(10..20, promptLineRange(uri))
        assertEquals(path, promptUriToPath(uri))
    }

    @Test
    fun `file URIs use the canonical triple slash form`() {
        assertEquals(
            "file:///tmp/project/Main.kt#L10-L20",
            pathToPromptUri("file:/tmp/project/Main.kt", 10..20),
        )
    }

    @Test
    fun `uri prompt parts expose the parsed line range`() {
        val resource = PromptPart.Resource.Text(
            uri = "file:///tmp/Main.kt#L10-L20",
            text = "code",
        )
        val link = PromptPart.ResourceLink(
            uri = "file:///tmp/Main.kt#L10C3-L20C8",
            name = "Main.kt",
        )

        assertEquals(10..20, resource.lineRange)
        assertEquals(10..20, link.lineRange)
    }
}
