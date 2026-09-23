package org.deveco.code.acp

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

internal data class ReadRange(val offset: Int?, val limit: Int?)

internal data class LineDiff(val added: Int, val removed: Int) {
    fun isEmpty(): Boolean = added == 0 && removed == 0
    fun format(): String = buildString {
        if (added > 0) append("+").append(added)
        if (removed > 0) {
            if (isNotEmpty()) append(" ")
            append("-").append(removed)
        }
    }
}

internal object AcpToolInputParser {
    private val PATH_TAG_REGEX = Regex("<path>([^<]+)</path>")

    /**
     * Tries to compute line diff stats for an in-place file-edit tool call.
     *
     * We can only do this when the agent passes explicit before/after strings as
     * tool parameters. The heuristic probes a number of well-known key pairs used
     * by OpenCode-style agents (old_text/new_text, before/after,
     * oldString/newString, …). If no pair is present the result is
     * `LineDiff(0, 0)` and the caller should not render a +/- badge.
     */
    fun computeLineDiff(rawInput: Any?): LineDiff? {
        val values = when (rawInput) {
            is JsonObject -> rawInput
            is Map<*, *> -> rawInput
            else -> return null
        }
        val pairs = listOf(
            Triple("old_text", "new_text", null),
            Triple("before", "after", null),
            Triple("old_string", "new_string", null),
            Triple("oldString", "newString", null),
            Triple("previous", "next", null),
            Triple("old", "new", null),
            // write_file / create_file / whole_file_edit: just content → all added
            Triple(null, "content", "WRITE"),
            Triple(null, "text", "WRITE"),
            Triple(null, "file_text", "WRITE"),
        )
        for ((oldKey, newKey, mode) in pairs) {
            val oldStr = if (oldKey != null) values.asString(oldKey) else ""
            val newStr = values.asString(newKey) ?: continue
            if (oldKey != null && oldStr == null) continue
            if (mode == "WRITE") {
                val added = countLines(newStr)
                if (added > 0) return LineDiff(added, 0)
            }
            val removed = if (oldKey != null && oldStr != null) countLines(oldStr) else 0
            val added = countLines(newStr)
            if (removed > 0 || added > 0) return LineDiff(added, removed)
        }
        return null
    }

    private fun countLines(s: String): Int {
        if (s.isEmpty()) return 0
        // Treat a trailing newline as NOT creating an extra empty line, to match
        // git-style line counts.
        val trimmed = if (s.endsWith('\n') || s.endsWith("\r\n")) s.dropLastWhile { it == '\n' || it == '\r' } else s
        if (trimmed.isEmpty()) return 0
        return trimmed.lineSequence().count()
    }

    private fun Any?.string(name: String): String? = when (
        val value = if (this is JsonObject) {
            this[name]
        } else if (this is Map<*, *>) {
            this[name]
        } else {
            null
        }
    ) {
        is String -> value.takeIf { it.isNotBlank() }
        is JsonPrimitive -> value.contentOrNull?.takeIf { it.isNotBlank() }
        else -> null
    }

    private fun Any?.asString(name: String): String? = this.string(name)

    fun readRange(rawInput: Any?): ReadRange? {
        if (rawInput is JsonObject) {
            val offset = rawInput["offset"]?.jsonPrimitive?.intOrNull?.takeIf { it >= 0 }
            val limit = rawInput["limit"]?.jsonPrimitive?.intOrNull?.takeIf { it > 0 }
            return if (offset != null || limit != null) ReadRange(offset, limit) else null
        }
        val values = rawInput as? Map<*, *> ?: return null

        fun number(name: String): Int? = when (val value = values[name]) {
            is Number -> value.toInt()
            is String -> value.toIntOrNull()
            else -> null
        }

        val offset = number("offset")?.takeIf { it >= 0 }
        val limit = number("limit")?.takeIf { it > 0 }
        return if (offset != null || limit != null) ReadRange(offset, limit) else null
    }

    /**
     * Extracts the file path from a tool call's raw input.
     *
     * The path may be either an absolute path or a path relative to the project.
     * Well-known keys used by OpenCode-style agents are tried in order.
     */
    fun readPath(rawInput: Any?): String? {
        val values = when (rawInput) {
            is JsonObject -> rawInput
            is Map<*, *> -> rawInput
            else -> return null
        }

        fun string(name: String): String? = when (val value = values[name]) {
            is String -> value.takeIf { it.isNotBlank() }
            is JsonPrimitive -> value.contentOrNull?.takeIf { it.isNotBlank() }
            else -> null
        }

        return string("file_path") ?: string("filePath") ?: string("path") ?: string("file")
    }

    /**
     * Extracts the file path from a tool call's raw output.
     *
     * Prefers the absolute path reported in `metadata.display.path`, falling back
     * to the `<path>...</path>` element embedded in the rendered output text.
     */
    fun readOutputPath(rawOutput: Any?): String? {
        val displayPath = rawOutput
            .field("metadata")
            .field("display")
            .field("path")
            ?.asString()
        if (displayPath != null) return displayPath

        val outputText = rawOutput.field("output")?.asString() ?: return null
        return PATH_TAG_REGEX.find(outputText)?.groupValues?.getOrNull(1)
            ?.takeIf { it.isNotBlank() }
    }

    private fun Any?.field(name: String): Any? = when (this) {
        is JsonObject -> this[name]
        is Map<*, *> -> this[name]
        else -> null
    }

    private fun Any?.asString(): String? = when (this) {
        is String -> this.takeIf { it.isNotBlank() }
        is JsonPrimitive -> contentOrNull?.takeIf { it.isNotBlank() }
        else -> null
    }
}
