package org.deveco.code.session.ui.messages

// Normalizes a markdown fence info string for the 243 line, where Jewel
// 0.27.0 resolves languages through a closed 36-entry whitelist and a
// MimeType.displayName table with no TypeScript branch — even a whitelisted
// "typescript" fence ends up unhighlighted there. "javascript" is the only
// reachable JS-family highlighter (DevEco registers JavaScriptLanguage);
// the real ArkTS highlighter (ExtendTypeScript) is unreachable on this line.
internal fun normalizeFenceLanguage(raw: String?): String = when (raw?.lowercase()) {
    "ets", "arkts", "ts", "tsx", "typescript" -> "javascript"
    "html", "htm" -> "xml"
    else -> raw?.lowercase() ?: ""
}
