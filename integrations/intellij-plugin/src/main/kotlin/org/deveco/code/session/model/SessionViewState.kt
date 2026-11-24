package org.deveco.code.session.model

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
    val attachments: List<AttachmentItem> = emptyList(),
    // Last model explicitly picked in this session (qualified
    // "providerId/modelId"). Memory-only, same lifetime as the draft: it
    // survives controller disposal within the IDE process and restores the
    // pick on reload — the backend recomputes a zero-message session's model
    // back to its default, losing a selection that was never exercised by a
    // prompt.
    val selectedModelId: String? = null,
) {
    companion object {
        fun initial() = SessionViewState(
            anchorMessageId = null,
            firstVisibleItemIndex = 0,
            firstVisibleItemOffset = 0,
            followTail = true,
            expandedThoughts = emptyMap(),
            expandedTools = emptyMap(),
            previewFilePath = null,
            previewLine = null,
            previewOffset = null,
            previewLimit = null,
            previewProportion = 0f,
        )
    }
}

internal data class SessionViewportState(
    val anchorMessageId: String?,
    val firstVisibleItemIndex: Int,
    val firstVisibleItemOffset: Int,
    val followTail: Boolean,
)
