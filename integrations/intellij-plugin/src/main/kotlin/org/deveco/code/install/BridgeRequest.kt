package org.deveco.code.install

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/** One payload entry handed over by DevEco Studio: inline text, or a path whose content to inline. */
internal data class BridgeContext(val type: String, val text: String)

/** Which conversation a bridge delivery lands in. */
internal sealed interface SessionTarget {
    /** Always create a conversation, ignoring whichever one the chat tab currently shows. */
    data object New : SessionTarget

    /** Reuse the open chat tab while it is still blank, otherwise create a conversation. */
    data object BlankOrNew : SessionTarget

    /** Reuse the open chat tab only while it is still blank; do nothing otherwise. */
    data object BlankOnly : SessionTarget

    /** Use the open chat tab even when it already holds a conversation. */
    data object Current : SessionTarget
}

/**
 * How the contexts are led in. Three states, because "the caller said nothing" and "the caller
 * asked for no lead-in" have to stay distinguishable: the former keeps the localized compile-error
 * prompt that existing callers rely on.
 */
internal sealed interface PromptLeadIn {
    data object Default : PromptLeadIn
    data object None : PromptLeadIn
    data class Text(val value: String) : PromptLeadIn
}

internal data class BridgeRequest(
    val contexts: List<BridgeContext>,
    val promptPrefix: PromptLeadIn,
    /** Mode to put the conversation in before sending; null leaves its mode untouched. */
    val mode: String?,
    val session: SessionTarget,
    /** False parks the prompt in the composer instead of sending it. */
    val sendImmediately: Boolean,
)

/**
 * Parses the payload DevEco Studio hands to [DevEcoCodeBridge]. Two shapes are accepted: the
 * original bare array of contexts, and an object that wraps it in `contexts` and adds an `options`
 * block. Every option is optional, so existing callers keep working unchanged: the bare array form
 * resolves to build mode, the default lead-in and an immediate send.
 *
 * `prompt` and `mode` share one convention — an absent key takes the default, an explicit `null`
 * opts out of it. Kept free of i18n and of IntelliJ services so it stays unit-testable; the
 * localized lead-in is resolved by the caller.
 */
internal object BridgeRequestParser {
    /**
     * What an unspecified `mode` resolves to. It is the mode this entry point needs rather than a
     * claim about the backend: the agent a freshly created conversation is born in is the
     * directory's `defaultModeID`, which follows the user's `default_agent` config when set.
     */
    private const val DEFAULT_MODE = "build"

    fun parse(raw: String): BridgeRequest? = runCatching { parseOrThrow(raw) }.getOrNull()

    private fun parseOrThrow(raw: String): BridgeRequest? {
        val element = Json.parseToJsonElement(raw)
        val contexts = contextsOf(element)
        if (contexts.isEmpty()) return null
        val options = (element as? JsonObject)?.get("options") as? JsonObject
        return BridgeRequest(
            contexts = contexts,
            promptPrefix = leadInOf(options),
            // This entry point exists to fix compile errors, so an unspecified mode means build;
            // a caller that wants the conversation's own mode says so with an explicit null.
            mode = options.stringOrDefault("mode", DEFAULT_MODE),
            session = targetOf(options.string("session")),
            sendImmediately = options.flag("send") ?: true,
        )
    }

    private fun leadInOf(options: JsonObject?): PromptLeadIn {
        if (!options.has("prompt")) return PromptLeadIn.Default
        return options.string("prompt")?.let { PromptLeadIn.Text(it) } ?: PromptLeadIn.None
    }

    private fun contextsOf(element: JsonElement): List<BridgeContext> {
        val array = when (element) {
            is JsonArray -> element
            is JsonObject -> element["contexts"] as? JsonArray
            else -> null
        } ?: return emptyList()
        return array.mapNotNull { item ->
            val obj = item as? JsonObject ?: return@mapNotNull null
            val type = obj.string("type")?.uppercase() ?: return@mapNotNull null
            val text = obj.string("text") ?: return@mapNotNull null
            BridgeContext(type, text)
        }
    }

    private fun targetOf(raw: String?): SessionTarget = when (raw?.trim()?.uppercase()) {
        "NEW" -> SessionTarget.New

        "BLANK_ONLY" -> SessionTarget.BlankOnly

        "CURRENT" -> SessionTarget.Current

        // Covers BLANK_OR_NEW, an absent key and anything unrecognized: the historical behaviour.
        else -> SessionTarget.BlankOrNew
    }

    private fun JsonObject?.string(key: String): String? =
        this?.get(key)?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }

    /** Absent key → [default]; an explicit `null` or blank → null, i.e. the caller opted out. */
    private fun JsonObject?.stringOrDefault(key: String, default: String): String? =
        if (has(key)) string(key) else default

    private fun JsonObject?.flag(key: String): Boolean? = this?.get(key)?.jsonPrimitive?.booleanOrNull

    private fun JsonObject?.has(key: String): Boolean = this?.containsKey(key) == true
}
