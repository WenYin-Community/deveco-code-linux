package org.deveco.code.session.model

internal data class FileReference(
    val path: String,
    val startLine: Int,
    val endLine: Int,
    /** Snapshot of the editor document at add time; never re-read from disk. */
    val selectedText: String? = null,
) {
    val fileName: String get() = path.substringAfterLast('/')
    val hasLineRange: Boolean get() = startLine > 0 && endLine > 0
    val lineRange: String get() = if (startLine == endLine) "$startLine" else "$startLine-$endLine"

    /** Prompt line numbers are 1-based; editor navigation uses 0-based indexes. */
    val openLineIndex: Int get() = if (hasLineRange) startLine - 1 else 0
}
