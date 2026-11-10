package org.deveco.code.session.ui.messages

/** One `  Line N: <text>` entry under a grep file header. */
internal data class SearchMatch(val line: Int, val text: String)

/** One grep file section: the verbatim `<path>:` header plus its match lines. */
internal data class SearchSection(val path: String, val matches: List<SearchMatch>)

/** Parsed grep output: per-file sections plus the optional truncation notice. */
internal data class SearchSections(val sections: List<SearchSection>, val note: String?)

/**
 * Parses file paths from tool output text.
 *
 * Tool output for file search results typically contains one file path per line.
 * This parser extracts valid file paths, filtering out empty lines and non-file content.
 */
internal object FileTreeParser {

    /**
     * Parses file paths from tool output text.
     * Returns a list of file paths, one per line.
     *
     * Handles tree-drawing characters (├──, └──, │, ─) produced by tools
     * like list_directory_tree, as well as markdown list markers (-, *).
     */
    fun parseFilePaths(text: String): List<String> {
        return text.lines()
            .map { stripTreePrefix(it) }
            .map { it.trim() }
            .filter { it.isNotBlank() && isFilePath(it) }
    }

    /**
     * Parses grep-style search output into per-file sections so the UI can show each
     * `<path>:` header with its `  Line N: <text>` match lines instead of dropping them.
     * Headers are kept verbatim (same contract as [parseFilePaths]); lines that belong to
     * no section and are not the truncation notice are ignored.
     */
    fun parseSearchSections(text: String): SearchSections {
        val sections = mutableListOf<SearchSection>()
        var matches: MutableList<SearchMatch>? = null
        var note: String? = null
        for (raw in text.lines()) {
            val line = stripTreePrefix(raw).trim()
            if (line.isBlank()) continue
            if (line.startsWith("(Results truncated")) {
                note = line
                continue
            }
            val matchLine = MATCH_LINE_REGEX.find(line)
            if (matchLine != null && matches != null) {
                matches.add(SearchMatch(matchLine.groupValues[1].toInt(), matchLine.groupValues[2]))
                continue
            }
            if (isFilePath(line)) {
                matches = mutableListOf<SearchMatch>().also { sections.add(SearchSection(line, it)) }
            }
        }
        return SearchSections(sections, note)
    }

    private val MATCH_LINE_REGEX = Regex("^Line (\\d+): (.*)$")

    /**
     * Strips tree-drawing characters, markdown list markers, and descriptive
     * tool-output prefixes (e.g. "read: 3 files ", "wrote: 1 file ") from a line
     * so that only the file path remains.
     */
    private fun stripTreePrefix(line: String): String {
        var result = line
        // Remove tree-drawing characters: ├──, └──, │, ─, ┌, ┐, └, ┘
        result = result.replace(Regex("^[│├└┌┐┘─]*[─]*\\s*"), "")
        // Remove markdown list markers: - , * , + , digits.
        result = result.replace(Regex("^[-*+]\\s+"), "")
        result = result.replace(Regex("^\\d+\\.\\s+"), "")
        // Remove descriptive tool-output prefixes like "read: 3 files ", "wrote: 1 file ",
        // "edited: 2 files ", "deleted: 1 file ", etc.
        result = result.replace(Regex("^(read|wrote|edited|deleted|created|moved|renamed|searched|found):\\s+\\d+\\s+files?\\s+", RegexOption.IGNORE_CASE), "")
        return result
    }

    /**
     * Checks if a string looks like a file path.
     * Valid file paths contain at least one path separator or file extension.
     * Rejects task descriptions that contain Chinese characters (e.g., "创建 HomeView.ets 支付宝首页").
     * Rejects log messages with colons (except Windows drive letters), brackets, and other non-path patterns.
     *
     * grep-style search output terminates each file header with a ":" separator and rows are
     * displayed verbatim, so the check runs on the colon-stripped form; the separator itself is
     * removed only where a [java.nio.file.Path] is constructed. On POSIX the trailing colon can
     * also be part of a real file name, which then shows up as a double colon here.
     */
    internal fun isFilePath(text: String): Boolean {
        val path = text.trimEnd(':')
        val hasSeparator = path.contains('/') || path.contains('\\')
        val hasExtension = path.contains('.') && !path.startsWith('.')

        // Check for colon not part of Windows drive letter (e.g., "C:/")
        val hasColonNotInDrive = path.indexOf(':').let { idx ->
            idx >= 0 && !(idx == 1 && path.length > 2 && path[idx - 1].isLetter() &&
                (path.getOrNull(idx + 1) == '/' || path.getOrNull(idx + 1) == '\\'))
        }

        // Reject descriptive text: contains spaces but doesn't look like a path
        // Pure file paths don't contain spaces (unless quoted), and start with /, \, letter:, or "
        val hasSpaces = path.contains(' ')
        val startsWithPath = path.startsWith('/') || path.startsWith('\\') ||
            path.matches(Regex("^[A-Za-z]:[/\\\\]")) || path.startsWith("\"") || path.startsWith("'")
        val isDescriptiveText = hasSpaces && !startsWithPath

        val isNotFile = path.startsWith("#") ||
            path.startsWith("//") ||
            path.startsWith("/*") ||
            path.contains("error", ignoreCase = true) && path.contains(":") ||
            path.any { it in '一'..'龥' } ||
            path.contains('[') || path.contains(']') ||
            hasColonNotInDrive ||
            path.endsWith("...") ||
            path.contains("@") ||
            path.contains("(") ||
            path.contains("{") ||
            path.contains("}") ||
            path.contains("'") ||
            path.contains("\"") ||
            path.contains("=") ||
            // Reject lines with tree-drawing characters (├──, └──, │, ─)
            path.any { it.code in 0x2500..0x257F } ||
            // Reject descriptive text (e.g., "Update build-profile.json5 to API 26")
            isDescriptiveText ||
            Regex("\\b\\w+\\s+in\\s+\\w+").containsMatchIn(path)

        return (hasSeparator || hasExtension) && !isNotFile
    }

    /**
     * Extracts the file name from a file path.
     */
    fun getFileName(filePath: String): String {
        return filePath.substringAfterLast('/').substringAfterLast('\\')
    }

    /**
     * Extracts the directory path from a file path.
     */
    fun getDirectoryPath(filePath: String): String {
        val lastSlash = filePath.lastIndexOf('/')
        val lastBackslash = filePath.lastIndexOf('\\')
        val lastSeparator = maxOf(lastSlash, lastBackslash)
        return if (lastSeparator >= 0) filePath.substring(0, lastSeparator) else ""
    }

    /**
     * Gets the file extension from a file path.
     */
    fun getFileExtension(filePath: String): String {
        val fileName = getFileName(filePath)
        val dotIndex = fileName.lastIndexOf('.')
        return if (dotIndex >= 0) fileName.substring(dotIndex + 1).lowercase() else ""
    }

    /**
     * Checks if a path is likely a directory rather than a file.
     * Returns true when the path ends with a separator or has no file extension
     * after the last path component (common for directory-level tool paths).
     */
    fun isDirectoryPath(path: String): Boolean {
        if (path.isBlank()) return false
        // Ends with separator → definitely a directory
        if (path.endsWith('/') || path.endsWith('\\')) return true
        // No extension in the last path component → likely a directory
        val name = getFileName(path)
        return !name.contains('.')
    }

    /**
     * Normalizes a file path for display: converts to forward slashes,
     * strips drive letters, and extracts relative path from project root.
     */
    fun normalizePath(filePath: String): String {
        var normalized = filePath.replace('\\', '/')

        if (normalized.matches(Regex("^[A-Za-z]:/.*"))) {
            normalized = normalized.substringAfter(":/")
        }

        val projectDirs = listOf("entry/", "AppScope/", "oh_modules/", "hvigor/")
        for (dir in projectDirs) {
            val idx = normalized.indexOf(dir)
            if (idx > 0) {
                return normalized.substring(idx)
            }
        }

        return normalized
    }
}
