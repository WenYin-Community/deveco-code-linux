package org.deveco.code.session.model.view

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/** User-controlled presentation state for one conversation. */
@Stable
internal class ConversationView(
    initialViewport: ConversationViewport = ConversationViewport(),
    initialFilePreview: FilePreview? = null,
    initialPreviewProportion: Float = 0f,
) {
    var viewport: ConversationViewport by mutableStateOf(initialViewport)
    var filePreview: FilePreview? by mutableStateOf(initialFilePreview)
    var previewProportion: Float by mutableStateOf(initialPreviewProportion)
}
