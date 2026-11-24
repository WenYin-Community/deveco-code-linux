package org.deveco.code.session.model.interaction

import com.agentclientprotocol.model.PermissionOptionKind

internal data class PermissionInteraction(
    val id: String,
    val state: InteractionState,
    val title: String,
    val message: String,
    val options: List<PermissionInteractionOption>,
    val selectedOptionId: String? = null,
    val activityId: String? = null,
    val subagentId: String? = null,
) {
    val selectedOption: PermissionInteractionOption?
        get() = selectedOptionId?.let { id -> options.firstOrNull { it.id == id } }
}

internal data class PermissionInteractionOption(val id: String, val label: String, val kind: PermissionOptionKind) {
    val isReject: Boolean
        get() = kind == PermissionOptionKind.REJECT_ONCE || kind == PermissionOptionKind.REJECT_ALWAYS
}
