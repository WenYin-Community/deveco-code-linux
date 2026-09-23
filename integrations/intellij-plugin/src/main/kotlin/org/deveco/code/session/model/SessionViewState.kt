package org.deveco.code.session.model

internal data class FileReference(val path: String, val startLine: Int, val endLine: Int) {
    val fileName: String get() = path.substringAfterLast('/')
    val hasLineRange: Boolean get() = startLine > 0 && endLine > 0
    val lineRange: String get() = if (startLine == endLine) "$startLine" else "$startLine-$endLine"
}

internal data class SessionViewState(
    val anchorMessageId: String?,
    val firstVisibleItemIndex: Int,
    val firstVisibleItemOffset: Int,
    val followTail: Boolean,
    val expandedThoughts: Map<String, Boolean>,
    val expandedTools: Map<String, Boolean>,
    val previewFilePath: String?,
    val previewLine: Int?,
    val previewOffset: Int?,
    val previewLimit: Int?,
    val previewProportion: Float,
    val draft: String = "",
    val fileReferences: List<FileReference> = emptyList(),
)

internal data class SessionViewportState(
    val anchorMessageId: String?,
    val firstVisibleItemIndex: Int,
    val firstVisibleItemOffset: Int,
    val followTail: Boolean,
)
