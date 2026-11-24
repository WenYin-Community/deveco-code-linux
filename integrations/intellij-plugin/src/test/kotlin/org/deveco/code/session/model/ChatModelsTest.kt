package org.deveco.code.session.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

internal class ChatModelsTest {

    // CommandKindInference

    @Test
    fun `explicit sources win over the command name`() {
        assertEquals(CommandKind.SKILL, CommandKindInference.infer("compact", "skill"))
        assertEquals(CommandKind.MCP, CommandKindInference.infer("compact", "mcp"))
        assertEquals(CommandKind.SKILL, CommandKindInference.infer("anything", "SKILL"))
        assertEquals(CommandKind.MCP, CommandKindInference.infer("anything", "Mcp"))
    }

    @Test
    fun `any other explicit source is a plain command`() {
        assertEquals(CommandKind.COMMAND, CommandKindInference.infer("foo", "builtin"))
    }

    @Test
    fun `bundled deveco skills are skills even without a source`() {
        assertEquals(CommandKind.SKILL, CommandKindInference.infer("customize-deveco"))
        assertEquals(CommandKind.SKILL, CommandKindInference.infer("deveco-cli"))
    }

    @Test
    fun `an unknown name without a source is a command`() {
        assertEquals(CommandKind.COMMAND, CommandKindInference.infer("compact"))
    }

    // AttachmentItem

    private fun attachment(name: String = "a.png", path: String = "/tmp/a.png") = AttachmentItem(
        name = name,
        path = path,
        mimeType = "image/png",
        isImage = true,
        thumbnail = byteArrayOf(1, 2, 3),
        originalBytes = byteArrayOf(4, 5, 6),
    )

    @Test
    fun `attachment equality is structural across byte payloads`() {
        val a = attachment()

        assertEquals(a, attachment())
        assertEquals(a.hashCode(), attachment().hashCode())
        assertTrue(listOf(a).contains(attachment()))
    }

    @Test
    fun `attachment equality ignores the derived optimized send cache`() {
        val a = attachment()
        val cached = a.copy(optimizedBytes = byteArrayOf(9), optimizedMime = "image/jpeg")

        assertEquals(a, cached)
        assertEquals(cached, a)
    }

    @Test
    fun `attachment equality distinguishes the identity fields`() {
        val a = attachment()

        assertNotEquals(a, attachment(name = "b.png"))
        assertNotEquals(a, attachment(path = "/tmp/b.png"))
        assertNotEquals(a, a.copy(mimeType = "image/jpeg"))
        assertNotEquals(a, a.copy(isImage = false))
    }

    @Test
    fun `attachments with different byte payloads are not equal`() {
        val a = AttachmentItem("a.png", "/tmp/a.png", "image/png", true, byteArrayOf(1), byteArrayOf(2))
        val b = AttachmentItem("a.png", "/tmp/a.png", "image/png", true, byteArrayOf(9), byteArrayOf(2))

        assertNotEquals(a, b)
    }

    @Test
    fun `a payload-bearing item tolerates a payload-less peer, not the other way round`() {
        val bare = AttachmentItem("a.png", "/tmp/a.png", "image/png", true)
        val rich = AttachmentItem("a.png", "/tmp/a.png", "image/png", true, byteArrayOf(1), byteArrayOf(2))

        // Documented current contract: the byte comparisons are
        // `other.x?.contentEquals(this.x ?: empty) != false`, so a NULL payload on the
        // other side never disproves equality while differing bytes do — asymmetric by
        // construction. If this test fails, equality was made symmetric; update it.
        assertTrue(rich.equals(bare))
        assertFalse(bare.equals(rich))
    }

    // CommandChoice / PermissionMode / ChatItem defaults

    @Test
    fun `command choices default to plain commands`() {
        val choice = CommandChoice("name", "description")

        assertEquals(CommandKind.COMMAND, choice.kind)
        assertFalse(choice.subtask)
    }

    @Test
    fun `permission modes keep their stable wire ids`() {
        assertEquals("recommended", PermissionMode.RECOMMENDED.id)
        assertEquals("sandbox", PermissionMode.SANDBOX.id)
        assertEquals("auto", PermissionMode.AUTO.id)
    }

    @Test
    fun `chat items are complete and visible unless stated otherwise`() {
        val item = ChatItem("id", ChatRole.AGENT, "Agent", "text")

        assertTrue(item.isComplete)
        assertFalse(item.interrupted)
        assertFalse(item.internalOnly)
        assertFalse(item.turnBoundary)
        assertFalse(item.compactionDivider)
        assertFalse(item.backgroundMerged)
        assertEquals(0L, item.duration)
        assertEquals(0L, item.completedAt)
        assertEquals(emptyList<AttachmentItem>(), item.attachments)
        assertEquals(emptyList<FileReference>(), item.fileReferences)
    }

    @Test
    fun `model and mode choices stay usable as labeled choices`() {
        val model: LabeledChoice = ModelChoice("provider/model", "Pretty", "provider", "model")
        val mode: LabeledChoice = ModeChoice("build", "Build")

        assertEquals("provider/model", model.id)
        assertEquals("Pretty", model.name)
        assertEquals("build", mode.id)
        assertEquals("Build", mode.name)
    }

    @Test
    fun `a fresh elicitation starts with empty draft state`() {
        val item = ElicitationItem("title", emptyList(), {})

        assertTrue(item.selections.isEmpty())
        assertTrue(item.customAnswers.isEmpty())
    }
}
