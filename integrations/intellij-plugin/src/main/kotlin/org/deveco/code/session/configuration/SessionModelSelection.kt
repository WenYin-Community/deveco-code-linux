package org.deveco.code.session.configuration

import org.deveco.code.session.model.ModelChoice
import org.deveco.code.session.model.ModelPreferenceResolver

internal data class ModelBackendWrite(val modelId: String, val manualReassert: Boolean)

internal data class ModelSelectionPlan(
    val selectedModelId: String?,
    val correctedInvalidPick: Boolean,
    val defaultGlobalModelId: String?,
    val storedPreferenceUpgradeTo: String?,
    val clearGlobalPreference: Boolean,
    val backendWrite: ModelBackendWrite?,
)

/**
 * Resolves which model a session should display without applying backend or
 * persistence side effects. A manual pick the controller still remembers wins
 * over both the backend's recomputed value and the global preference; when it
 * remembers nothing (the view state is memory-only and starts empty on reload)
 * the backend's model is the fallback. A pick that is no longer available, or
 * one that would replace a different visible selection, counts as invalid and
 * is corrected through the global/default path.
 */
internal fun planModelSelection(
    models: List<ModelChoice>,
    backendModelId: String?,
    rememberedModelId: String?,
    manuallySelected: Boolean,
    globalModelId: String?,
    globalConfigured: Boolean,
    catalogModelIds: Set<String>,
    catalogEverFed: Boolean,
    currentSelectedModelId: String? = null,
): ModelSelectionPlan {
    val defaultChoice = models.firstOrNull(::isDefaultModelChoice)
    if (manuallySelected) {
        // The remembered pick wins over the backend value; the backend is only
        // a fallback for a pick this controller no longer remembers. The guard
        // is shared by both so neither replaces a different visible selection.
        val found = rememberedModelId?.let { id -> models.firstOrNull { it.id == id } }
            ?: backendModelId?.let { id -> models.firstOrNull { it.id == id } }
        if (found != null && (currentSelectedModelId == null || found.id == currentSelectedModelId)) {
            return ModelSelectionPlan(
                selectedModelId = found.id,
                correctedInvalidPick = false,
                defaultGlobalModelId = null,
                storedPreferenceUpgradeTo = null,
                clearGlobalPreference = false,
                backendWrite = found.id
                    .takeIf { it != backendModelId }
                    ?.let { ModelBackendWrite(it, manualReassert = true) },
            )
        }
    }

    val defaultGlobalModelId = defaultChoice?.id?.takeIf {
        globalModelId == null && !globalConfigured
    }
    val effectiveGlobalModelId = globalModelId ?: defaultGlobalModelId
    val resolved = ModelPreferenceResolver.resolve(effectiveGlobalModelId, models, catalogModelIds)
    val stalePreference = effectiveGlobalModelId != null &&
        resolved.choice == null &&
        catalogEverFed &&
        !ModelPreferenceResolver.existsInCatalog(effectiveGlobalModelId, catalogModelIds)
    val selected = if (effectiveGlobalModelId == null) {
        backendModelId?.let { id -> models.firstOrNull { it.id == id } }
    } else {
        resolved.choice
            ?: defaultChoice
            ?: models.firstOrNull()
    }
    val correctedInvalidPick = manuallySelected
    return ModelSelectionPlan(
        selectedModelId = selected?.id,
        correctedInvalidPick = correctedInvalidPick,
        defaultGlobalModelId = defaultGlobalModelId,
        storedPreferenceUpgradeTo = resolved.upgradeTo,
        clearGlobalPreference = stalePreference,
        backendWrite = selected
            ?.takeIf { it.id != backendModelId }
            ?.let { ModelBackendWrite(it.id, manualReassert = false) },
    )
}

internal fun filterSessionModels(
    backendModels: List<ModelChoice>,
    connectedProviderIds: Set<String>,
    manualProviderIds: Set<String>,
    blacklistedModelIds: Set<String>,
): List<ModelChoice> {
    val filterProviders = connectedProviderIds.isNotEmpty() || manualProviderIds.isNotEmpty()
    return backendModels.filter { model ->
        val providerId = model.providerId.lowercase()
        val providerAllowed = !filterProviders ||
            providerId in connectedProviderIds ||
            providerId in manualProviderIds
        providerAllowed && model.id !in blacklistedModelIds
    }
}

private const val DEFAULT_MODEL_NAME = "GLM-5.3"

internal fun isDefaultModelChoice(choice: ModelChoice): Boolean {
    val normalized = choice.name.replace('\\', '/')
    val prefix = "deveco code/"
    return normalized.length > prefix.length &&
        normalized.substring(0, prefix.length).equals(prefix, ignoreCase = true) &&
        normalized.substring(prefix.length).equals(DEFAULT_MODEL_NAME, ignoreCase = true)
}
