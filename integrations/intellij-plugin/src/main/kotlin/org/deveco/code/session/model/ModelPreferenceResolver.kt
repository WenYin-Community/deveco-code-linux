package org.deveco.code.session.model

/**
 * Pure resolver for stored model preferences, extracted so the matching rules
 * are unit-testable independent of the 3000-line session controller.
 *
 * Two views are involved:
 * - `sessionModels` is ONE session's filtered list (connected providers,
 *   blacklist applied). It decides what that session displays and uses.
 * - `catalogIds` is the full catalog of "providerId/modelId" keys (connected
 *   providers plus manually added custom models). PERMANENT, global-level
 *   decisions — clearing the stored preference, pinning a legacy bare name to
 *   a qualified id — must be based on this view, never on one session's
 *   transient filtered list (a blacklisted or not-yet-refreshed provider
 *   would otherwise wipe or mis-pin a global preference).
 *
 * Inherent ambiguity of legacy bare values: a bare model name may itself
 * contain "/" (e.g. an openrouter aggregate id "anthropic/claude-x"), which
 * is indistinguishable from the qualified id of provider "anthropic" + model
 * "claude-x". Exact matching takes priority, so such a value resolves — and
 * upgrades — to the provider-prefixed interpretation. This cannot be
 * disambiguated after the fact; re-selecting the intended model rewrites the
 * stored value.
 */
internal object ModelPreferenceResolver {

    data class Result(
        /** Model to use in this session, from the session's filtered list. */
        val choice: ModelChoice?,
        /**
         * Qualified id a legacy bare name should be silently upgraded to:
         * set only when the name resolves to a choice in this session AND is
         * offered by exactly one provider across the FULL catalog. Null
         * otherwise (globally ambiguous, or nothing to upgrade).
         */
        val upgradeTo: String?,
    )

    fun resolve(stored: String?, sessionModels: List<ModelChoice>, catalogIds: Set<String>): Result {
        val value = stored?.trim()?.takeIf { it.isNotBlank() } ?: return Result(null, null)
        sessionModels.firstOrNull { it.id == value }?.let { return Result(it, null) }
        val byName = sessionModels.filter { it.modelId == value }
        if (byName.isEmpty()) return Result(null, null)
        // Global uniqueness from the full catalog: a name offered by several
        // providers anywhere must stay unpinned, even when this session's
        // filtered view happens to show only one of them.
        val globalMatches = catalogIds.filter { catalogModelId(it) == value }
        val upgradeTo = if (globalMatches.size == 1) globalMatches.first() else null
        return Result(byName.first(), upgradeTo)
    }

    /**
     * Whether a stored preference still exists in the FULL catalog — the gate
     * for expiry-clearing it. A session-filtered miss alone must NOT clear a
     * global preference.
     */
    fun existsInCatalog(stored: String?, catalogIds: Set<String>): Boolean {
        val value = stored?.trim()?.takeIf { it.isNotBlank() } ?: return false
        return catalogIds.contains(value) || catalogIds.any { catalogModelId(it) == value }
    }

    // Catalog keys are "providerId/modelId" with the provider id never
    // containing "/", so the model id is everything after the first slash —
    // it may itself contain slashes (openrouter-style aggregate ids).
    private fun catalogModelId(catalogId: String): String = catalogId.substringAfter('/')
}
