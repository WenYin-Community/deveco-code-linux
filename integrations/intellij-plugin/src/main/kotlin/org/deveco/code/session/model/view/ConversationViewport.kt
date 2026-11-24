package org.deveco.code.session.model.view

internal enum class ConversationLayoutMode {
    TOP,
    BOTTOM_LOCKED,
}

internal data class ConversationViewport(
    val firstVisibleRowKey: String? = null,
    val firstVisibleRowOffset: Int = 0,
    val followTail: Boolean = true,
    val layoutMode: ConversationLayoutMode = ConversationLayoutMode.TOP,
)
