package org.deveco.code.migration

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper

/**
 * Source-config parser: strict JSON first, then JSONC (line + block comments)
 * preprocessing, then fail as a file-level error (functional-design §6).
 *
 * Source files were written by the old CodeGenie CLI, so the comment formats
 * are limited; trailing commas are tolerated because old writers emitted them.
 */
object JsoncParser {

    class JsoncParseException(message: String) : Exception(message)

    private val MAPPER = ObjectMapper()

    fun parse(text: String): JsonNode {
        strictJson(text)?.let { return it }
        strippedJsonc(text)?.let { return it }
        throw JsoncParseException("Not parseable as JSON or JSONC")
    }

    fun readFile(path: java.nio.file.Path): JsonNode = parse(java.nio.file.Files.readString(path))

    private fun strictJson(text: String): JsonNode? = try {
        MAPPER.readTree(text)
    } catch (_: Exception) {
        null
    }

    private fun strippedJsonc(text: String): JsonNode? = try {
        // Comments FIRST, then trailing commas (review P3-4): stripping commas
        // first flushes the pending comma back when it hits '/', so
        // `{"a":1, // note\n}` ended up as `{"a":1, }` after comment removal —
        // unparseable, and the target mcp section would read as absent.
        MAPPER.readTree(stripTrailingCommas(stripComments(text)))
    } catch (_: Exception) {
        null
    }

    internal fun stripComments(source: String): String {
        val sb = StringBuilder(source.length)
        var inString = false
        var escaped = false
        var i = 0
        while (i < source.length) {
            val c = source[i]
            if (inString) {
                sb.append(c)
                when {
                    escaped -> escaped = false
                    c == '\\' -> escaped = true
                    c == '"' -> inString = false
                }
                i++
                continue
            }
            when {
                c == '"' -> {
                    inString = true
                    sb.append(c)
                    i++
                }

                c == '/' && i + 1 < source.length && source[i + 1] == '/' ->
                    while (i < source.length && source[i] != '\n') i++

                c == '/' && i + 1 < source.length && source[i + 1] == '*' -> {
                    i += 2
                    while (i + 1 < source.length && !(source[i] == '*' && source[i + 1] == '/')) i++
                    i = (i + 2).coerceAtMost(source.length)
                }

                else -> {
                    sb.append(c)
                    i++
                }
            }
        }
        return sb.toString()
    }

    internal fun stripTrailingCommas(source: String): String {
        val sb = StringBuilder(source.length)
        var inString = false
        var escaped = false
        val pending = StringBuilder()
        var i = 0
        while (i < source.length) {
            val c = source[i]
            if (inString) {
                sb.append(pending)
                pending.setLength(0)
                sb.append(c)
                when {
                    escaped -> escaped = false
                    c == '\\' -> escaped = true
                    c == '"' -> inString = false
                }
                i++
                continue
            }
            when {
                c == '"' -> {
                    sb.append(pending)
                    pending.setLength(0)
                    inString = true
                    sb.append(c)
                    i++
                }

                c == ',' -> {
                    pending.append(c)
                    i++
                }

                c.isWhitespace() && pending.isNotEmpty() -> {
                    pending.append(c)
                    i++
                }

                else -> {
                    if (pending.isNotEmpty() && (c == '}' || c == ']')) pending.setLength(0)
                    sb.append(pending)
                    pending.setLength(0)
                    sb.append(c)
                    i++
                }
            }
        }
        sb.append(pending)
        return sb.toString()
    }
}
