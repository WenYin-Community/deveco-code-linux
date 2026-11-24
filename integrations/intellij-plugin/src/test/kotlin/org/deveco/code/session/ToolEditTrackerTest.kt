package org.deveco.code.session

import com.agentclientprotocol.model.ToolCallContent
import com.agentclientprotocol.model.ToolCallLocation
import com.agentclientprotocol.model.ToolKind
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.file.Files

/**
 * Unit tests for [ToolEditTracker]: protocol-reported edit counting
 * (metadata / diff blocks / oldString-newString / patch text / locations),
 * snapshot-based LCS resolution for unreported edits, and the capture /
 * resolve / discard lifecycle.
 */
class ToolEditTrackerTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun tracker(): ToolEditTracker = ToolEditTracker("sess-1", tmp.root.absolutePath)

    // --- parseEdits: protocol-reported counts ---

    @Test
    fun parseEditsPrefersMetadataFilesArray() {
        val output = buildJsonObject {
            put(
                "metadata",
                buildJsonObject {
                    put("files", Json.parseToJsonElement("""[{"filePath":"a.kt","additions":3,"deletions":2}]"""))
                },
            )
        }
        val edits = tracker().parseEdits(ToolKind.EDIT, null, null, output, null)
        assertEquals(listOf(ToolEditTracker.FileEdit("a.kt", 3, 2)), edits)
    }

    @Test
    fun parseEditsReadsMetadataFilediffObject() {
        val output = buildJsonObject {
            put(
                "metadata",
                buildJsonObject {
                    put(
                        "filediff",
                        buildJsonObject {
                            put("file", "b.kt")
                            put("additions", 5)
                            put("deletions", 1)
                        },
                    )
                },
            )
        }
        val edits = tracker().parseEdits(ToolKind.EDIT, null, null, output, null)
        assertEquals(listOf(ToolEditTracker.FileEdit("b.kt", 5, 1)), edits)
    }

    @Test
    fun parseEditsReadsDiffContentBlocks() {
        val content = listOf(
            ToolCallContent.Diff(path = "src/a.kt", newText = "one\ntwo", oldText = "one"),
        )
        val edits = tracker().parseEdits(ToolKind.EDIT, content, null, null, null)
        assertEquals(listOf(ToolEditTracker.FileEdit("src/a.kt", 1, 0)), edits)
    }

    @Test
    fun parseEditsComputesOldNewStringDeltaForEditKind() {
        val input = mapOf("filePath" to "a.kt", "oldString" to "one", "newString" to "one\ntwo\nthree")
        val edits = tracker().parseEdits(ToolKind.EDIT, null, input, null, null)
        assertEquals(listOf(ToolEditTracker.FileEdit("a.kt", 2, 0)), edits)
    }

    @Test
    fun parseEditsReportsUnknownCountForWriteContent() {
        val input = mapOf("path" to "a.kt", "content" to "generated text")
        val edits = tracker().parseEdits(ToolKind.EDIT, null, input, null, null)
        assertEquals(listOf(ToolEditTracker.FileEdit("a.kt", -1, -1)), edits)
    }

    @Test
    fun parseEditsParsesPatchTextWithAddAndDelete() {
        val patch = """
            *** Add File: new.txt
            +first line
            +second line
            *** Delete File: gone.txt
            -removed line
        """.trimIndent()
        val input = mapOf("patchText" to patch)
        val edits = tracker().parseEdits(ToolKind.EDIT, null, input, null, null)
        assertEquals(2, edits.size)
        assertEquals(ToolEditTracker.FileEdit("new.txt", 2, 0), edits.first { it.path == "new.txt" })
        assertEquals(ToolEditTracker.FileEdit("gone.txt", -1, -1), edits.first { it.path == "gone.txt" })
    }

    @Test
    fun parseEditsParsesPatchMoveTo() {
        val patch = """
            *** Update File: c.txt
            +u
            -d
            *** Move to: d.txt
            +x
        """.trimIndent()
        val input = mapOf("patchText" to patch)
        val edits = tracker().parseEdits(ToolKind.EDIT, null, input, null, null)
        assertEquals(listOf(ToolEditTracker.FileEdit("d.txt", 2, 1)), edits)
    }

    @Test
    fun parseEditsFallsBackToZeroCountLocations() {
        val locations = listOf(ToolCallLocation(path = "only-path.kt"))
        val edits = tracker().parseEdits(ToolKind.EDIT, null, null, null, locations)
        assertEquals(listOf(ToolEditTracker.FileEdit("only-path.kt", 0, 0)), edits)
    }

    @Test
    fun parseEditsWithoutAnySignalIsEmpty() {
        assertTrue(tracker().parseEdits(ToolKind.READ, null, mapOf("path" to "x.kt"), null, null).isEmpty())
        assertTrue(tracker().parseEdits(ToolKind.EDIT, null, null, null, null).isEmpty())
    }

    // --- protocolCountsPrecise ---

    @Test
    fun protocolCountsPreciseDetectsAllReliableSources() {
        val metadataOutput = mapOf("metadata" to mapOf("files" to listOf<Any>()))
        assertTrue(tracker().protocolCountsPrecise(metadataOutput, null, null))

        val diffContent = listOf(ToolCallContent.Diff(path = "a.kt", newText = "x", oldText = null))
        assertTrue(tracker().protocolCountsPrecise(null, diffContent, null))

        assertTrue(tracker().protocolCountsPrecise(null, null, mapOf("oldString" to "a")))
        assertTrue(tracker().protocolCountsPrecise(null, null, mapOf("patchText" to "*** Add File: x")))
        assertFalse(tracker().protocolCountsPrecise(null, null, mapOf("filePath" to "a.kt")))
    }

    // --- snapshot capture / resolve ---

    @Test
    fun resolveWithoutSnapshotReturnsParsedCounts() {
        val parsed = listOf(ToolEditTracker.FileEdit("a.txt", 7, 3))
        assertEquals(parsed, tracker().resolve("tc-1", parsed, false))
    }

    @Test
    fun captureThenModifyResolvesRealLineDelta() {
        val file = tmp.newFile("a.txt").toPath()
        Files.writeString(file, "one\ntwo\n")
        val tracker = tracker()
        val edits = listOf(ToolEditTracker.FileEdit(file.toString(), 0, 0))
        tracker.capture("tc-1", edits)

        Files.writeString(file, "one\ntwo\nthree\n")

        val resolved = tracker.resolve("tc-1", edits, false)
        assertEquals(1, resolved.size)
        assertEquals(1, resolved[0].additions)
        assertEquals(0, resolved[0].deletions)
    }

    @Test
    fun resolveWithProtocolPreciseTrustsParsedCountsOverDiskDiff() {
        val file = tmp.newFile("a.txt").toPath()
        Files.writeString(file, "before")
        val tracker = tracker()
        val edits = listOf(ToolEditTracker.FileEdit(file.toString(), 9, 9))
        tracker.capture("tc-1", edits)

        Files.writeString(file, "completely different content now")

        val resolved = tracker.resolve("tc-1", edits, true)
        assertEquals(9, resolved[0].additions)
        assertEquals(9, resolved[0].deletions)
    }

    @Test
    fun captureFromPermissionCreatesMissingSnapshotOnce() {
        val file = tmp.newFile("a.txt").toPath()
        Files.writeString(file, "v1")
        val tracker = tracker()
        val input = mapOf("filePath" to file.toString(), "content" to "x")
        val kind = ToolKind.EDIT

        // No snapshot yet: the permission-request capture creates one.
        tracker.captureFromPermission("tc-1", kind, null, input, null, null)

        Files.writeString(file, "v2")

        // A second call must not overwrite the first snapshot (idempotent).
        tracker.captureFromPermission("tc-1", kind, null, input, null, null)

        val resolved = tracker.resolve("tc-1", emptyList(), false)
        assertEquals(file.toString(), resolved[0].path)
        assertTrue(resolved[0].additions > 0)
    }

    @Test
    fun captureFromPermissionIgnoresNonEditTools() {
        val file = tmp.newFile("a.txt").toPath()
        val tracker = tracker()
        tracker.captureFromPermission("tc-1", ToolKind.READ, null, mapOf("filePath" to file.toString()), null, null)
        // No snapshot taken: resolve falls back to parsed.
        assertEquals(emptyList<ToolEditTracker.FileEdit>(), tracker.resolve("tc-1", emptyList(), false))
    }

    @Test
    fun discardDropsSnapshotAndFallsBackToParsed() {
        val file = tmp.newFile("a.txt").toPath()
        Files.writeString(file, "stable")
        val tracker = tracker()
        val edits = listOf(ToolEditTracker.FileEdit(file.toString(), 1, 1))
        tracker.capture("tc-1", edits)
        tracker.discard("tc-1")

        Files.writeString(file, "changed")

        assertEquals(edits, tracker.resolve("tc-1", edits, false))
    }

    @Test
    fun snapshotOfRelativePathResolvesAgainstWorkingDirectory() {
        val file = tmp.newFile("rel.txt").toPath()
        Files.writeString(file, "one")
        val tracker = tracker()
        val edits = listOf(ToolEditTracker.FileEdit("rel.txt", 0, 0))
        tracker.capture("tc-1", edits)

        Files.writeString(file, "one\ntwo")

        val resolved = tracker.resolve("tc-1", edits, false)
        assertEquals("rel.txt", resolved[0].path)
        assertEquals(1, resolved[0].additions)
    }

    @Test
    fun resolveWithUnreadableSnapshotKeepsParsedCounts() {
        val huge = tmp.newFile("huge.txt").toPath()
        Files.writeString(huge, "x".repeat(2_100_000))
        val tracker = tracker()
        val edits = listOf(ToolEditTracker.FileEdit(huge.toString(), 4, 2))
        tracker.capture("tc-1", edits)

        val resolved = tracker.resolve("tc-1", edits, false)
        assertEquals(4, resolved[0].additions)
        assertEquals(2, resolved[0].deletions)
    }
}
