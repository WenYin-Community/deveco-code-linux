package org.deveco.code.session

import com.agentclientprotocol.model.ToolCallContent
import com.agentclientprotocol.model.ToolCallLocation
import com.agentclientprotocol.model.ToolKind
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.LinkedHashMap
import java.util.concurrent.ConcurrentHashMap

/**
 * Computes reliable per-file +A/-D line counts for edit tool calls.
 *
 * Ported from DevEcoGenie's `AcpJsonRpcClient` snapshot/diff engine. Protocol
 * counts are trusted when the backend reports them (`metadata.filediff`/`files`,
 * explicit `oldText`/`newText`, or `oldString`/`newString`); otherwise the file
 * is snapshotted before the edit and re-read after completion to compute a real
 * LCS diff. Snapshotting runs on the initial/pending tool event so it still
 * covers the "always allow" path where no permission request is ever raised.
 * When a reliable count is impossible (file too large, unreadable, or moved)
 * the result is `Changed` represented as `-1`, never a fabricated number.
 */
internal class ToolEditTracker(private val sessionId: String, private val workingDirectory: String) {
    data class FileEdit(val path: String, val additions: Int, val deletions: Int)

    private data class Snapshot(val path: Path?, val displayPath: String, val text: String?)

    private val snapshots = ConcurrentHashMap<String, MutableMap<String, Snapshot>>()

    fun parseEdits(
        kind: ToolKind?,
        content: List<ToolCallContent>?,
        rawInput: Any?,
        rawOutput: Any?,
        locations: List<ToolCallLocation>?,
    ): List<FileEdit> {
        val edits = LinkedHashMap<String, IntArray>()

        parseMetadataFileEdits(rawOutput, edits)

        if (edits.isEmpty()) {
            for (block in content.orEmpty()) {
                if (block is ToolCallContent.Diff) {
                    val p = block.path.takeIf { it.isNotBlank() } ?: continue
                    mergeEdit(edits, p, diffLineCounts(block.oldText, block.newText))
                }
            }
        }

        val inputPath = firstNonBlank(
            locations?.firstOrNull()?.path,
            rawInput.str("filePath"),
            rawInput.str("filepath"),
            rawInput.str("path"),
        )
        if (edits.isEmpty() && kind == ToolKind.EDIT && inputPath != null) {
            val oldStr = rawInput.str("oldString")
            val newStr = rawInput.str("newString")
            if (oldStr != null || newStr != null) {
                mergeEdit(edits, inputPath, diffLineCounts(oldStr, newStr))
            } else if (rawInput.has("content")) {
                mergeEdit(edits, inputPath, intArrayOf(-1, -1))
            }
        }
        if (edits.isEmpty() && kind == ToolKind.EDIT) {
            parsePatchEdits(rawInput.str("patchText"), edits)
        }
        if (edits.isEmpty() && kind == ToolKind.EDIT) {
            for (loc in locations.orEmpty()) {
                val p = loc.path.takeIf { it.isNotBlank() } ?: continue
                edits.putIfAbsent(p, intArrayOf(0, 0))
            }
        }
        return edits.map { (p, c) -> FileEdit(p, c[0], c[1]) }
    }

    fun protocolCountsPrecise(rawOutput: Any?, content: List<ToolCallContent>?, rawInput: Any?): Boolean {
        val metadata = rawOutput.field("metadata")
        if (metadata.has("filediff") || metadata.has("files")) return true
        for (block in content.orEmpty()) {
            if (block is ToolCallContent.Diff && (block.oldText != null || block.newText.isNotBlank())) return true
        }
        return rawInput.has("oldString") || rawInput.has("newString") ||
            (!rawInput.str("patchText").isNullOrBlank())
    }

    fun capture(toolCallId: String, edits: List<FileEdit>) {
        if (toolCallId.isBlank() || edits.isEmpty()) return
        val key = snapshotKey(toolCallId)
        snapshots.computeIfAbsent(key) {
            ConcurrentHashMap<String, Snapshot>().apply {
                for (edit in edits) {
                    val resolved = resolvePath(edit.path)
                    put(edit.path, Snapshot(resolved, edit.path, readText(resolved)))
                }
            }
        }
    }

    /**
     * Backup snapshot taken at permission-request time, for the case where the
     * initial tool_call event did not yet carry edit paths (so [capture] missed)
     * and "always allow" later means no permission is ever raised. Idempotent:
     * a snapshot already taken at tool_call time is left untouched.
     */
    fun captureFromPermission(
        toolCallId: String,
        kind: ToolKind?,
        content: List<ToolCallContent>?,
        rawInput: Any?,
        rawOutput: Any?,
        locations: List<ToolCallLocation>?,
    ) {
        if (toolCallId.isBlank()) return
        val key = snapshotKey(toolCallId)
        if (snapshots.containsKey(key)) return
        val edits = parseEdits(kind, content, rawInput, rawOutput, locations)
        if (edits.isNotEmpty() && kind == ToolKind.EDIT) capture(toolCallId, edits)
    }

    fun resolve(toolCallId: String, parsed: List<FileEdit>, protocolPrecise: Boolean): List<FileEdit> {
        val key = snapshotKey(toolCallId)
        val snaps = snapshots.remove(key) ?: return parsed
        if (snaps.isEmpty()) return parsed
        val byPath = parsed.associateBy { it.path }.toMutableMap()
        val resolved = ArrayList<FileEdit>()
        for ((_, snap) in snaps) {
            val edit = byPath.remove(snap.displayPath)
            val current = readText(snap.path)
            val counts = if (protocolPrecise && edit != null) {
                intArrayOf(edit.additions, edit.deletions)
            } else if (snap.text == null || current == null) {
                if (edit == null) intArrayOf(-1, -1) else intArrayOf(edit.additions, edit.deletions)
            } else {
                diffLineCounts(snap.text, current)
            }
            resolved.add(FileEdit(snap.displayPath, counts[0], counts[1]))
        }
        resolved.addAll(byPath.values)
        return resolved
    }

    fun discard(toolCallId: String) {
        snapshots.remove(snapshotKey(toolCallId))
    }

    private fun snapshotKey(toolCallId: String): String = "$sessionId\u0000$toolCallId"

    private fun resolvePath(pathValue: String): Path? = try {
        var path = Path.of(pathValue)
        if (!path.isAbsolute) {
            val dir = Path.of(workingDirectory).toAbsolutePath().normalize()
            path = dir.resolve(path)
        }
        path.toAbsolutePath().normalize()
    } catch (_: Exception) {
        null
    }

    private fun readText(path: Path?): String? {
        if (path == null || Files.isDirectory(path)) return null
        return try {
            if (!Files.exists(path)) {
                ""
            } else if (Files.size(path) > MAX_SNAPSHOT_BYTES) {
                null
            } else {
                Files.readString(path, StandardCharsets.UTF_8)
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun parseMetadataFileEdits(rawOutput: Any?, edits: LinkedHashMap<String, IntArray>) {
        val metadata = rawOutput.field("metadata")
        val files = metadata.array("files")
        if (files != null) {
            for (item in files) {
                val file = item.obj() ?: continue
                val p = firstNonBlank(file.str("movePath"), file.str("filePath"), file.str("file")) ?: continue
                val additions = file.int("additions") ?: continue
                val deletions = file.int("deletions") ?: continue
                mergeEdit(edits, p, intArrayOf(additions, deletions))
            }
        }
        val fileDiff = metadata.obj("filediff")
        val diffPath = firstNonBlank(fileDiff.str("file"), fileDiff.str("filePath"))
        val additions = fileDiff.int("additions")
        val deletions = fileDiff.int("deletions")
        if (diffPath != null && additions != null && deletions != null) {
            mergeEdit(edits, diffPath, intArrayOf(additions, deletions))
        }
    }

    private fun parsePatchEdits(patchText: String?, edits: LinkedHashMap<String, IntArray>) {
        if (patchText.isNullOrBlank()) return
        var currentPath: String? = null
        for (line in patchText.split("\\R".toRegex())) {
            when {
                line.startsWith("*** Add File: ") || line.startsWith("*** Update File: ") ||
                    line.startsWith("*** Delete File: ") -> {
                    currentPath = line.substring(line.indexOf(':') + 1).trim()
                    edits.putIfAbsent(
                        currentPath!!,
                        if (line.startsWith("*** Delete File: ")) intArrayOf(-1, -1) else intArrayOf(0, 0),
                    )
                }

                currentPath != null && line.startsWith("*** Move to: ") -> {
                    val moved = line.substring(line.indexOf(':') + 1).trim()
                    val counts = edits.remove(currentPath)
                    if (counts != null) mergeEdit(edits, moved, counts)
                    currentPath = moved
                }

                currentPath != null && line.startsWith("+") && !line.startsWith("+++") ->
                    mergeEdit(edits, currentPath!!, intArrayOf(1, 0))

                currentPath != null && line.startsWith("-") && !line.startsWith("---") ->
                    mergeEdit(edits, currentPath!!, intArrayOf(0, 1))
            }
        }
    }

    private fun mergeEdit(edits: LinkedHashMap<String, IntArray>, path: String, delta: IntArray) {
        val counts = edits.computeIfAbsent(path) { intArrayOf(0, 0) }
        if (delta[0] < 0 || delta[1] < 0) {
            counts[0] = -1
            counts[1] = -1
            return
        }
        if (counts[0] < 0 || counts[1] < 0) return
        counts[0] += delta[0]
        counts[1] += delta[1]
    }

    private fun diffLineCounts(oldText: String?, newText: String?): IntArray {
        val oldLines = lines(oldText)
        val newLines = lines(newText)
        val comparisons = oldLines.size.toLong() * newLines.size.toLong()
        if (comparisons > MAX_LCS_COMPARISONS) return intArrayOf(-1, -1)
        val lengths = IntArray(newLines.size + 1)
        var diagonal = 0
        for (oldLine in oldLines) {
            for (i in 1..newLines.size) {
                val previous = lengths[i]
                lengths[i] = if (oldLine == newLines[i - 1]) {
                    diagonal + 1
                } else {
                    maxOf(lengths[i], lengths[i - 1])
                }
                diagonal = previous
            }
        }
        val common = lengths[newLines.size]
        return intArrayOf(newLines.size - common, oldLines.size - common)
    }

    private fun lines(text: String?): List<String> = if (text.isNullOrEmpty()) emptyList() else text.lines()

    private fun firstNonBlank(vararg values: String?): String? = values.firstOrNull { it != null && it.isNotBlank() }

    // --- Generic JSON / Map access over kotlinx.serialization JsonElement and Map ---

    private fun Any?.field(name: String): Any? = when (this) {
        is JsonObject -> this[name]
        is Map<*, *> -> this[name]
        else -> null
    }

    private fun Any?.has(name: String): Boolean = when (this) {
        is JsonObject -> this[name] != null
        is Map<*, *> -> this[name] != null
        else -> false
    }

    private fun Any?.str(name: String): String? = when (val value = this.field(name)) {
        is String -> value.takeIf { it.isNotBlank() }
        is JsonPrimitive -> value.contentOrNull?.takeIf { it.isNotBlank() }
        else -> null
    }

    private fun Any?.int(name: String): Int? = when (val value = this.field(name)) {
        is Number -> value.toInt()
        is JsonPrimitive -> value.intOrNull
        is String -> value.toIntOrNull()
        else -> null
    }

    private fun Any?.obj(): JsonObject? = this as? JsonObject
    private fun Any?.array(name: String): JsonArray? = this.field(name) as? JsonArray

    private fun Any?.obj(name: String): JsonObject? = this.field(name) as? JsonObject

    private fun Any?.str(): String? = when (this) {
        is String -> takeIf { it.isNotBlank() }
        is JsonPrimitive -> contentOrNull?.takeIf { it.isNotBlank() }
        else -> null
    }

    companion object {
        private const val MAX_SNAPSHOT_BYTES = 2_000_000L
        private const val MAX_LCS_COMPARISONS = 2_000_000L
    }
}
