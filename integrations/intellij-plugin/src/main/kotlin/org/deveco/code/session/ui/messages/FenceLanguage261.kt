package org.deveco.code.session.ui.messages

// Normalizes a markdown fence info string to a language name the bundled 261
// Jewel can resolve: its CodeFenceLanguageGuesser checks a built-in alias
// table and then registered Language IDs case-insensitively. DevEco registers
// ArkTS under the ID "ExtendTypeScript" (no ets/arkts alias exists) and ships
// no HTML language, so XML is the closest highlighter for HTML fences.
internal fun normalizeFenceLanguage(raw: String?): String = when (raw?.lowercase()) {
    "ets", "arkts" -> "extendtypescript"
    "ts", "tsx" -> "typescript"
    "html", "htm" -> "xml"
    "json5" -> "json"
    else -> raw?.lowercase() ?: ""
}
