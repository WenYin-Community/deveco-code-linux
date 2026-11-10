package org.deveco.code.session.model

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

private const val DEFAULT_EFFORT_META_KEY = "defaultEffort"
private const val DEFAULT_EFFORT_ID = "default"

/** ACP forwards the model's cloud-declared default effort through the effort
 * option's existing `_meta` extension field; `currentValue` and `options`
 * keep their original protocol behavior. */
internal fun forwardedDefaultEffort(meta: JsonElement?): String? = (meta as? JsonObject)?.get(DEFAULT_EFFORT_META_KEY)
    ?.let { it as? JsonPrimitive }
    ?.takeIf { it.isString }
    ?.contentOrNull

/** The tier to write back to ACP, or null when there is nothing to change.
 *
 * Only ACP's fallback (`"default"`, the first tier, or a stale value) and a
 * brand-new session are replaced. A non-first tier restored from history was
 * an explicit choice — possibly made in another client such as the TUI — and
 * must not be silently overwritten with the cloud default.
 */
internal fun defaultEffortToApply(
    choices: List<String>,
    currentValue: String,
    forwarded: String?,
    isNewSession: Boolean = false,
): String? {
    if (forwarded == null || forwarded == currentValue) return null
    val current = currentValue.takeIf { it in choices }
    val isFallback = current == null || current == choices.firstOrNull() || currentValue == DEFAULT_EFFORT_ID
    if (!isNewSession && !isFallback) return null
    return forwarded.takeIf { it in choices }
}
