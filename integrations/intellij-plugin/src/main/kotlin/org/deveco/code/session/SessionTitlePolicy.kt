package org.deveco.code.session

private val DEFAULT_TITLE = Regex(
    "(?i)new session(?:\\s*-\\s*\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})?",
)

/**
 * Defines when a DevEco Code placeholder title should be treated as untitled,
 * so the first user prompt can replace it. Ported from DevEcoGenie's
 * `SessionTitlePolicy`: matches both bare "New session" and the timestamped
 * "New session - yyyy-MM-dd HH:mm:ss" placeholder DevEco Code emits.
 */
internal object SessionTitlePolicy {
    fun isUntitled(title: String?): Boolean = title.isNullOrBlank() || DEFAULT_TITLE.matches(title.trim())

    fun fromFirstPrompt(text: String): String {
        val normalized = text.trim().replace(Regex("\\s+"), " ")
        return if (normalized.isEmpty()) "New Session" else normalized
    }
}
