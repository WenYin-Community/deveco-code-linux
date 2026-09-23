package org.deveco.code.session.ui.messages

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
     */
    internal fun isFilePath(text: String): Boolean {
        val hasSeparator = text.contains('/') || text.contains('\\')
        val hasExtension = text.contains('.') && !text.startsWith('.')

        // Check for colon not part of Windows drive letter (e.g., "C:/")
        val hasColonNotInDrive = text.indexOf(':').let { idx ->
            idx >= 0 && !(idx == 1 && text.length > 2 && text[idx - 1].isLetter() &&
                (text.getOrNull(idx + 1) == '/' || text.getOrNull(idx + 1) == '\\'))
        }

        // Reject descriptive text: contains spaces but doesn't look like a path
        // Pure file paths don't contain spaces (unless quoted), and start with /, \, letter:, or "
        val hasSpaces = text.contains(' ')
        val startsWithPath = text.startsWith('/') || text.startsWith('\\') ||
            text.matches(Regex("^[A-Za-z]:[/\\\\]")) || text.startsWith("\"") || text.startsWith("'")
        val isDescriptiveText = hasSpaces && !startsWithPath

        val isNotFile = text.startsWith("#") ||
            text.startsWith("//") ||
            text.startsWith("/*") ||
            text.contains("error", ignoreCase = true) && text.contains(":") ||
            text.any { it in '一'..'龥' } ||
            text.contains('[') || text.contains(']') ||
            hasColonNotInDrive ||
            text.endsWith("...") ||
            text.contains("@") ||
            text.contains("(") ||
            text.contains("{") ||
            text.contains("}") ||
            text.contains("'") ||
            text.contains("\"") ||
            text.contains("=") ||
            // Reject lines with tree-drawing characters (├──, └──, │, ─)
            text.any { it.code in 0x2500..0x257F } ||
            // Reject descriptive text (e.g., "Update build-profile.json5 to API 26")
            isDescriptiveText ||
            Regex("\\b\\w+\\s+in\\s+\\w+").containsMatchIn(text)

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
