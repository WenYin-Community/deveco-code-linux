package org.deveco.code.acp

/**
 * Data types for ACP elicitation (structured user questions from the agent).
 *
 * The agent sends a `question.asked` event which the server translates into an
 * ACP `unstable_createElicitation` request. The client displays a dialog,
 * collects the user's answer, and returns it via the elicitation response.
 */
internal data class ElicitationRequest(val sessionId: String, val title: String, val fields: List<ElicitationField>)

internal data class ElicitationField(
    val key: String,
    val title: String,
    val question: String,
    val options: List<ElicitationOption>,
    val multiple: Boolean,
    val required: Boolean,
    val allowCustom: Boolean,
)

internal data class ElicitationOption(val value: String, val label: String, val description: String? = null)

internal data class ElicitationResponse(val answers: Map<String, List<String>>, val accepted: Boolean)
