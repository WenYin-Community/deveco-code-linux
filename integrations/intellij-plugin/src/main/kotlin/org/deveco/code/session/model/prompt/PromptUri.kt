package org.deveco.code.session.model.prompt

import java.net.URI
import java.nio.file.Path
import java.nio.file.Paths

internal fun pathToPromptUri(path: String, range: IntRange? = null): String {
    val parsed = runCatching { URI(path) }.getOrNull()
    val base = if (parsed != null && parsed.scheme.equals("file", ignoreCase = true)) {
        Paths.get(URI(parsed.scheme, parsed.authority, parsed.path, null, null)).toUri().toString()
    } else if (path.contains("://")) {
        val parsed = URI(path)
        URI(parsed.scheme, parsed.authority, parsed.path, parsed.query, null).toASCIIString()
    } else if (isWindowsPath(path)) {
        URI("file", "", "/${path.replace('\\', '/')}", null).toASCIIString()
    } else {
        Path.of(path).toUri().toString()
    }
    val fragment = range?.let(::formatPromptRange) ?: return base
    return "$base#$fragment"
}

internal fun promptUriToPath(uri: String): String {
    val parsed = runCatching { URI(uri) }.getOrNull() ?: return uri
    if (parsed.scheme.equals("file", ignoreCase = true)) {
        if (isWindowsFileUriPath(parsed.path.orEmpty())) {
            return parsed.path.removePrefix("/").replace('/', '\\')
        }
        return runCatching {
            Paths.get(
                URI(parsed.scheme, parsed.authority, parsed.path, parsed.query, null),
            ).toString()
        }.getOrDefault(parsed.path.orEmpty())
    }
    return parsed.path.orEmpty()
}

internal fun promptLineRange(uri: String): IntRange? {
    val fragment = runCatching { URI(uri).fragment }
        .getOrNull()
        ?.takeIf { it.isNotBlank() }
        ?: return null
    if (!fragment.startsWith("L", ignoreCase = true)) return null

    val body = fragment.substring(1)
    val separator = body.indexOf('-')
    val startPart = if (separator >= 0) body.substring(0, separator) else body
    val endPart = if (separator >= 0) body.substring(separator + 1) else null
    val start = parsePromptLineNumber(startPart) ?: return null
    val end = if (endPart == null) start else parsePromptLineNumber(endPart) ?: return null
    return (start..end).takeIf { end >= start }
}

private fun formatPromptRange(range: IntRange): String = if (range.first == range.last) {
    "L${range.first}"
} else {
    "L${range.first}-L${range.last}"
}

private fun parsePromptLineNumber(raw: String): Int? {
    val withoutPrefix = if (raw.startsWith("L", ignoreCase = true)) raw.substring(1) else raw
    val column = withoutPrefix.indexOfFirst { it == 'C' || it == 'c' }
    val linePart = if (column >= 0) withoutPrefix.substring(0, column) else withoutPrefix
    if (linePart.isEmpty() || !linePart.all(Char::isDigit)) return null
    return linePart.toIntOrNull()?.takeIf { it > 0 }
}

private fun isWindowsPath(path: String): Boolean =
    path.length >= 3 && path[0].isLetter() && path[1] == ':' && (path[2] == '/' || path[2] == '\\')

private fun isWindowsFileUriPath(path: String): Boolean =
    path.length >= 4 && path[0] == '/' && path[1].isLetter() && path[2] == ':' && path[3] == '/'
